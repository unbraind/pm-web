import { Router } from "express";
import { pool } from "../db.ts";
import { requireAuth, type AuthRequest } from "../middleware/auth.ts";
import { verifyProjectAccess } from "./projects.ts";
import { runPm } from "../services/pm-runner.ts";
import { decryptSecret } from "../crypto.ts";
import { routeParam } from "./route-params.ts";

const router = Router({ mergeParams: true });
router.use(requireAuth);

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  html_url: string;
  created_at: string;
}

async function getGitHubToken(userId: string): Promise<string | null> {
  const result = await pool.query(`SELECT github_token FROM pm_users WHERE id = $1`, [userId]);
  return decryptSecret(result.rows[0]?.github_token || null);
}

/**
 * `fetch` wrapper that authenticates to the GitHub REST API.
 *
 * Merges the caller's request options with the headers pm-web must send on
 * every GitHub call: a `Bearer` token, the JSON-plus preview `Accept`, the
 * pinned API version, and a `User-Agent`. Returns the raw `Response` so the
 * caller can inspect status and body.
 *
 * @param url - The GitHub API endpoint URL.
 * @param token - The user's decrypted GitHub access token.
 * @param opts - Extra `fetch` options; caller headers are preserved.
 * @returns The GitHub API response.
 */
async function ghFetch(url: string, token: string, opts: RequestInit = {}): Promise<Response> {
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

/** The only `state` values the GitHub issues API accepts. */
const GITHUB_ISSUE_STATES = new Set(["open", "closed", "all"]);

/**
 * Build the GitHub issues-list URL for a linked repo from untrusted query
 * parameters, without interpolating any of them into the URL string.
 *
 * `owner` and `repo` come from the database (they were already validated
 * against the user's token when linked), but `state`, `per_page` and `page`
 * come straight from the request query, so interpolating them raw — as the
 * previous template literal did — let a caller inject extra query components
 * or path segments into the `api.github.com` request (the SSRF CodeQL
 * flagged). This constructs the URL with `URL`/`URLSearchParams`, which encode
 * every value, whitelists `state`, and clamps `per_page`/`page` to safe integer
 * ranges, so the request can only ever target the one issues endpoint.
 *
 * @param owner - The linked repository owner (from the database).
 * @param repo - The linked repository name (from the database).
 * @param query - The incoming request's query object.
 * @returns The canonical `https://api.github.com/repos/.../issues?...` URL.
 */
export function buildGitHubIssuesUrl(
  owner: string,
  repo: string,
  query: Record<string, unknown> | undefined,
): string {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
  );
  const params = url.searchParams;
  const rawState = typeof query?.["state"] === "string" ? query["state"] : "open";
  params.set("state", GITHUB_ISSUE_STATES.has(rawState) ? rawState : "open");
  params.set("per_page", String(boundedNumber(query?.["per_page"], 30, 1, 100)));
  params.set("page", String(boundedNumber(query?.["page"], 1, 1, 1000)));
  params.set("pulls", "false");
  return url.href;
}

/**
 * Coerce an untrusted query value into a finite, clamped integer.
 *
 * Non-numeric, missing or out-of-range values fall back to the supplied
 * default, so a caller cannot smuggle `NaN` or a huge number into the URL.
 *
 * @param raw - The raw query value (string, number or undefined).
 * @param fallback - Value used when `raw` is not a usable number.
 * @param min - Inclusive lower bound applied after parsing.
 * @param max - Inclusive upper bound applied after parsing.
 * @returns An integer in `[min, max]`.
 */
function boundedNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// GET /api/projects/:id/github — get linked repo info
router.get("/", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await pool.query(
    `SELECT github_owner, github_repo, github_sync_enabled FROM pm_projects WHERE id = $1`,
    [routeParam(req, "id")]
  );
  const row = result.rows[0] as { github_owner: string | null; github_repo: string | null; github_sync_enabled: boolean };
  res.json({
    owner: row.github_owner,
    repo: row.github_repo,
    syncEnabled: row.github_sync_enabled,
    linked: !!(row.github_owner && row.github_repo),
  });
});

