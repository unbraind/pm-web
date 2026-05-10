import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { runPm, projectExists } from "../services/pm-runner.js";
import { verifyProjectAccess } from "./projects.js";
import { addSSEClient, broadcastProjectEvent, setupSSEHeaders, type SSEEvent } from "../services/sse.js";
import { v4 as uuidv4 } from "uuid";

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

  const { title, type, priority, description, tags, parent, deadline, assignee, sprint, release, estimate, body, acceptanceCriteria,
    reporter, component, severity, risk, goal, objective, environment, "blocked-by": blockedBy, "blocked-reason": blockedReason,
    "repro-steps": reproSteps, "expected-result": expectedResult, "actual-result": actualResult,
    reviewer, confidence, "why-now": whyNow, value, impact, outcome, "definition-of-ready": definitionOfReady,
  } = req.body as Record<string, string>;
  if (!title?.trim()) { res.status(400).json({ error: "Title is required" }); return; }

  const args = ["create", "--title", title.trim()];
  if (type) args.push("--type", type);
  if (priority) args.push("--priority", priority);
  // pm CLI requires --description; provide a sensible default when omitted
  args.push("--description", (description || title.trim()).slice(0, 500));
  if (tags) args.push("--tags", tags);
  if (parent) args.push("--parent", parent);
  if (deadline) args.push("--deadline", deadline);
  if (assignee) args.push("--assignee", assignee);
  if (sprint) args.push("--sprint", sprint);
  if (release) args.push("--release", release);
  if (estimate) args.push("--estimate", estimate);
  if (body) args.push("--body", body);
  if (acceptanceCriteria) args.push("--acceptance-criteria", acceptanceCriteria);
  if (reporter) args.push("--reporter", reporter);
  if (component) args.push("--component", component);
  if (severity) args.push("--severity", severity);
  if (risk) args.push("--risk", risk);
  if (goal) args.push("--goal", goal);
  if (objective) args.push("--objective", objective);
  if (environment) args.push("--environment", environment);
  if (blockedBy) args.push("--blocked-by", blockedBy);
  if (blockedReason) args.push("--blocked-reason", blockedReason);
  if (reproSteps) args.push("--repro-steps", reproSteps);
  if (expectedResult) args.push("--expected-result", expectedResult);
  if (actualResult) args.push("--actual-result", actualResult);
  if (reviewer) args.push("--reviewer", reviewer);
  if (confidence) args.push("--confidence", confidence);
  if (whyNow) args.push("--why-now", whyNow);
  if (value) args.push("--value", value);
  if (impact) args.push("--impact", impact);
  if (outcome) args.push("--outcome", outcome);
  if (definitionOfReady) args.push("--definition-of-ready", definitionOfReady);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to create item" });
    return;
  }
  // Broadcast SSE create event
  broadcastProjectEvent(req.params["projectId"]!, {
    type: "item-created",
    data: { result: result.parsed, userId: req.user!.userId },
  });
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

  const body = req.body as Record<string, string>;
  const args = ["update", req.params["itemId"]!];
  // String options
  const stringFlags: Record<string, string> = {
    title: "--title", description: "--description", status: "--status", priority: "--priority",
    tags: "--tags", parent: "--parent", deadline: "--deadline", assignee: "--assignee",
    sprint: "--sprint", release: "--release", estimate: "--estimate", body: "--body",
    acceptanceCriteria: "--acceptance-criteria", reviewer: "--reviewer", risk: "--risk",
    confidence: "--confidence", blockedBy: "--blocked-by", blockedReason: "--blocked-reason",
    reporter: "--reporter", severity: "--severity", environment: "--environment",
    reproSteps: "--repro-steps", expectedResult: "--expected-result", actualResult: "--actual-result",
    component: "--component", goal: "--goal", objective: "--objective", value: "--value",
    impact: "--impact", outcome: "--outcome", whyNow: "--why-now",
    definitionOfReady: "--definition-of-ready", author: "--author", message: "--message",
    order: "--order", rank: "--rank", closeReason: "--close-reason",
    resolution: "--resolution", affectedVersion: "--affected-version", fixedVersion: "--fixed-version",
    regression: "--regression", customerImpact: "--customer-impact",
    unblockNote: "--unblock-note",
  };
  for (const [key, flag] of Object.entries(stringFlags)) {
    const val = body[key];
    if (val !== undefined && val !== null && val !== "") {
      args.push(flag, String(val));
    }
  }
  // Type can be set but must use --type
  if (body.type) args.push("--type", body.type);

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to update item" });
    return;
  }
  // Broadcast SSE update event
  broadcastProjectEvent(req.params["projectId"]!, {
    type: "item-updated",
    data: { itemId: req.params["itemId"], userId: req.user!.userId },
  });
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
  broadcastProjectEvent(req.params["projectId"]!, {
    type: "item-closed",
    data: { itemId: req.params["itemId"], userId: req.user!.userId },
  });
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
  broadcastProjectEvent(req.params["projectId"]!, {
    type: "item-deleted",
    data: { itemId: req.params["itemId"], userId: req.user!.userId },
  });
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

  const { query, mode } = req.body as { query?: string; mode?: string };
  if (!query?.trim()) { res.status(400).json({ error: "Search query is required" }); return; }

  const validModes = ["keyword", "semantic", "hybrid"];
  const safeMode = validModes.includes(mode || "") ? mode! : "hybrid";

  const result = runPm({
    args: ["search", "--mode", safeMode, ...query.trim().split(/\s+/)],
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

// GET /api/projects/:projectId/pm/validate
router.get("/validate", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["validate"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/restore/:itemId
router.post("/restore/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { target } = req.body as { target?: string };
  if (!target?.trim()) { res.status(400).json({ error: "Restore target (timestamp or version) is required" }); return; }
  const result = runPm({
    args: ["restore", req.params["itemId"]!, target.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to restore item" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/close-task/:itemId
router.post("/close-task/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { reason } = req.body as { reason?: string };
  if (!reason?.trim()) { res.status(400).json({ error: "Close reason is required" }); return; }

  const result = runPm({
    args: ["close-task", req.params["itemId"]!, reason.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to close task" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/reindex
router.post("/reindex", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { mode = "keyword" } = req.body as { mode?: string };
  const validModes = ["keyword", "semantic", "hybrid"];
  const safeMode = validModes.includes(mode) ? mode : "keyword";
  const result = runPm({
    args: ["reindex", "--mode", safeMode],
    userId: project.ownerUserId,
    slug: project.slug,
  });
  res.json(result.ok ? { ok: true, mode: safeMode } : { error: result.stderr || "Reindex failed" });
});

// GET /api/projects/:projectId/pm/normalize
router.get("/normalize", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["normalize"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/comments-audit
router.get("/comments-audit", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["comments-audit"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/files/:itemId
router.post("/files/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { path: filePath, scope } = req.body as { path?: string; scope?: string };
  if (!filePath?.trim()) { res.status(400).json({ error: "File path is required" }); return; }
  const args = ["files", req.params["itemId"]!, "--add", `path=${filePath.trim()}`];
  if (scope) args.push(",scope=" + scope);
  const result = runPm({
    args,
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to link file" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/files/:itemId
router.get("/files/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["files", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { files: [] });
});

// GET /api/projects/:projectId/pm/guide — list guide topics
router.get("/guide", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["guide"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/guide/:topicId — get single guide topic
router.get("/guide/:topicId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = runPm({
    args: ["guide", req.params["topicId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) { res.status(404).json({ error: result.stderr || "Topic not found" }); return; }
  res.json(result.parsed || {});
});

// ─────────────────────────────────────────────────────────
// New routes: export, import, update-many, docs, test-all,
// test-runs, gc, templates, config, list-status-shortcuts,
// SSE endpoint
// ─────────────────────────────────────────────────────────

// GET /api/projects/:projectId/pm/export?format=json|csv
router.get("/export", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const format = (req.query["format"] as string) || "json";
  const result = runPm({
    args: ["list-all", "--limit", "10000"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });

  if (!result.ok) {
    res.status(500).json({ error: result.stderr || "Export failed" });
    return;
  }

  const data = result.parsed as { items?: unknown[] } | undefined;

  if (format === "csv") {
    const items = data?.items ?? [];
    const rows = items as Record<string, unknown>[];
    if (rows.length === 0) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${project.slug}-export.csv"`);
      res.send("");
      return;
    }
    const headers = ["id", "title", "description", "type", "status", "priority", "tags", "assignee", "sprint", "release", "deadline", "created_at", "updated_at"];
    const csvLines: string[] = [headers.join(",")];
    for (const item of rows) {
      const row = headers.map((h) => {
        const val = item[h];
        if (val === null || val === undefined) return "";
        const str = String(Array.isArray(val) ? val.join(";") : val);
        // Escape CSV: wrap in quotes if contains comma, quote, or newline
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
      csvLines.push(row.join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${project.slug}-export.csv"`);
    res.send(csvLines.join("\n"));
  } else {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${project.slug}-export.json"`);
    res.json(data || { items: [] });
  }
});

// POST /api/projects/:projectId/pm/import — import JSON items
router.post("/import", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { items } = req.body as { items?: Array<Record<string, string>> };
  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array is required" });
    return;
  }
  if (items.length > 500) {
    res.status(400).json({ error: "Cannot import more than 500 items at once" });
    return;
  }

  const created: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!item.title?.trim()) {
      errors.push(`item[${i}]: title is required`);
      continue;
    }
    const args = ["create", "--title", item.title.trim()];
    if (item.type) args.push("--type", item.type);
    if (item.description) args.push("--description", item.description);
    else args.push("--description", item.title.trim());
    if (item.priority) args.push("--priority", item.priority);
    if (item.status) args.push("--status", item.status);
    if (item.tags) args.push("--tags", item.tags);
    if (item.assignee) args.push("--assignee", item.assignee);
    if (item.sprint) args.push("--sprint", item.sprint);
    if (item.release) args.push("--release", item.release);
    if (item.deadline) args.push("--deadline", item.deadline);
    if (item.body) args.push("--body", item.body);
    if (item.parent) args.push("--parent", item.parent);

    const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
    if (result.ok && result.parsed) {
      const parsed = result.parsed as { item?: { id: string } };
      created.push(parsed.item?.id || `item[${i}]`);
    } else {
      errors.push(`item[${i}]: ${result.stderr || "create failed"}`);
    }
  }

  broadcastProjectEvent(req.params["projectId"]!, {
    type: "items-imported",
    data: { count: created.length, userId: req.user!.userId },
  });
  res.json({ created, errors, total: items.length });
});

// POST /api/projects/:projectId/pm/update-many
router.post("/update-many", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const body = req.body as Record<string, string>;
  const args = ["update-many"];

  // Filter options
  const filterFlags: Record<string, string> = {
    filterStatus: "--filter-status", filterType: "--filter-type",
    filterTag: "--filter-tag", filterPriority: "--filter-priority",
    filterDeadlineBefore: "--filter-deadline-before", filterDeadlineAfter: "--filter-deadline-after",
    filterAssignee: "--filter-assignee", filterParent: "--filter-parent",
    filterSprint: "--filter-sprint", filterRelease: "--filter-release",
    limit: "--limit", offset: "--offset",
  };
  for (const [key, flag] of Object.entries(filterFlags)) {
    if (body[key]) args.push(flag, body[key]!);
  }
  if (body.dryRun === "true") args.push("--dry-run");
  if (body.rollback) args.push("--rollback", body.rollback);

  // Update options (same as update)
  const updateFlags: Record<string, string> = {
    title: "--title", description: "--description", body: "--body", status: "--status",
    priority: "--priority", type: "--type", tags: "--tags", deadline: "--deadline",
    estimate: "--estimate", acceptanceCriteria: "--acceptance-criteria",
    definitionOfReady: "--definition-of-ready", sprint: "--sprint", release: "--release",
    assignee: "--assignee", reviewer: "--reviewer", risk: "--risk", confidence: "--confidence",
    goal: "--goal", objective: "--objective", value: "--value", impact: "--impact",
    outcome: "--outcome", whyNow: "--why-now",
  };
  for (const [key, flag] of Object.entries(updateFlags)) {
    if (body[key]) args.push(flag, body[key]!);
  }

  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "update-many failed" });
    return;
  }
  broadcastProjectEvent(req.params["projectId"]!, {
    type: "items-bulk-updated",
    data: { userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/docs/:itemId
router.get("/docs/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({
    args: ["docs", req.params["itemId"]!],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { docs: [] });
});

// POST /api/projects/:projectId/pm/docs/:itemId
router.post("/docs/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { path: docPath, scope, note, remove, validatePaths } = req.body as Record<string, string>;
  const args = ["docs", req.params["itemId"]!];
  if (remove) {
    args.push("--remove", remove);
  } else if (validatePaths === "true") {
    args.push("--validate-paths");
  } else if (docPath) {
    let addVal = `path=${docPath}`;
    if (scope) addVal += `,scope=${scope}`;
    if (note) addVal += `,note=${note}`;
    args.push("--add", addVal);
  } else {
    res.status(400).json({ error: "path, remove, or validatePaths is required" });
    return;
  }
  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "Failed to update docs" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/test-all
router.post("/test-all", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const body = req.body as Record<string, string>;
  const args = ["test-all"];
  if (body.status) args.push("--status", body.status);
  if (body.limit) args.push("--limit", body.limit);
  if (body.timeout) args.push("--timeout", body.timeout);
  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || "test-all failed" });
    return;
  }
  res.json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/test-runs
router.get("/test-runs", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { status, limit } = req.query as Record<string, string>;
  const args = ["test-runs", "list"];
  if (status) args.push("--status", status);
  if (limit) args.push("--limit", limit);
  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { runs: [] });
});

// POST /api/projects/:projectId/pm/gc
router.post("/gc", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({ args: ["gc"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/templates
router.get("/templates", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({ args: ["templates", "list"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { templates: [] });
});

// GET /api/projects/:projectId/pm/templates/:name
router.get("/templates/:name", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({ args: ["templates", "show", req.params["name"]!], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/config
router.get("/config", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = runPm({ args: ["config", "project", "list"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/config/:key
router.get("/config/:key", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const key = req.params["key"]!;
  const result = runPm({ args: ["config", "project", "get", key], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// PATCH /api/projects/:projectId/pm/config/:key
router.patch("/config/:key", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const key = req.params["key"]!;
  const body = req.body as Record<string, string>;
  const args = ["config", "project", "set", key];
  if (body.value) args.push(body.value);
  if (body.policy) args.push("--policy", body.policy);
  if (body.format) args.push("--format", body.format);
  const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// ─── List status shortcut routes ───
// These wrap pm list-draft, list-open, etc.
function buildListShortcutRoute(pmCommand: string) {
  return async (req: AuthRequest, res: Response) => {
    const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    const { type, limit, offset, tag, priority, assignee, sprint, release } = req.query as Record<string, string>;
    const args = [pmCommand];
    if (type) args.push("--type", type);
    if (limit) args.push("--limit", limit);
    if (offset) args.push("--offset", offset);
    if (tag) args.push("--tag", tag);
    if (priority) args.push("--priority", priority);
    if (assignee) args.push("--assignee", assignee);
    if (sprint) args.push("--sprint", sprint);
    if (release) args.push("--release", release);
    const result = runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
    res.json(result.ok ? (result.parsed || {}) : { items: [] });
  };
}

import type { Response } from "express";

router.get("/list-draft", buildListShortcutRoute("list-draft"));
router.get("/list-open", buildListShortcutRoute("list-open"));
router.get("/list-in-progress", buildListShortcutRoute("list-in-progress"));
router.get("/list-blocked", buildListShortcutRoute("list-blocked"));
router.get("/list-closed", buildListShortcutRoute("list-closed"));
router.get("/list-canceled", buildListShortcutRoute("list-canceled"));

// ─── SSE endpoint ───
// GET /api/projects/:projectId/pm/events
router.get("/events", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, req.params["projectId"]!);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  setupSSEHeaders(res);

  const clientId = uuidv4();
  const unsubscribe = addSSEClient({
    id: clientId,
    projectId: req.params["projectId"]!,
    userId: req.user!.userId,
    res,
    connectedAt: new Date(),
  });

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export { router as pmRouter };

