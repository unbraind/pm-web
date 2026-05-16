import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { verifyProjectAccess } from "./projects.js";
import { runPm } from "../services/pm-runner.js";
import { decryptSecret } from "../crypto.js";
const router = Router({ mergeParams: true });
router.use(requireAuth);
async function getGitHubToken(userId) {
    const result = await pool.query(`SELECT github_token FROM pm_users WHERE id = $1`, [userId]);
    return decryptSecret(result.rows[0]?.github_token || null);
}
async function ghFetch(url, token, opts = {}) {
    return fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pm-web/1.0",
            ...opts.headers,
        },
    });
}
// GET /api/projects/:id/github — get linked repo info
router.get("/", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access) {
        res.status(404).json({ error: "Project not found" });
        return;
    }
    const result = await pool.query(`SELECT github_owner, github_repo, github_sync_enabled FROM pm_projects WHERE id = $1`, [req.params["id"]]);
    const row = result.rows[0];
    res.json({
        owner: row.github_owner,
        repo: row.github_repo,
        syncEnabled: row.github_sync_enabled,
        linked: !!(row.github_owner && row.github_repo),
    });
});
// PATCH /api/projects/:id/github — link or unlink a repo
router.patch("/", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access || access.permission !== "edit") {
        res.status(403).json({ error: "Not authorized" });
        return;
    }
    const { owner, repo, syncEnabled } = req.body;
    try {
        if (owner && repo) {
            // Validate the repo is accessible with the user's token
            const token = await getGitHubToken(req.user.userId);
            if (!token) {
                res.status(400).json({ error: "No GitHub token configured. Add one in Settings." });
                return;
            }
            const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
            if (!resp.ok) {
                res.status(400).json({ error: `GitHub repo not found or not accessible: ${owner}/${repo}` });
                return;
            }
        }
        await pool.query(`UPDATE pm_projects SET github_owner = $1, github_repo = $2, github_sync_enabled = $3 WHERE id = $4`, [owner?.trim() || null, repo?.trim() || null, syncEnabled ?? false, req.params["id"]]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error("GitHub link error:", err);
        res.status(500).json({ error: "Failed to link GitHub repository" });
    }
});
// GET /api/projects/:id/github/issues — list GitHub issues
router.get("/issues", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access) {
        res.status(404).json({ error: "Project not found" });
        return;
    }
    const repoResult = await pool.query(`SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`, [req.params["id"]]);
    const { github_owner: owner, github_repo: repo } = repoResult.rows[0];
    if (!owner || !repo) {
        res.status(400).json({ error: "No GitHub repo linked to this project" });
        return;
    }
    const token = await getGitHubToken(access.ownerUserId);
    if (!token) {
        res.status(400).json({ error: "No GitHub token configured" });
        return;
    }
    try {
        const state = req.query["state"] || "open";
        const perPage = Math.min(parseInt(req.query["per_page"] || "30", 10), 100);
        const page = parseInt(req.query["page"] || "1", 10);
        const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=${perPage}&page=${page}&pulls=false`, token);
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            res.status(resp.status).json({ error: body.message || "GitHub API error" });
            return;
        }
        const issues = (await resp.json());
        // Filter out pull requests (GitHub issues API returns PRs too)
        res.json({ issues: issues.filter(i => !("pull_request" in i)) });
    }
    catch (err) {
        console.error("GitHub issues error:", err);
        res.status(500).json({ error: "Failed to fetch GitHub issues" });
    }
});
// POST /api/projects/:id/github/import — import selected GitHub issues as pm items
router.post("/import", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access || access.permission !== "edit") {
        res.status(403).json({ error: "Not authorized" });
        return;
    }
    const repoResult = await pool.query(`SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`, [req.params["id"]]);
    const { github_owner: owner, github_repo: repo } = repoResult.rows[0];
    if (!owner || !repo) {
        res.status(400).json({ error: "No GitHub repo linked" });
        return;
    }
    const token = await getGitHubToken(access.ownerUserId);
    if (!token) {
        res.status(400).json({ error: "No GitHub token configured" });
        return;
    }
    const { issueNumbers } = req.body;
    if (!issueNumbers || issueNumbers.length === 0) {
        res.status(400).json({ error: "No issue numbers provided" });
        return;
    }
    if (issueNumbers.length > 50) {
        res.status(400).json({ error: "Cannot import more than 50 issues at once" });
        return;
    }
    const created = [];
    const errors = [];
    for (const num of issueNumbers) {
        try {
            const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}`, token);
            if (!resp.ok) {
                errors.push(`#${num}: not found`);
                continue;
            }
            const issue = (await resp.json());
            const tags = issue.labels.map(l => l.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")).filter(Boolean).join(",");
            const body = `GitHub: ${owner}/${repo}#${num}\nURL: ${issue.html_url}\n\n${issue.body || ""}`.trim();
            const type = issue.labels.some(l => l.name.toLowerCase().includes("bug")) ? "Bug" : "Issue";
            const args = [
                "create",
                "--title", issue.title,
                "--type", type,
                "--body", body,
            ];
            if (tags)
                args.push("--tags", tags);
            if (issue.assignee)
                args.push("--assignee", issue.assignee.login);
            const result = runPm({ args, userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
            if (result.ok && result.parsed) {
                const parsed = result.parsed;
                created.push(parsed.item?.id || `#${num}`);
            }
            else {
                errors.push(`#${num}: ${result.stderr || "create failed"}`);
            }
        }
        catch (err) {
            errors.push(`#${num}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    res.json({ created, errors, total: issueNumbers.length });
});
// GET /api/projects/:id/github/links — fetch pm-item ↔ GitHub-issue links
router.get("/links", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access) {
        res.status(404).json({ error: "Project not found" });
        return;
    }
    const result = await pool.query(`SELECT pm_item_id, issue_number, issue_url, synced_at FROM pm_github_item_links WHERE project_id = $1 ORDER BY synced_at DESC`, [req.params["id"]]);
    res.json({ links: result.rows });
});
// POST /api/projects/:id/github/push — push pm items as new GitHub issues
router.post("/push", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access || access.permission !== "edit") {
        res.status(403).json({ error: "Not authorized" });
        return;
    }
    const repoResult = await pool.query(`SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`, [req.params["id"]]);
    const { github_owner: owner, github_repo: repo } = repoResult.rows[0];
    if (!owner || !repo) {
        res.status(400).json({ error: "No GitHub repo linked to this project" });
        return;
    }
    const token = await getGitHubToken(access.ownerUserId);
    if (!token) {
        res.status(400).json({ error: "No GitHub token configured" });
        return;
    }
    const { itemIds } = req.body;
    if (!itemIds || itemIds.length === 0) {
        res.status(400).json({ error: "itemIds array is required" });
        return;
    }
    if (itemIds.length > 50) {
        res.status(400).json({ error: "Cannot push more than 50 items at once" });
        return;
    }
    const pushed = [];
    const errors = [];
    for (const itemId of itemIds) {
        try {
            const getResult = runPm({ args: ["get", itemId, "--json"], userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
            if (!getResult.ok || !getResult.parsed) {
                errors.push(`${itemId}: item not found`);
                continue;
            }
            const item = getResult.parsed.item;
            if (!item) {
                errors.push(`${itemId}: item not found`);
                continue;
            }
            const title = String(item["title"] || itemId);
            const status = String(item["status"] || "open");
            const description = String(item["description"] || "");
            const tags = Array.isArray(item["tags"]) ? item["tags"] : [];
            const assignee = item["assignee"] ? String(item["assignee"]) : null;
            const bodyLines = [
                `**pm item:** \`${itemId}\``,
                `**type:** ${String(item["type"] || "Task")}`,
                `**status:** ${status}`,
                `**priority:** ${String(item["priority"] || "3")}`,
                "",
                description || "_No description_",
            ];
            const issueBody = bodyLines.join("\n");
            const labels = tags.filter(Boolean);
            const ghState = status === "closed" || status === "canceled" ? "closed" : "open";
            const issuePayload = { title, body: issueBody };
            if (labels.length > 0)
                issuePayload["labels"] = labels;
            if (assignee)
                issuePayload["assignees"] = [assignee];
            const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, token, { method: "POST", body: JSON.stringify(issuePayload), headers: { "Content-Type": "application/json" } });
            if (!resp.ok) {
                const errBody = await resp.json().catch(() => ({}));
                errors.push(`${itemId}: ${errBody.message || `GitHub API error ${resp.status}`}`);
                continue;
            }
            const issue = (await resp.json());
            if (ghState === "closed") {
                await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue.number}`, token, { method: "PATCH", body: JSON.stringify({ state: "closed" }), headers: { "Content-Type": "application/json" } }).catch(() => undefined);
            }
            await pool.query(`INSERT INTO pm_github_item_links (project_id, pm_item_id, issue_number, issue_url, synced_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (project_id, pm_item_id) DO UPDATE SET issue_number = EXCLUDED.issue_number, issue_url = EXCLUDED.issue_url, synced_at = NOW()`, [req.params["id"], itemId, issue.number, issue.html_url]);
            pushed.push({ pmItemId: itemId, issueNumber: issue.number, issueUrl: issue.html_url });
        }
        catch (err) {
            errors.push(`${itemId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    res.json({ pushed, errors, total: itemIds.length });
});
// PATCH /api/projects/:id/github/push/:itemId — update an existing linked GitHub issue from pm item
router.patch("/push/:itemId", async (req, res) => {
    const access = await verifyProjectAccess(req.user.userId, req.params["id"]);
    if (!access || access.permission !== "edit") {
        res.status(403).json({ error: "Not authorized" });
        return;
    }
    const itemId = req.params["itemId"];
    const linkResult = await pool.query(`SELECT issue_number FROM pm_github_item_links WHERE project_id = $1 AND pm_item_id = $2`, [req.params["id"], itemId]);
    if (linkResult.rows.length === 0) {
        res.status(404).json({ error: "No linked GitHub issue for this item" });
        return;
    }
    const issueNumber = linkResult.rows[0].issue_number;
    const repoResult = await pool.query(`SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`, [req.params["id"]]);
    const { github_owner: owner, github_repo: repo } = repoResult.rows[0];
    if (!owner || !repo) {
        res.status(400).json({ error: "No GitHub repo linked" });
        return;
    }
    const token = await getGitHubToken(access.ownerUserId);
    if (!token) {
        res.status(400).json({ error: "No GitHub token configured" });
        return;
    }
    const getResult = runPm({ args: ["get", itemId, "--json"], userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
    if (!getResult.ok || !getResult.parsed) {
        res.status(404).json({ error: "Item not found" });
        return;
    }
    const item = getResult.parsed.item;
    if (!item) {
        res.status(404).json({ error: "Item not found" });
        return;
    }
    const title = String(item["title"] || itemId);
    const status = String(item["status"] || "open");
    const description = String(item["description"] || "");
    const tags = Array.isArray(item["tags"]) ? item["tags"] : [];
    const ghState = status === "closed" || status === "canceled" ? "closed" : "open";
    const bodyLines = [
        `**pm item:** \`${itemId}\``,
        `**type:** ${String(item["type"] || "Task")}`,
        `**status:** ${status}`,
        `**priority:** ${String(item["priority"] || "3")}`,
        "",
        description || "_No description_",
    ];
    const updatePayload = { title, body: bodyLines.join("\n"), state: ghState };
    if (tags.length > 0)
        updatePayload["labels"] = tags.filter(Boolean);
    const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`, token, { method: "PATCH", body: JSON.stringify(updatePayload), headers: { "Content-Type": "application/json" } });
    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        res.status(resp.status).json({ error: errBody.message || `GitHub API error ${resp.status}` });
        return;
    }
    const issue = (await resp.json());
    await pool.query(`UPDATE pm_github_item_links SET synced_at = NOW() WHERE project_id = $1 AND pm_item_id = $2`, [req.params["id"], itemId]);
    res.json({ ok: true, issueNumber: issue.number, issueUrl: issue.html_url });
});
// GET /api/projects/:id/github/repo-info — validate and get repo metadata
router.get("/repo-info", async (req, res) => {
    const { owner, repo } = req.query;
    if (!owner || !repo) {
        res.status(400).json({ error: "owner and repo are required" });
        return;
    }
    const token = await getGitHubToken(req.user.userId);
    if (!token) {
        res.status(400).json({ error: "No GitHub token configured" });
        return;
    }
    try {
        const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
        if (!resp.ok) {
            res.status(resp.status).json({ error: `Repo not found: ${owner}/${repo}` });
            return;
        }
        const data = await resp.json();
        res.json({ name: data.full_name, description: data.description, private: data.private, openIssues: data.open_issues_count });
    }
    catch (err) {
        console.error("Repo info error:", err);
        res.status(500).json({ error: "Failed to fetch repo info" });
    }
});
export { router as githubRouter };
//# sourceMappingURL=github.js.map