// PATCH /api/projects/:id/github — link or unlink a repo
router.patch("/", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access || access.permission !== "edit") { res.status(403).json({ error: "Not authorized" }); return; }

  const { owner, repo, syncEnabled } = req.body as { owner?: string; repo?: string; syncEnabled?: boolean };

  try {
    if (owner && repo) {
      // Validate the repo is accessible with the user's token
      const token = await getGitHubToken(req.user!.userId);
      if (!token) { res.status(400).json({ error: "No GitHub token configured. Add one in Settings." }); return; }

      const resp = await ghFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
      if (!resp.ok) { res.status(400).json({ error: `GitHub repo not found or not accessible: ${owner}/${repo}` }); return; }
    }

    await pool.query(
      `UPDATE pm_projects SET github_owner = $1, github_repo = $2, github_sync_enabled = $3 WHERE id = $4`,
      [owner?.trim() || null, repo?.trim() || null, syncEnabled ?? false, routeParam(req, "id")]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("GitHub link error:", err);
    res.status(500).json({ error: "Failed to link GitHub repository" });
  }
});

// GET /api/projects/:id/github/issues — list GitHub issues
router.get("/issues", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access) { res.status(404).json({ error: "Project not found" }); return; }

  const repoResult = await pool.query(
    `SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`,
    [routeParam(req, "id")]
  );
  const { github_owner: owner, github_repo: repo } = repoResult.rows[0] as { github_owner: string | null; github_repo: string | null };
  if (!owner || !repo) { res.status(400).json({ error: "No GitHub repo linked to this project" }); return; }

  const token = await getGitHubToken(access.ownerUserId);
  if (!token) { res.status(400).json({ error: "No GitHub token configured" }); return; }

  try {
    const resp = await ghFetch(
      buildGitHubIssuesUrl(owner, repo, req.query),
      token
    );
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { message?: string };
      res.status(resp.status).json({ error: body.message || "GitHub API error" });
      return;
    }
    const issues = (await resp.json()) as GitHubIssue[];
    // Filter out pull requests (GitHub issues API returns PRs too)
    res.json({ issues: issues.filter(i => !("pull_request" in i)) });
  } catch (err) {
    console.error("GitHub issues error:", err);
    res.status(500).json({ error: "Failed to fetch GitHub issues" });
  }
});

