import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { runPm, projectExists } from "../services/pm-runner.js";
import { verifyProjectAccess } from "./projects.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Verify project access (owner or shared) and return slug + ownerUserId for pm-runner
async function verifyProject(
  userId: string,
  projectId: string
): Promise<{ slug: string; prefix: string; ownerUserId: string } | null> {
  const access = await verifyProjectAccess(userId, projectId);
  if (!access) return null;
  return { slug: access.slug, prefix: access.prefix, ownerUserId: access.ownerUserId };
}

// GET /api/projects/:projectId/pm/list
router.get("/list", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { status, type, limit, priority, sprint, release, assignee } = req.query as Record<string, string>;
  const args = ["list"];
  if (status) args.push("--status", status);
  if (type) args.push("--type", type);
  if (limit) args.push("--limit", limit);
  if (priority) args.push("--priority", priority);
  if (sprint) args.push("--sprint", sprint);
  if (release) args.push("--release", release);
  if (assignee) args.push("--assignee", assignee);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr, items: [] });
});

// GET /api/projects/:projectId/pm/list-all
router.get("/list-all", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { type, limit } = req.query as Record<string, string>;
  const args = ["list-all"];
  if (type) args.push("--type", type);
  if (limit) args.push("--limit", limit);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr, items: [] });
});

// POST /api/projects/:projectId/pm/create
router.post("/create", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { title, type, priority, description, tags, parent, deadline, assignee, sprint, release, estimate, body, acceptanceCriteria } = req.body as Record<string, string>;
  if (!title?.trim()) { res.status(400).json({ error: "Title is required" }); return; }

  const args = ["create", "--title", title.trim()];
  if (type) args.push("--type", type);
  if (priority) args.push("--priority", priority);
  if (description) args.push("--description", description);
  if (tags) args.push("--tags", tags);
  if (parent) args.push("--parent", parent);
  if (deadline) args.push("--deadline", deadline);
  if (assignee) args.push("--assignee", assignee);
  if (sprint) args.push("--sprint", sprint);
  if (release) args.push("--release", release);
  if (estimate) args.push("--estimate", estimate);
  if (body) args.push("--body", body);
  if (acceptanceCriteria) args.push("--acceptance-criteria", acceptanceCriteria);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to create item" });
    return;
  }
  res.status(201).json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/get/:itemId
router.get("/get/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["get", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) { res.status(404).json({ error: "Item not found" }); return; }
  res.json(result.parsed || {});
});

// PATCH /api/projects/:projectId/pm/update/:itemId
router.patch("/update/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { title, description, status, priority, tags, parent, deadline, assignee, sprint, release, estimate, body, acceptanceCriteria } = req.body as Record<string, string>;
  const args = ["update", req.params["itemId"]!];
  if (title) args.push("--title", title);
  if (description !== undefined) args.push("--description", description);
  if (status) args.push("--status", status);
  if (priority) args.push("--priority", priority);
  if (tags) args.push("--tags", tags);
  if (parent) args.push("--parent", parent);
  if (deadline) args.push("--deadline", deadline);
  if (assignee) args.push("--assignee", assignee);
  if (sprint) args.push("--sprint", sprint);
  if (release) args.push("--release", release);
  if (estimate) args.push("--estimate", estimate);
  if (body) args.push("--body", body);
  if (acceptanceCriteria) args.push("--acceptance-criteria", acceptanceCriteria);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to update item" });
    return;
  }
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/close/:itemId
router.post("/close/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { reason } = req.body as { reason?: string };
  if (!reason?.trim()) { res.status(400).json({ error: "Close reason is required" }); return; }

  const result = runPm({
    args: ["close", req.params["itemId"]!, reason.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to close item" });
    return;
  }
  res.json(result.parsed || {});
});

// DELETE /api/projects/:projectId/pm/delete/:itemId
router.delete("/delete/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["delete", req.params["itemId"]!, "--yes"],
    userId: project.ownerUserId,
    slug: project.slug,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to delete item" });
    return;
  }
  res.json({ ok: true });
});

// POST /api/projects/:projectId/pm/comments/:itemId
router.post("/comments/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Comment text is required" }); return; }

  const result = runPm({
    args: ["comments", req.params["itemId"]!, text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to add comment" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/comments/:itemId
router.get("/comments/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["comments", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { comments: [] });
});

// GET /api/projects/:projectId/pm/notes/:itemId
router.get("/notes/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["notes", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { notes: [] });
});

// POST /api/projects/:projectId/pm/notes/:itemId
router.post("/notes/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Note text is required" }); return; }

  const result = runPm({
    args: ["notes", req.params["itemId"]!, text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to add note" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/context
router.get("/context", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["context", "--depth", "full"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/activity
router.get("/activity", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { limit } = req.query as Record<string, string>;
  const args = ["activity"];
  if (limit) args.push("--limit", limit);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { activity: [] });
});

// GET /api/projects/:projectId/pm/stats
router.get("/stats", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["stats"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/aggregate
router.get("/aggregate", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["aggregate"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/search
router.post("/search", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { query } = req.body as { query?: string };
  if (!query?.trim()) { res.status(400).json({ error: "Search query is required" }); return; }

  const result = runPm({
    args: ["search", ...query.trim().split(/\s+/)],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { results: [] });
});

// GET /api/projects/:projectId/pm/calendar
router.get("/calendar", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["calendar", "--view", "month"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { events: [] });
});

// GET /api/projects/:projectId/pm/health
router.get("/health", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["health"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/append/:itemId
router.post("/append/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Text is required" }); return; }

  const result = runPm({
    args: ["append", req.params["itemId"]!, text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to append" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/history/:itemId
router.get("/history/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["history", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { history: [] });
});

// GET /api/projects/:projectId/pm/deps/:itemId
router.get("/deps/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["deps", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { deps: [] });
});

// POST /api/projects/:projectId/pm/deps/:itemId
router.post("/deps/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { targetId, rel } = req.body as { targetId?: string; rel?: string };
  if (!targetId?.trim()) { res.status(400).json({ error: "targetId is required" }); return; }

  const depRel = rel?.trim() || "depends-on";
  const result = runPm({
    args: ["deps", req.params["itemId"]!, "--add", targetId.trim(), "--rel", depRel],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to add dependency" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/learnings/:itemId
router.get("/learnings/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["learnings", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { learnings: [] });
});

// POST /api/projects/:projectId/pm/learnings/:itemId
router.post("/learnings/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Learning text is required" }); return; }

  const result = runPm({
    args: ["learnings", req.params["itemId"]!, text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to add learning" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/claim/:itemId
router.post("/claim/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["claim", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to claim item" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/release/:itemId
router.post("/release/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["release", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to release item" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/start-task/:itemId
router.post("/start-task/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["start-task", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to start task" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/pause-task/:itemId
router.post("/pause-task/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["pause-task", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to pause task" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/tests/:itemId
router.get("/tests/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["test", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { tests: [] });
});

// POST /api/projects/:projectId/pm/tests/:itemId
router.post("/tests/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { command, description } = req.body as { command?: string; description?: string };
  if (!command?.trim()) { res.status(400).json({ error: "Test command is required" }); return; }

  const args = ["test", req.params["itemId"]!, "--add", "--command", command.trim()];
  if (description) args.push("--description", description.trim());

  const result = runPm({
    args,
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to add test" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/dedupe-audit
router.get("/dedupe-audit", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["dedupe-audit"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { duplicates: [] });
});

export { router as pmRouter };
