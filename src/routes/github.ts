import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { verifyProjectAccess } from "./projects.js";
import { runPm } from "../services/pm-runner.js";

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
  return result.rows[0]?.github_token || null;
}

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

// GET /api/projects/:id/github — get linked repo info
router.get("/", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, req.params["id"]!);
  if (!access) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await pool.query(
    `SELECT github_owner, github_repo, github_sync_enabled FROM pm_projects WHERE id = $1`,
    [req.params["id"]]
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
  const access = await verifyProjectAccess(req.user!.userId, req.params["id"]!);
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
      [owner?.trim() || null, repo?.trim() || null, syncEnabled ?? false, req.params["id"]]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("GitHub link error:", err);
    res.status(500).json({ error: "Failed to link GitHub repository" });
  }
});

// GET /api/projects/:id/github/issues — list GitHub issues
router.get("/issues", async (req: AuthRequest, res) => {
  const access = await verifyProjectAccess(req.user!.userId, req.params["id"]!);
  if (!access) { res.status(404).json({ error: "Project not found" }); return; }

  const repoResult = await pool.query(
    `SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`,
    [req.params["id"]]
  );
  const { github_owner: owner, github_repo: repo } = repoResult.rows[0] as { github_owner: string | null; github_repo: string | null };
  if (!owner || !repo) { res.status(400).json({ error: "No GitHub repo linked to this project" }); return; }

  const token = await getGitHubToken(access.ownerUserId);
  if (!token) { res.status(400).json({ error: "No GitHub token configured" }); return; }

  try {
    const state = (req.query["state"] as string) || "open";
    const perPage = Math.min(parseInt((req.query["per_page"] as string) || "30", 10), 100);
    const page = parseInt((req.query["page"] as string) || "1", 10);

    const resp = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=${perPage}&page=${page}&pulls=false`,
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
  const access = await verifyProjectAccess(req.user!.userId, req.params["id"]!);
  if (!access || access.permission !== "edit") { res.status(403).json({ error: "Not authorized" }); return; }

  const repoResult = await pool.query(
    `SELECT github_owner, github_repo FROM pm_projects WHERE id = $1`,
    [req.params["id"]]
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

      const result = runPm({ args, userId: access.ownerUserId, slug: access.slug, jsonOutput: true });
      if (result.ok && result.parsed) {
        const parsed = result.parsed as { item?: { id: string } };
        created.push(parsed.item?.id || `#${num}`);
      } else {
        errors.push(`#${num}: ${result.stderr || "create failed"}`);
      }
    } catch (err) {
      errors.push(`#${num}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  res.json({ created, errors, total: issueNumbers.length });
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