// POST /api/projects/:id/github/import — import selected GitHub issues as pm items
router.post("/import", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access || access.permission !== "edit") { res.status(403).json({ error: "Not authorized" }); return; }

  const repoResult = await pool.query(
    `SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`,
    [routeParam(req, "id")]
  );
  const { github_owner: owner, github_repo: repo } = repoResult.rows[0] as { github_owner: string | null; github_repo: string | null };
  if (!owner || !repo) { res.status(400).json({ error: "No GitHub repo linked" }); return; }

  const token = await getGitHubToken(access.ownerUserId);
  if (!token) { res.status(400).json({ error: "No GitHub token configured" }); return; }

  const { issueNumbers } = req.body as { issueNumbers?: number[] };
  if (!issueNumbers || issueNumbers.length === 0) { res.status(400).json({ error: "No issue numbers provided" }); return; }
  if (issueNumbers.length > 50) { res.status(400).json({ error: "Cannot import more than 50 issues at once" }); return; }

  const created: string[] = [];
  const errors: string[] = [];

  for (const num of issueNumbers) {
    try {
      const resp = await ghFetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}`,
        token
      );
      if (!resp.ok) { errors.push(`#${num}: not found`); continue; }
      const issue = (await resp.json()) as GitHubIssue;

      const tags = issue.labels.map(l => l.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")).filter(Boolean).join(",");
      const body = `GitHub: ${owner}/${repo}#${num}\nURL: ${issue.html_url}\n\n${issue.body || ""}`.trim();
      const type = issue.labels.some(l => l.name.toLowerCase().includes("bug")) ? "Bug" : "Issue";

      const args = [
        "create",
        "--title", issue.title,
        "--type", type,
        "--body", body,
      ];
      if (tags) args.push("--tags", tags);
      if (issue.assignee) args.push("--assignee", issue.assignee.login);

      const result = await runPm({ args, userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
      if (result.ok && result.parsed) {
        // `pm create --json` (and the in-process SDK dispatcher) return the flat
        // envelope { id, status, changed_field_count } — no `item` wrapper.
        const parsed = result.parsed as { id?: string };
        created.push(parsed.id || `#${num}`);
      } else {
        errors.push(`#${num}: ${result.stderr || "create failed"}`);
      }
    } catch (err) {
      errors.push(`#${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  res.json({ created, errors, total: issueNumbers.length });
});

// GET /api/projects/:id/github/links — fetch pm-item ↔ GitHub-issue links
router.get("/links", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await pool.query(
    `SELECT pm_item_id, issue_number, issue_url, synced_at FROM pm_github_item_links WHERE project_id = $1 ORDER BY synced_at DESC`,
    [routeParam(req, "id")]
  );
  res.json({ links: result.rows as { pm_item_id: string; issue_number: number; issue_url: string; synced_at: string }[] });
});

// POST /api/projects/:id/github/push — push pm items as new GitHub issues
router.post("/push", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access || access.permission !== "edit") { res.status(403).json({ error: "Not authorized" }); return; }

  const repoResult = await pool.query(
    `SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`,
    [routeParam(req, "id")]
  );
  const { github_owner: owner, github_repo: repo } = repoResult.rows[0] as { github_owner: string | null; github_repo: string | null };
  if (!owner || !repo) { res.status(400).json({ error: "No GitHub repo linked to this project" }); return; }

  const token = await getGitHubToken(access.ownerUserId);
  if (!token) { res.status(400).json({ error: "No GitHub token configured" }); return; }

  const { itemIds } = req.body as { itemIds?: string[] };
  if (!itemIds || itemIds.length === 0) { res.status(400).json({ error: "itemIds array is required" }); return; }
  if (itemIds.length > 50) { res.status(400).json({ error: "Cannot push more than 50 items at once" }); return; }

  const pushed: Array<{ pmItemId: string; issueNumber: number; issueUrl: string }> = [];
  const errors: string[] = [];

  for (const itemId of itemIds) {
    try {
      const getResult = await runPm({ args: ["get", itemId, "--json"], userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
      if (!getResult.ok || !getResult.parsed) { errors.push(`${itemId}: item not found`); continue; }
      const item = (getResult.parsed as { item?: Record<string, unknown> }).item;
      if (!item) { errors.push(`${itemId}: item not found`); continue; }

      const title = String(item["title"] || itemId);
      const status = String(item["status"] || "open");
      const description = String(item["description"] || "");
      const tags = Array.isArray(item["tags"]) ? (item["tags"] as string[]) : [];
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

      const issuePayload: Record<string, unknown> = { title, body: issueBody };
      if (labels.length > 0) issuePayload["labels"] = labels;
      if (assignee) issuePayload["assignees"] = [assignee];

      const resp = await ghFetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        token,
        { method: "POST", body: JSON.stringify(issuePayload), headers: { "Content-Type": "application/json" } }
      );

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({})) as { message?: string };
        errors.push(`${itemId}: ${errBody.message || `GitHub API error ${resp.status}`}`);
        continue;
      }

      const issue = (await resp.json()) as { number: number; html_url: string; state: string };

      if (ghState === "closed") {
        await ghFetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue.number}`,
          token,
          { method: "PATCH", body: JSON.stringify({ state: "closed" }), headers: { "Content-Type": "application/json" } }
        ).catch(() => undefined);
      }

      await pool.query(
        `INSERT INTO pm_github_item_links (project_id, pm_item_id, issue_number, issue_url, synced_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (project_id, pm_item_id) DO UPDATE SET issue_number = EXCLUDED.issue_number, issue_url = EXCLUDED.issue_url, synced_at = NOW()`,
        [routeParam(req, "id"), itemId, issue.number, issue.html_url]
      );

      pushed.push({ pmItemId: itemId, issueNumber: issue.number, issueUrl: issue.html_url });
    } catch (err) {
      errors.push(`${itemId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  res.json({ pushed, errors, total: itemIds.length });
});

// PATCH /api/projects/:id/github/push/:itemId — update an existing linked GitHub issue from pm item
router.patch("/push/:itemId", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, routeParam(req, "id"));
  if (!access || access.permission !== "edit") { res.status(403).json({ error: "Not authorized" }); return; }

  const itemId = routeParam(req, "itemId");
  const linkResult = await pool.query(
    `SELECT issue_number FROM pm_github_item_links WHERE project_id = $1 AND pm_item_id = $2`,
    [routeParam(req, "id"), itemId]
  );
  if (linkResult.rows.length === 0) { res.status(404).json({ error: "No linked GitHub issue for this item" }); return; }
  const issueNumber = linkResult.rows[0].issue_number as number;

  const repoResult = await pool.query(`SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`, [routeParam(req, "id")]);
  const { github_owner: owner, github_repo: repo } = repoResult.rows[0] as { github_owner: string | null; github_repo: string | null };
  if (!owner || !repo) { res.status(400).json({ error: "No GitHub repo linked" }); return; }

  const token = await getGitHubToken(access.ownerUserId);
  if (!token) { res.status(400).json({ error: "No GitHub token configured" }); return; }

  const getResult = await runPm({ args: ["get", itemId, "--json"], userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
  if (!getResult.ok || !getResult.parsed) { res.status(404).json({ error: "Item not found" }); return; }
  const item = (getResult.parsed as { item?: Record<string, unknown> }).item;
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }

  const title = String(item["title"] || itemId);
  const status = String(item["status"] || "open");
  const description = String(item["description"] || "");
  const tags = Array.isArray(item["tags"]) ? (item["tags"] as string[]) : [];
  const ghState = status === "closed" || status === "canceled" ? "closed" : "open";

  const bodyLines = [
    `**pm item:** \`${itemId}\``,
    `**type:** ${String(item["type"] || "Task")}`,
    `**status:** ${status}`,
    `**priority:** ${String(item["priority"] || "3")}`,
    "",
    description || "_No description_",
  ];

  const updatePayload: Record<string, unknown> = { title, body: bodyLines.join("\n"), state: ghState };
  if (tags.length > 0) updatePayload["labels"] = tags.filter(Boolean);

  const resp = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
    { method: "PATCH", body: JSON.stringify(updatePayload), headers: { "Content-Type": "application/json" } }
  );

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({})) as { message?: string };
    res.status(resp.status).json({ error: errBody.message || `GitHub API error ${resp.status}` });
    return;
  }

  const issue = (await resp.json()) as { number: number; html_url: string };
  await pool.query(
    `UPDATE pm_github_item_links SET synced_at = NOW() WHERE project_id = $1 AND pm_item_id = $2`,
    [routeParam(req, "id"), itemId]
  );

  res.json({ ok: true, issueNumber: issue.number, issueUrl: issue.html_url });
});

// GET /api/projects/:id/github/repo-info — validate and get repo metadata
router.get("/repo-info", async (req: AuthRequest, res) => {
  const { owner, repo } = req.query as { owner?: string; repo?: string };
  if (!owner || !repo) { res.status(400).json({ error: "owner and repo are required" }); return; }

  const token = await getGitHubToken(req.user!.userId);
  if (!token) { res.status(400).json({ error: "No GitHub token configured" }); return; }

  try {
    const resp = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      token
    );
    if (!resp.ok) { res.status(resp.status).json({ error: `Repo not found: ${owner}/${repo}` }); return; }
    const data = await resp.json() as { full_name: string; description: string | null; private: boolean; open_issues_count: number };
    res.json({ name: data.full_name, description: data.description, private: data.private, openIssues: data.open_issues_count });
  } catch (err) {
    console.error("Repo info error:", err);
    res.status(500).json({ error: "Failed to fetch repo info" });
  }
});

export { router as githubRouter };
