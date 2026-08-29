import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.ts";
import { ensureGraphExtension, readCompletePmItems, runPm, runGetItemAt, projectExists, readPmSettings, PmCliError, EXIT_CODE } from "../services/pm-runner.ts";
// The search-tuning resolvers live only on the narrow sdk/query entrypoint — the
// aggregate sdk barrel documents itself as re-exporting every supported export but
// omits 45 of them, these three included (upstream: unbraind/pm-cli#740).
import {
  resolveSearchMaxResults,
  resolveSearchScoreThreshold,
  resolveHybridSemanticWeight,
} from "@unbrained/pm-cli/sdk/query";
import { QUERY_CURSOR_CONTRACT } from "@unbrained/pm-cli/sdk";
import { boardColumns, filterItemsByQuery } from "../board.ts";
import { buildIcsCalendar, type CalendarItem } from "../ical.ts";
import { verifyProjectAccess } from "./projects.ts";
import { addSSEClient, broadcastProjectEvent, setupSSEHeaders, updateClientView, getProjectPresence, type SSEEvent } from "../services/sse.ts";
import { v4 as uuidv4 } from "uuid";
import neo4j from "neo4j-driver";
import { createHash } from "node:crypto";
import { routeParam } from "./route-params.ts";
import { pool } from "../db.ts";

// Singleton Neo4j driver — reused across sync calls to avoid per-call connection overhead.
let _neo4jDriver: ReturnType<typeof neo4j.driver> | null = null;
let _neo4jDriverKey = "";

/**
 * Return the process-wide Neo4j driver, recreating it when the connection key changes.
 *
 * Reads `NEO4J_URI`/`NEO4J_USER` (`NEO4J_USERNAME`)/`NEO4J_PASSWORD` and caches a
 * single driver. When the key changes the previous driver is closed
 * (best-effort) and a new one created, so graph syncs never hold a stale
 * connection after an operator edits the Neo4j environment.
 *
 * The key covers the password as well as the URI and user, because the driver
 * is constructed with all three: keying on `uri:user` alone would keep serving
 * a driver holding the OLD credentials after a password rotation, and every
 * sync would keep failing to authenticate until the process restarted. The
 * password enters the key as a SHA-256 digest rather than in clear text, so a
 * credential cannot leak through a value held for the lifetime of the process.
 */
function getNeo4jDriver(): ReturnType<typeof neo4j.driver> {
  const uri = process.env.NEO4J_URI ?? "";
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "";
  const password = process.env.NEO4J_PASSWORD ?? "";
  const key = `${uri}:${user}:${createHash("sha256").update(password).digest("hex")}`;
  if (!_neo4jDriver || _neo4jDriverKey !== key) {
    if (_neo4jDriver) {
      void _neo4jDriver.close().catch(() => undefined);
    }
    _neo4jDriver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    _neo4jDriverKey = key;
  }
  return _neo4jDriver;
}

const router = Router({ mergeParams: true });
router.use(requireAuth);
const BASE64URL_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate an incoming opaque pagination cursor. Returns the original cursor or
 * `undefined` when none was supplied. Rejects cursors that exceed the SDK
 * cursor contract's maximum length with a 400 so callers can map the failure
 * to a proper client error instead of forwarding an oversized token to the SDK.
 */
function validateCursor(raw: unknown): { cursor?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  const cursor = String(raw);
  if (cursor.length > QUERY_CURSOR_CONTRACT.max_length) {
    return {
      error: `Pagination cursor exceeds the maximum length of ${QUERY_CURSOR_CONTRACT.max_length} characters.`,
    };
  }
  if (!BASE64URL_CURSOR_PATTERN.test(cursor)) {
    return { error: "Pagination cursor must be a valid base64url token." };
  }
  return { cursor };
}

/** Coerce an optional request number into a finite, bounded value. */
function boundedNumber(
  raw: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(maximum, Math.max(minimum, parsed));
  return integer ? Math.trunc(bounded) : bounded;
}

/**
 * Map a {@link PmRunResult} failure to the correct HTTP status using the pm CLI
 * exit code surfaced by the in-process dispatcher. Expected validation failures
 * (USAGE) and not-found (NOT_FOUND) become 4xx; anything without a recognised
 * exit code is an unexpected runtime error and becomes 500 so it is not
 * silently swallowed as a client error.
 */
function pmErrorStatus(result: { exitCode?: number }): number {
  if (result.exitCode === EXIT_CODE.NOT_FOUND) return 404;
  if (result.exitCode === EXIT_CODE.USAGE) return 400;
  if (result.exitCode === EXIT_CODE.CONFLICT) return 409;
  if (result.exitCode === EXIT_CODE.DEPENDENCY_FAILED) return 424;
  return 500;
}

type PmItem = {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  priority?: number;
  tags?: string[];
  parent?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  deadline?: string;
  created_at?: string;
  updated_at?: string;
  deps?: Array<Record<string, unknown>>;
  dependencies?: Array<Record<string, unknown>>;
  blocked_by?: string;
  blockedBy?: string;
  blocked_reason?: string;
  blockedReason?: string;
};

type GraphNode = {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
};

type GraphRelationship = {
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
};

type ProjectGraph = {
  generatedAt: string;
  source: "pm-graph" | "pm-web";
  nodes: GraphNode[];
  relationships: GraphRelationship[];
};

type ProjectRef = {
  slug: string;
  prefix: string;
  ownerUserId: string;
};

const pendingGraphSyncs = new Map<string, NodeJS.Timeout>();

router.use(async (req: AuthRequest, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || (req.method === "PATCH" && req.path.startsWith("/presence/"))) {
    next();
    return;
  }
  const projectId = routeParam(req, "projectId");
  if (!projectId) {
    next();
    return;
  }
  try {
    const access = await verifyProjectAccess(req.user!.userId, projectId);
    if (!access) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (access.permission !== "edit") {
      res.status(403).json({ error: "This project is shared as view-only." });
      return;
    }
    next();
  } catch (err) {
    console.error("Project permission check failed:", err);
    res.status(500).json({ error: "Failed to verify project permission" });
  }
});

function graphNodeId(kind: string, value: string): string {
  return `${kind}:${value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function graphRelationshipType(rawType: unknown): string {
  const text = typeof rawType === "string" && rawType.trim().length > 0 ? rawType : "relates-to";
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Extract the target item id from a dependency record.
 *
 * Checks a list of likely keys (`id`, `target`, `target_id`, `targetId`,
 * `item`, `item_id`, `itemId`) in order and returns the first non-empty trimmed
 * string value, so dependency rows shaped by different pm versions/extensions
 * all resolve. Returns `null` when no usable id is present.
 *
 * @param dep - One dependency record from item deps or a graph extension.
 * @returns The target id, trimmed, or `null`.
 */
function dependencyTarget(dep: Record<string, unknown>): string | null {
  for (const key of ["id", "target", "target_id", "targetId", "item", "item_id", "itemId"]) {
    const value = dep[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Coerce a raw value into a list of dependency records.
 *
 * An array is filtered to its object entries. An object is searched for an
 * array under `deps`, `dependencies`, `items`, or `relationships` and that
 * array's object entries are returned. Anything else yields an empty array,
 * so callers always receive a uniform list regardless of the source shape.
 *
 * @param raw - The raw dependency payload from a pm item or extension export.
 * @returns The dependency records found, as an array of objects.
 */
function dependencyRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  for (const key of ["deps", "dependencies", "items", "relationships"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
    }
  }
  return [];
}

/**
 * Normalize a dependency-kind label to a canonical lowercased form.
 *
 * Defaults to `blocked_by`, lowercases, and replaces hyphens with underscores,
 * then maps common aliases to their canonical kind (for example `depends_on`,
 * `dependency`, `blocked`, and `blockedby` all become `blocked_by`; `parent_of`
 * becomes `parent`; `relates_to`/`related_to` become `related`). Returns the
 * mapped value as-is.
 *
 * @param input - The raw kind string, or `undefined`.
 * @returns The canonicalized kind string.
 */
function normalizeDependencyKind(input: string | undefined): string {
  const raw = (input ?? "blocked_by").trim().toLowerCase().replace(/-/g, "_");
  const aliases: Record<string, string> = {
    blockedby: "blocked_by",
    blocked: "blocked_by",
    blocked_by: "blocked_by",
    blocks: "blocks",
    depends_on: "blocked_by",
    dependson: "blocked_by",
    dependency: "blocked_by",
    parent_of: "parent",
    child_of: "child",
    relates_to: "related",
    related_to: "related",
    related: "related",
  };
  const normalized = aliases[raw] ?? raw;
  const allowed = new Set(["parent", "child", "blocks", "blocked_by", "related"]);
  return allowed.has(normalized) ? normalized : normalized;
}

/**
 * Build a project graph (nodes + relationships) from pm items.
 *
 * Creates one `PmItem` node per item plus `PmFacet` nodes for type, status,
 * assignee, sprint, release, and each tag, deduplicating nodes by id (first one
 * wins). Adds `CHILD_OF`/`BLOCKED_BY` edges from item fields and typed edges
 * from embedded/extension dependencies, synthesizing `ExternalPmItem` nodes for
 * targets not in the item set. Relationships are deduplicated by
 * `(from, to, type)`, keeping the first occurrence. The result is tagged
 * `source: "pm-web"`.
 *
 * @param items - The pm items.
 * @param depsByItem - Extra per-item dependency records (e.g. from an extension).
 * @returns The assembled project graph.
 */
function graphFromItems(items: PmItem[], depsByItem: Map<string, Array<Record<string, unknown>>>): ProjectGraph {
  const nodesById = new Map<string, GraphNode>();
  const relationships: GraphRelationship[] = [];

  const addNode = (node: GraphNode) => {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  };

  const addRelationship = (from: string, to: string, type: string, properties: Record<string, unknown>) => {
    if (!nodesById.has(to) && !items.some((item) => item.id === to)) {
      addNode({
        id: to,
        labels: ["ExternalPmItem"],
        properties: { id: to, title: to, type: "ExternalPmItem" },
      });
    }
    relationships.push({ from, to, type, properties });
  };

  for (const item of items) {
    addNode({
      id: item.id,
      labels: ["PmItem", item.type ?? "Item"],
      properties: {
        id: item.id,
        title: item.title ?? "",
        type: item.type ?? "Item",
        status: item.status ?? "unknown",
        priority: item.priority ?? null,
        tags: item.tags ?? [],
        assignee: item.assignee ?? null,
        sprint: item.sprint ?? null,
        release: item.release ?? null,
        deadline: item.deadline ?? null,
        created_at: item.created_at ?? null,
        updated_at: item.updated_at ?? null,
      },
    });

    if (item.parent) {
      addRelationship(item.id, item.parent, "CHILD_OF", { source: "parent" });
    }

    const blockedBy = item.blocked_by ?? item.blockedBy;
    if (typeof blockedBy === "string" && blockedBy.trim().length > 0) {
      addRelationship(item.id, blockedBy.trim(), "BLOCKED_BY", {
        source: "blocked_by",
        reason: item.blocked_reason ?? item.blockedReason ?? null,
      });
    }

    const deps = [
      ...(item.deps ?? []),
      ...(item.dependencies ?? []),
      ...(depsByItem.get(item.id) ?? []),
    ];
    const seenDeps = new Set<string>();
    for (const dep of deps) {
      const target = dependencyTarget(dep);
      if (!target) continue;
      const type = graphRelationshipType(dep.type ?? dep.kind ?? dep.relation ?? dep.rel ?? dep.relationship);
      const key = `${item.id}->${target}:${type}`;
      if (seenDeps.has(key)) continue;
      seenDeps.add(key);
      addRelationship(item.id, target, type, { ...dep });
    }

    const facetLinks: Array<{ kind: string; value?: unknown; label: string; rel: string }> = [
      { kind: "type", value: item.type, label: "ItemType", rel: "HAS_TYPE" },
      { kind: "status", value: item.status, label: "Status", rel: "HAS_STATUS" },
      { kind: "assignee", value: item.assignee, label: "Person", rel: "ASSIGNED_TO" },
      { kind: "sprint", value: item.sprint, label: "Sprint", rel: "IN_SPRINT" },
      { kind: "release", value: item.release, label: "Release", rel: "IN_RELEASE" },
    ];
    for (const link of facetLinks) {
      if (typeof link.value !== "string" || link.value.trim().length === 0) continue;
      const id = graphNodeId(link.kind, link.value);
      addNode({
        id,
        labels: ["PmFacet", link.label],
        properties: { id, title: link.value, kind: link.kind, value: link.value },
      });
      addRelationship(item.id, id, link.rel, { source: link.kind });
    }

    for (const tag of item.tags ?? []) {
      if (!tag.trim()) continue;
      const id = graphNodeId("tag", tag);
      addNode({
        id,
        labels: ["PmFacet", "Tag"],
        properties: { id, title: tag, kind: "tag", value: tag },
      });
      addRelationship(item.id, id, "TAGGED_WITH", { source: "tags" });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "pm-web",
    nodes: Array.from(nodesById.values()),
    relationships: relationships.filter((rel, index, all) =>
      all.findIndex((candidate) =>
        candidate.from === rel.from && candidate.to === rel.to && candidate.type === rel.type
      ) === index
    ),
  };
}

function graphProjectKey(project: ProjectRef): string {
  return `${project.ownerUserId}:${project.slug}`;
}

/**
 * Replace a project's Neo4j subgraph with the given graph.
 *
 * Requires `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` (throws otherwise). In one
 * session it `DETACH DELETE`s the existing `PmGraphNode` set for the project key,
 * then `MERGE`s every node and relationship from the graph (tagged with the
 * project key). Returns the node and relationship counts of the supplied graph.
 *
 * @param graph - The graph to write.
 * @param projectKey - The stable key scoping this project's nodes.
 * @returns The number of nodes and relationships written from the graph.
 */
async function syncGraphToNeo4j(
  graph: ProjectGraph,
  projectKey: string
): Promise<{ syncedNodes: number; syncedRelationships: number }> {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("Set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD before syncing the graph.");
  }

  const driver = getNeo4jDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE });
  try {
    await session.executeWrite((tx) =>
      tx.run("MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n", { projectKey })
    );

    for (const node of graph.nodes) {
      await session.executeWrite((tx) =>
        tx.run(
          "MERGE (n:PmGraphNode {projectKey: $projectKey, id: $id}) SET n += $properties, n.labels = $labels RETURN n.id",
          { projectKey, id: node.id, properties: { ...node.properties, projectKey }, labels: node.labels }
        )
      );
    }

    for (const relationship of graph.relationships) {
      const relType = graphRelationshipType(relationship.type);
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (from:PmGraphNode {projectKey: $projectKey, id: $from}), (to:PmGraphNode {projectKey: $projectKey, id: $to}) MERGE (from)-[r:${relType}]->(to) SET r += $properties RETURN type(r)`,
          { projectKey, from: relationship.from, to: relationship.to, properties: { ...relationship.properties, projectKey } }
        )
      );
    }
  } finally {
    await session.close();
  }

  return { syncedNodes: graph.nodes.length, syncedRelationships: graph.relationships.length };
}

async function syncProjectGraph(project: ProjectRef): Promise<{ syncedNodes: number; syncedRelationships: number }> {
  const extensionGraph = await pmGraphExtensionGraphForProject(project);
  const graph = extensionGraph.graph ?? await fallbackGraphForProject(project.ownerUserId, project.slug);
  return syncGraphToNeo4j(graph, graphProjectKey(project));
}

/**
 * Debounce and run a graph sync for one project.
 *
 * Replaces any pending sync for the project with a new 750 ms timer, so a burst
 * of mutations triggers one sync rather than many. When the timer fires it runs
 * the sync and broadcasts `graph-synced` on success, or `graph-sync-failed` (and
 * the legacy `graph_sync_failed`) with the error message on failure.
 *
 * @param projectId - The database project id (for the broadcast).
 * @param project - The owner/slug/prefix reference used to build the graph.
 * @param reason - Free-text cause included in the broadcast event.
 */
function scheduleGraphSync(projectId: string, project: ProjectRef, reason: string): void {
  const existing = pendingGraphSyncs.get(projectId);
  if (existing) clearTimeout(existing);

  pendingGraphSyncs.set(projectId, setTimeout(() => {
    pendingGraphSyncs.delete(projectId);
    syncProjectGraph(project)
      .then((result) => {
        broadcastProjectEvent(projectId, {
          type: "graph-synced",
          data: { reason, ...result },
        });
      })
      .catch((err: unknown) => {
        // Use `%s` specifiers and pass the values as arguments instead of
        // interpolating them into the format string, so a tainted `reason` or
        // `projectId` cannot inject `console` format specifiers.
        console.error("Neo4j graph auto-sync failed for %s after %s:", projectId, reason, err);
        broadcastProjectEvent(projectId, {
          type: "graph-sync-failed",
          data: { reason, error: err instanceof Error ? err.message : String(err) },
        });
        broadcastProjectEvent(projectId, {
          type: "graph_sync_failed",
          data: { reason, error: err instanceof Error ? err.message : String(err) },
        });
      });
  }, 750));
}

type DependencyEventKind = "dependency-added" | "dependency-removed";

/**
 * Announce a dependency change to a project's SSE clients.
 *
 * Emits two events for one change: the specific `dependency-added`/
 * `dependency-removed` event, and a generic `item-updated` carrying
 * `itemId`/`change`/`target`/`rel`/`userId` (not the same `from`/`to` fields as
 * the specific event), so views keyed on either event type stay in sync.
 */
function broadcastDependencyEvent(
  projectId: string,
  kind: DependencyEventKind,
  data: {
    from: string;
    to: string;
    rel: string;
    userId: string;
  }
): void {
  broadcastProjectEvent(projectId, {
    type: kind,
    data,
  });
  broadcastProjectEvent(projectId, {
    type: "item-updated",
    data: {
      itemId: data.from,
      change: kind,
      target: data.to,
      rel: data.rel,
      userId: data.userId,
    },
  });
}

function itemsFromCompleteList(parsed: unknown): PmItem[] {
  return ((((parsed as { items?: PmItem[] } | undefined)?.items) ?? []) as PmItem[]);
}

/**
 * Build a project graph from a certified complete pm read when no graph extension is available.
 *
 * Reads every item through the public SDK's high-level complete-list operation
 * and assembles the graph from embedded `deps`/`dependencies` (no per-item
 * calls), avoiding an N+1 fan-out. Throws when the corpus cannot be certified.
 *
 * @param ownerUserId - The project owner's user id.
 * @param slug - The project slug.
 * @returns A pm-web-sourced project graph.
 */
async function fallbackGraphForProject(ownerUserId: string, slug: string): Promise<ProjectGraph> {
  const itemsResult = await readCompletePmItems(ownerUserId, slug);
  if (!itemsResult.ok) throw new Error(itemsResult.stderr || "Failed to load items for graph");

  const items = itemsFromCompleteList(itemsResult.result);
  // Deps are already embedded in the full item rows (item.deps / item.dependencies).
  // Avoid N+1 subprocess calls by using only the embedded data.
  return graphFromItems(items, new Map());
}

/**
 * Fetch a project graph from the `pm-graph` extension, when installed.
 *
 * Ensures the extension is provisioned for the project (returning `{ error }`
 * if that fails), runs `pm-graph export --json`, and parses its output. Returns
 * `{ graph }` when the extension produced valid JSON with a graph, otherwise an
 * `{ error }` so the caller can fall back to a pm-web-built graph.
 *
 * @param project - The owner/slug/prefix reference.
 * @returns The extension graph, or an error reason.
 */
async function pmGraphExtensionGraphForProject(project: ProjectRef): Promise<{ graph?: ProjectGraph; error?: string }> {
  const provision = await ensureGraphExtension(project.ownerUserId, project.slug);
  if (!provision.ok) {
    return { error: provision.error };
  }

  const extensionResult = await runPm({
    args: ["pm-graph", "export", "--json"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: false,
  });
  let extensionData: { graph?: ProjectGraph } | undefined;
  if (extensionResult.ok && extensionResult.stdout) {
    try {
      extensionData = JSON.parse(extensionResult.stdout) as { graph?: ProjectGraph };
    } catch {
      return { error: "pm-graph export returned invalid JSON." };
    }
  }
  if (extensionResult.ok && extensionData?.graph) {
    return {
      graph: {
        ...extensionData.graph,
        source: "pm-graph",
      },
    };
  }

  return { error: extensionResult.stderr || extensionResult.stdout || "pm-graph export did not return a graph." };
}

// Verify project access (owner or shared) and return slug + ownerUserId for pm-runner
async function verifyProject(
  userId: string,
  projectId: string
): Promise<ProjectRef | null> {
  const access = await verifyProjectAccess(userId, projectId);
  if (!access) return null;
  return { slug: access.slug, prefix: access.prefix, ownerUserId: access.ownerUserId };
}

// GET /api/projects/:projectId/pm/schema
// Returns runtime types/statuses from `pm contracts --json` so the frontend
// stays in sync with whatever pm CLI version + extensions are installed.
router.get("/schema", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({ args: ["contracts", "--json"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  const contracts = result.ok && result.parsed ? (result.parsed as Record<string, unknown>) : null;
  const rt = contracts?.["runtime_schema"] as Record<string, unknown> | undefined;
  res.json({
    types: Array.isArray(rt?.["types"]) ? rt["types"] : [],
    statuses: Array.isArray(rt?.["statuses"]) ? rt["statuses"] : [],
    openStatus: typeof rt?.["open_status"] === "string" ? rt["open_status"] : "open",
    closeStatus: typeof rt?.["close_status"] === "string" ? rt["close_status"] : "closed",
    canceledStatus: typeof rt?.["canceled_status"] === "string" ? rt["canceled_status"] : "canceled",
  });
});

/**
 * Reject a user-supplied value that would be parsed as a CLI flag.
 *
 * `runPm` passes an argv array rather than a shell string, so there is no shell
 * injection here — but a value beginning with `-` would still be consumed by
 * commander as an option instead of the positional it is meant to be. Item ids
 * and schema names are never legitimately `-`-prefixed.
 */
function isFlagLike(value: string): boolean {
  return value.startsWith("-");
}

/**
 * Whether a custom item type's storage folder is a safe relative subpath.
 *
 * This is a **tenant boundary**, not a style check. `pm schema add-type --folder`
 * is not path-validated by the CLI: a `..` segment is honoured, so a subsequent
 * `pm create` of that type writes the item's `.toon` outside the pm root.
 * Verified against pm-cli 2026.7.28 — `--folder ../../../../../../tmp/x` placed
 * the item six levels above the workspace, while the history file stayed inside.
 * (Absolute paths are safe: the CLI strips the leading separator and treats them
 * as relative to the pm root.)
 *
 * Project workspaces here live at `PROJECTS_ROOT/<ownerUserId>/<slug>/.agents/pm`,
 * so an unchecked `..` would let one tenant write into another tenant's project.
 * Only plain nested segments are accepted.
 */
function isSafeTypeFolder(folder: string): boolean {
  if (folder.startsWith("/") || folder.startsWith("\\")) return false;
  // Reject drive-letter and UNC forms so behaviour does not depend on the host OS.
  if (/^[a-zA-Z]:/.test(folder)) return false;
  const segments = folder.split(/[/\\]/);
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * POST /api/projects/:projectId/pm/schema/add-type
 *
 * Registers a custom item type via `pm schema add-type <name>`. The config view
 * has offered this control since it shipped, but the route was never mounted, so
 * the button failed for every user; see pm-web#71.
 *
 * Mutating, so the router-level guard above has already rejected view-only
 * collaborators with 403 before this handler runs.
 */
router.post("/schema/add-type", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const body = req.body as { name?: unknown; description?: unknown; defaultStatus?: unknown; folder?: unknown; aliases?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  if (isFlagLike(name)) { res.status(400).json({ error: "name must not start with '-'" }); return; }

  // `--folder` escapes the workspace if it contains `..` (see isSafeTypeFolder),
  // which in this multi-tenant layout would reach another user's project.
  const folder = typeof body.folder === "string" ? body.folder.trim() : "";
  if (folder !== "" && !isSafeTypeFolder(folder)) {
    res.status(400).json({ error: "folder must be a relative path without '..' segments" });
    return;
  }

  const args = ["schema", "add-type", name];
  const stringFlags: Array<[unknown, string]> = [
    [body.description, "--description"],
    [body.defaultStatus, "--default-status"],
    [folder, "--folder"],
  ];
  for (const [raw, flag] of stringFlags) {
    if (typeof raw === "string" && raw.trim() !== "") args.push(flag, raw.trim());
  }
  // `--alias` is repeatable; the client sends the parsed array.
  if (Array.isArray(body.aliases)) {
    for (const alias of body.aliases) {
      if (typeof alias === "string" && alias.trim() !== "") args.push("--alias", alias.trim());
    }
  }

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) { res.status(400).json({ error: result.stderr || "pm schema add-type failed" }); return; }
  res.json(result.parsed || { ok: true, name });
});

/**
 * POST /api/projects/:projectId/pm/items/:itemId/history-repair
 *
 * Re-anchors a drifted item history chain via `pm history-repair <id>`, with
 * `{ dryRun: true }` mapping to `--dry-run` so the health view can preview the
 * impact before writing. Like add-type above, the health view rendered Repair and
 * Dry Run controls against a route that was never mounted.
 */
router.post("/items/:itemId/history-repair", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const itemId = routeParam(req, "itemId").trim();
  if (!itemId) { res.status(400).json({ error: "itemId is required" }); return; }
  if (isFlagLike(itemId)) { res.status(400).json({ error: "itemId must not start with '-'" }); return; }

  const args = ["history-repair", itemId];
  if ((req.body as { dryRun?: unknown } | undefined)?.dryRun === true) args.push("--dry-run");

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) { res.status(400).json({ error: result.stderr || "pm history-repair failed" }); return; }
  res.json(result.parsed || { ok: true, id: itemId });
});

// GET /api/projects/:projectId/pm/list
router.get("/list", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { status, type, limit, priority, sprint, release, assignee, after } = req.query as Record<string, string>;
  const args = ["list"];
  if (status) args.push("--status", status);
  if (type) args.push("--type", type);
  if (limit) args.push("--limit", limit);
  if (priority) args.push("--priority", priority);
  if (sprint) args.push("--sprint", sprint);
  if (release) args.push("--release", release);
  if (assignee) args.push("--assignee", assignee);
  const cursorResult = validateCursor(after);
  if (cursorResult.error) {
    res.status(400).json({ error: cursorResult.error, items: [] });
    return;
  }
  if (cursorResult.cursor) args.push("--after", cursorResult.cursor);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok && result.exitCode === EXIT_CODE.USAGE) {
    res.status(400).json({ error: result.stderr, items: [] });
    return;
  }
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr, items: [] });
});

// GET /api/projects/:projectId/pm/list-all
router.get("/list-all", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { type, limit, after } = req.query as Record<string, string>;
  // Preserve the public HTTP compatibility route while invoking the canonical
  // CLI/SDK command internally. This route is intentionally paginated and is
  // therefore distinct from readCompletePmItems used by whole-corpus views.
  const args = ["list", "--all"];
  if (type) args.push("--type", type);
  if (limit) args.push("--limit", limit);
  const cursorResult = validateCursor(after);
  if (cursorResult.error) {
    res.status(400).json({ error: cursorResult.error, items: [] });
    return;
  }
  if (cursorResult.cursor) args.push("--after", cursorResult.cursor);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok && result.exitCode === EXIT_CODE.USAGE) {
    res.status(400).json({ error: result.stderr, items: [] });
    return;
  }
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr, items: [] });
});

// GET /api/projects/:projectId/pm/board
// Kanban board: items grouped into columns by the workspace's runtime statuses
// (read live from `pm contracts`) so the board matches the installed CLI.
router.get("/board", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const contracts = await runPm({ args: ["contracts", "--json"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  const rt = contracts.ok && contracts.parsed
    ? ((contracts.parsed as Record<string, unknown>)["runtime_schema"] as Record<string, unknown> | undefined)
    : undefined;
  const statuses = Array.isArray(rt?.["statuses"]) ? (rt!["statuses"] as string[]) : [];

  const listed = await readCompletePmItems(project.ownerUserId, project.slug);
  if (!listed.ok) { res.json({ error: listed.stderr, columns: [] }); return; }
  const items = itemsFromCompleteList(listed.result);
  res.json({ columns: boardColumns(items, statuses), statuses, count: items.length });
});

// GET /api/projects/:projectId/pm/search?q=...
// Full-text search over id/title/tags/body via one certified complete read.
router.get("/search", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const query = String((req.query as Record<string, string>)["q"] ?? "");
  const listed = await readCompletePmItems(project.ownerUserId, project.slug, true);
  if (!listed.ok) { res.json({ error: listed.stderr, items: [] }); return; }
  const items = filterItemsByQuery(itemsFromCompleteList(listed.result), query);
  res.json({ query, items, count: items.length });
});

// POST /api/projects/:projectId/pm/create
router.post("/create", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
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

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to create item" });
    return;
  }
  // Broadcast SSE create event
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-created",
    data: { result: result.parsed, userId: req.user!.userId },
  });
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-created");
  res.status(201).json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/get/:itemId
router.get("/get/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["get", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) { res.status(404).json({ error: "Item not found" }); return; }
  res.json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/at/:itemId/:ref
// Point-in-time item view: reconstruct a verified historical item state at a
// one-based version number or ISO timestamp via the pm CLI SDK `getItemAt`
// projection (the same replay kernel that powers `pm get --at`). The read is
// mutation-free and lock-free, so it never interferes with concurrent writers.
//
//   200 — reconstructed item state at the requested ref
//   400 — invalid ref, or version/timestamp outside the available history range
//   404 — unknown item, or item with no recorded history
router.get("/at/:itemId/:ref", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const itemId = routeParam(req, "itemId");
  const ref = routeParam(req, "ref");

  try {
    const result = await runGetItemAt(project.ownerUserId, project.slug, itemId, ref);
    // Mirror the `pm get` envelope so existing clients can reuse the same shape:
    // the reconstructed metadata is exposed as `item` (with `body` inlined),
    // alongside the provenance fields `reconstructed` / `as_of_version` /
    // `as_of_timestamp` / `history_length` and the resolved `target`.
    const item = { ...result.document.metadata, body: result.document.body };
    res.json({
      item,
      reconstructed: result.reconstructed,
      as_of_version: result.as_of_version,
      as_of_timestamp: result.as_of_timestamp,
      history_length: result.history_length,
      target: result.target,
    });
  } catch (err) {
    if (err instanceof PmCliError) {
      if (err.exitCode === EXIT_CODE.NOT_FOUND) {
        res.status(404).json({ error: err.message });
      } else if (err.exitCode === EXIT_CODE.USAGE) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
      return;
    }
    console.error("Point-in-time item read failed:", err);
    res.status(500).json({ error: "Failed to reconstruct historical item state" });
  }
});

// PATCH /api/projects/:projectId/pm/update/:itemId
router.patch("/update/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const body = req.body as Record<string, string>;
  const args = ["update", routeParam(req, "itemId")];
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

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to update item" });
    return;
  }
  // Broadcast SSE update event
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "itemId"), userId: req.user!.userId },
  });
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-updated");
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/close/:itemId
router.post("/close/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { reason } = req.body as { reason?: string };
  if (!reason?.trim()) { res.status(400).json({ error: "Close reason is required" }); return; }

  const result = await runPm({
    args: ["close", routeParam(req, "itemId"), reason.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to close item" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-closed",
    data: { itemId: routeParam(req, "itemId"), userId: req.user!.userId },
  });
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-closed");
  res.json(result.parsed || {});
});

// DELETE /api/projects/:projectId/pm/delete/:itemId
router.delete("/delete/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["delete", routeParam(req, "itemId"), "--yes"],
    userId: project.ownerUserId,
    slug: project.slug,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to delete item" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-deleted",
    data: { itemId: routeParam(req, "itemId"), userId: req.user!.userId },
  });
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-deleted");
  res.json({ ok: true });
});

// POST /api/projects/:projectId/pm/comments/:itemId
router.post("/comments/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Comment text is required" }); return; }

  const result = await runPm({
    args: ["comments", routeParam(req, "itemId"), text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to add comment" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/comments/:itemId
router.get("/comments/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["comments", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { comments: [] });
});

// GET /api/projects/:projectId/pm/notes/:itemId
router.get("/notes/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["notes", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { notes: [] });
});

// POST /api/projects/:projectId/pm/notes/:itemId
router.post("/notes/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Note text is required" }); return; }

  const result = await runPm({
    args: ["notes", routeParam(req, "itemId"), text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to add note" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/context
router.get("/context", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { depth } = req.query as Record<string, string>;
  const validDepths = ["brief", "standard", "deep"];
  const resolvedDepth = validDepths.includes(depth) ? depth : "standard";

  const result = await runPm({
    args: ["context", "--depth", resolvedDepth],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/activity
router.get("/activity", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { limit } = req.query as Record<string, string>;
  const args = ["activity"];
  if (limit) args.push("--limit", limit);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { activity: [] });
});

// GET /api/projects/:projectId/pm/stats
router.get("/stats", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["stats"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/aggregate
router.get("/aggregate", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["aggregate"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/search
router.post("/search", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const body = req.body as Record<string, unknown>;
  const query = typeof body["query"] === "string" ? body["query"] : "";
  const mode = typeof body["mode"] === "string" ? body["mode"] : "";
  if (!query?.trim()) { res.status(400).json({ error: "Search query is required" }); return; }

  const validModes = ["keyword", "semantic", "hybrid"];
  const safeMode = validModes.includes(mode) ? mode : "hybrid";

  // Adopt the sdk/query search-tuning resolvers: read the workspace settings and
  // resolve the bounded max-results, score threshold, and hybrid semantic weight
  // from the same defaults the pm CLI applies. Explicit per-request overrides
  // (limit / minScore / semanticWeight) win over the workspace defaults so the
  // browser can still narrow a page.
  const settings = readPmSettings(project.ownerUserId, project.slug);
  const resolvedLimit = boundedNumber(
    body["limit"],
    resolveSearchMaxResults(settings),
    1,
    500,
    true,
  );
  const resolvedMinScore = boundedNumber(
    body["minScore"],
    resolveSearchScoreThreshold(settings),
    0,
    1_000_000,
  );
  const resolvedSemanticWeight = boundedNumber(
    body["semanticWeight"],
    resolveHybridSemanticWeight(settings),
    0,
    1,
  );

  const cursorResult = validateCursor(body["after"]);
  if (cursorResult.error) {
    res.status(400).json({ error: cursorResult.error, results: [] });
    return;
  }

  const args = ["search", "--mode", safeMode, "--limit", String(resolvedLimit), "--min-score", String(resolvedMinScore), "--semantic-weight", String(resolvedSemanticWeight)];
  if (cursorResult.cursor) args.push("--after", cursorResult.cursor);
  args.push("--", ...query.trim().split(/\s+/));

  const result = await runPm({
    args,
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({
      error: result.stderr || "Search failed. Check that Ollama is reachable and the configured embedding model is available.",
      results: [],
    });
    return;
  }
  res.json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/calendar
router.get("/calendar", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["calendar", "--view", "month"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { events: [] });
});

// GET /api/projects/:projectId/pm/calendar.ics
// RFC 5545 iCalendar feed of item deadlines, for subscribing in Google
// Calendar / Outlook / Apple Calendar. Reads one certified complete corpus.
// Auth works via the usual token (header/cookie) or a
// `?token=` query param, since calendar clients cannot send cookies.
router.get("/calendar.ics", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const listed = await readCompletePmItems(project.ownerUserId, project.slug);
  if (!listed.ok) { res.status(502).json({ error: listed.stderr || "Failed to load items" }); return; }

  const items = itemsFromCompleteList(listed.result)
    .filter((i) => Boolean(i.deadline))
    .map<CalendarItem>((i) => ({
      id: i.id,
      title: i.title,
      type: i.type,
      status: i.status,
      priority: i.priority,
      deadline: i.deadline,
      assignee: i.assignee,
      tags: i.tags,
    }));

  const ics = buildIcsCalendar(items, {
    calendarName: `pm · ${project.slug}`,
    uidDomain: `${project.slug}.pm-web`,
  });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="pm-${project.slug}.ics"`);
  res.setHeader("Cache-Control", "no-cache");
  res.send(ics);
});

// GET /api/projects/:projectId/pm/health
router.get("/health", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["health"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/append/:itemId
router.post("/append/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Text is required" }); return; }

  const result = await runPm({
    args: ["append", routeParam(req, "itemId"), text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to append" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-appended");
  res.json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/history/:itemId
router.get("/history/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["history", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { history: [] });
});

// GET /api/projects/:projectId/pm/deps/:itemId
router.get("/deps/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["deps", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { deps: [] });
});

// POST /api/projects/:projectId/pm/deps/:itemId
router.post("/deps/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { targetId, rel } = req.body as { targetId?: string; rel?: string };
  if (!targetId?.trim()) { res.status(400).json({ error: "targetId is required" }); return; }

  const depRel = normalizeDependencyKind(rel);
  const result = await runPm({
    args: ["update", routeParam(req, "itemId"), "--dep", `id=${targetId.trim()},kind=${depRel}`],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to add dependency" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "dependency-added");
  broadcastDependencyEvent(routeParam(req, "projectId"), "dependency-added", {
    from: routeParam(req, "itemId"),
    to: targetId.trim(),
    rel: depRel,
    userId: req.user!.userId,
  });
  res.status(201).json(result.parsed || { ok: true });
});

// DELETE /api/projects/:projectId/pm/deps/:itemId
router.delete("/deps/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { targetId, rel } = req.body as { targetId?: string; rel?: string };
  if (!targetId?.trim()) { res.status(400).json({ error: "targetId is required" }); return; }

  const depRel = normalizeDependencyKind(rel || "relates_to");
  const selector = `id=${targetId.trim()},kind=${depRel}`;
  const result = await runPm({
    args: ["update", routeParam(req, "itemId"), "--dep-remove", selector],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to remove dependency" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "dependency-removed");
  broadcastDependencyEvent(routeParam(req, "projectId"), "dependency-removed", {
    from: routeParam(req, "itemId"),
    to: targetId.trim(),
    rel: depRel,
    userId: req.user!.userId,
  });
  res.status(200).json({ ok: true, from: routeParam(req, "itemId"), to: targetId.trim(), type: depRel, result: result.parsed || null });
});

// POST /api/projects/:projectId/pm/rel — Create a relationship between two items
router.post("/rel", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { from, to, type: relType } = req.body as { from?: string; to?: string; type?: string };
  if (!from?.trim() || !to?.trim()) {
    res.status(400).json({ error: "from and to item IDs are required" });
    return;
  }
  const depRel = normalizeDependencyKind(relType || "relates_to");
  const result = await runPm({
    args: ["update", from.trim(), "--dep", `id=${to.trim()},kind=${depRel}`],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to create relationship" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "rel-created");
  broadcastDependencyEvent(routeParam(req, "projectId"), "dependency-added", {
    from: from.trim(),
    to: to.trim(),
    rel: depRel,
    userId: req.user!.userId,
  });
  res.status(201).json({ ok: true, from: from.trim(), to: to.trim(), type: depRel });
});

// DELETE /api/projects/:projectId/pm/rel — Remove a relationship between two items
router.delete("/rel", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { from, to, type: relType } = req.body as { from?: string; to?: string; type?: string };
  if (!from?.trim() || !to?.trim()) {
    res.status(400).json({ error: "from and to item IDs are required" });
    return;
  }
  const depRel = normalizeDependencyKind(relType || "relates_to");
  const selector = `id=${to.trim()},kind=${depRel}`;
  const result = await runPm({
    args: ["update", from.trim(), "--dep-remove", selector, "--message", `Remove ${depRel} dependency on ${to.trim()}`],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to remove relationship" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "rel-removed");
  broadcastDependencyEvent(routeParam(req, "projectId"), "dependency-removed", {
    from: from.trim(),
    to: to.trim(),
    rel: depRel,
    userId: req.user!.userId,
  });
  res.json({ ok: true, from: from.trim(), to: to.trim(), type: depRel, result: result.parsed || null });
});

// GET /api/projects/:projectId/pm/graph
router.get("/graph", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const extensionGraph = await pmGraphExtensionGraphForProject(project);
  if (extensionGraph.graph) {
    res.json({
      ok: true,
      graph: extensionGraph.graph,
      extensionAvailable: true,
    });
    return;
  }

  try {
    res.json({
      ok: true,
      graph: await fallbackGraphForProject(project.ownerUserId, project.slug),
      extensionAvailable: false,
      extensionError: extensionGraph.error,
    });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/projects/:projectId/pm/graph/sync
router.post("/graph/sync", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  try {
    const syncResult = await syncProjectGraph(project);
    const payload = { reason: "manual-sync", ...syncResult, projectKey: graphProjectKey(project), source: "pm-web" };
    broadcastProjectEvent(routeParam(req, "projectId"), {
      type: "graph-synced",
      data: payload,
    });
    res.json({ ok: true, ...payload });
  } catch (err: unknown) {
    broadcastProjectEvent(routeParam(req, "projectId"), {
      type: "graph-sync-failed",
      data: {
        reason: "manual-sync",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    broadcastProjectEvent(routeParam(req, "projectId"), {
      type: "graph_sync_failed",
      data: {
        reason: "manual-sync",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Graph sync failed." });
  }
});

// GET /api/projects/:projectId/pm/graph/neighbors/:nodeId
router.get("/graph/neighbors/:nodeId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const nodeId = routeParam(req, "nodeId");
  if (!nodeId) { res.status(400).json({ error: "nodeId is required" }); return; }

  const result = await runPm({
    args: ["pm-graph", "neighbors", nodeId, "--json"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: false,
  });

  if (!result.ok) {
    // Extension not available — return empty neighbors
    res.json({ ok: true, center: null, neighbors: [], extensionAvailable: false, error: result.stderr || "pm-graph extension not available" });
    return;
  }

  try {
    const parsed = result.stdout ? JSON.parse(result.stdout) as unknown : null;
    res.json({ ok: true, ...(parsed as Record<string, unknown>), extensionAvailable: true });
  } catch {
    res.json({ ok: true, center: null, neighbors: [], extensionAvailable: false, error: "pm-graph neighbors returned invalid JSON" });
  }
});

// POST /api/projects/:projectId/pm/graph/query
router.post("/graph/query", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { cypher } = req.body as { cypher?: string };
  if (!cypher?.trim()) { res.status(400).json({ error: "cypher query is required" }); return; }

  const result = await runPm({
    args: ["pm-graph", "query", cypher.trim(), "--json"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: false,
  });

  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "pm-graph query failed — ensure Neo4j is configured and pm-graph extension is installed" });
    return;
  }

  try {
    const parsed = result.stdout ? JSON.parse(result.stdout) as unknown : { ok: true, records: [] };
    res.json(parsed);
  } catch {
    res.status(500).json({ error: "pm-graph query returned invalid JSON" });
  }
});

// GET /api/projects/:projectId/pm/learnings/:itemId
router.get("/learnings/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["learnings", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { learnings: [] });
});

// POST /api/projects/:projectId/pm/learnings/:itemId
router.post("/learnings/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "Learning text is required" }); return; }

  const result = await runPm({
    args: ["learnings", routeParam(req, "itemId"), text.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to add learning" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/claim/:itemId
router.post("/claim/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["claim", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to claim item" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-claimed");
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/release/:itemId
router.post("/release/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["release", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to release item" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-released");
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/start-task/:itemId
router.post("/start-task/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["start-task", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to start task" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "task-started");
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/pause-task/:itemId
router.post("/pause-task/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["pause-task", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to pause task" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "task-paused");
  res.json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/tests/:itemId
router.get("/tests/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["test", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { tests: [] });
});

// POST /api/projects/:projectId/pm/tests/:itemId
router.post("/tests/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { command, description } = req.body as { command?: string; description?: string };
  if (!command?.trim()) { res.status(400).json({ error: "Test command is required" }); return; }

  const args = ["test", routeParam(req, "itemId"), "--add", "--command", command.trim()];
  if (description) args.push("--description", description.trim());

  const result = await runPm({
    args,
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to add test" });
    return;
  }
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/dedupe-audit
router.get("/dedupe-audit", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["dedupe-audit"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { duplicates: [] });
});

// GET /api/projects/:projectId/pm/validate
router.get("/validate", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["validate"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/restore/:itemId
router.post("/restore/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { target } = req.body as { target?: string };
  if (!target?.trim()) { res.status(400).json({ error: "Restore target (timestamp or version) is required" }); return; }
  const result = await runPm({
    args: ["restore", routeParam(req, "itemId"), target.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to restore item" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "item-restored");
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/close-task/:itemId
router.post("/close-task/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { reason } = req.body as { reason?: string };
  if (!reason?.trim()) { res.status(400).json({ error: "Close reason is required" }); return; }

  const result = await runPm({
    args: ["close-task", routeParam(req, "itemId"), reason.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to close task" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "task-closed");
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/reindex
router.post("/reindex", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { mode = "keyword" } = req.body as { mode?: string };
  const validModes = ["keyword", "semantic", "hybrid"];
  const safeMode = validModes.includes(mode) ? mode : "keyword";
  const result = await runPm({
    args: ["reindex", "--mode", safeMode],
    userId: project.ownerUserId,
    slug: project.slug,
  });
  if (!result.ok) {
    res.status(400).json({
      error: result.stderr || "Reindex failed. Check that Ollama is reachable and the configured embedding model is available.",
    });
    return;
  }
  res.json({ ok: true, mode: safeMode });
});

// POST /api/projects/:projectId/pm/normalize
router.post("/normalize", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["normalize"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/comments-audit
router.get("/comments-audit", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["comments-audit"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// POST /api/projects/:projectId/pm/files/:itemId
router.post("/files/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { path: filePath, scope } = req.body as { path?: string; scope?: string };
  if (!filePath?.trim()) { res.status(400).json({ error: "File path is required" }); return; }
  let addVal = `path=${filePath.trim()}`;
  if (scope) addVal += `,scope=${scope}`;
  const args = ["files", routeParam(req, "itemId"), "--add", addVal];
  const result = await runPm({
    args,
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to link file" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "file-linked");
  res.status(201).json(result.parsed || { ok: true });
});

// GET /api/projects/:projectId/pm/files/:itemId
router.get("/files/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["files", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { files: [] });
});

// GET /api/projects/:projectId/pm/guide — list guide topics
router.get("/guide", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["guide"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/guide/:topicId — get single guide topic
router.get("/guide/:topicId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["guide", routeParam(req, "topicId")],
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

// GET /api/projects/:projectId/pm/export?format=json|csv|yaml
router.get("/export", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const format = (req.query["format"] as string) || "json";
  const result = await readCompletePmItems(project.ownerUserId, project.slug, true);

  if (!result.ok) {
    res.status(500).json({ error: result.stderr || "Export failed" });
    return;
  }

  const data = result.result;
  const exportedAt = new Date().toISOString();

  if (format === "csv") {
    const items = data?.items ?? [];
    const rows = items as Record<string, unknown>[];
    if (rows.length === 0) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${project.slug}-export.csv"`);
      res.send("");
      return;
    }
    const headers = ["id", "title", "description", "type", "status", "priority", "tags", "assignee", "sprint", "release", "deadline", "parent", "estimate", "body", "created_at", "updated_at"];
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
  } else if (format === "yaml") {
    const items = (data?.items ?? []) as Record<string, unknown>[];
    // Simple YAML serializer for this data shape
    function yamlEscape(v: unknown, indent: number): string {
      const pad = "  ".repeat(indent);
      if (v === null || v === undefined) return "null";
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "number") return String(v);
      if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        return "\n" + v.map((item) => `${pad}- ${yamlEscape(item, indent + 1)}`).join("\n");
      }
      if (typeof v === "object") {
        const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== null && val !== undefined);
        if (entries.length === 0) return "{}";
        return "\n" + entries.map(([k, val]) => {
          const valStr = yamlEscape(val, indent + 1);
          return valStr.startsWith("\n") ? `${pad}${k}:${valStr}` : `${pad}${k}: ${valStr}`;
        }).join("\n");
      }
      const str = String(v);
      if (str.includes("\n") || str.includes(":") || str.includes("#") || str.includes('"') || str.startsWith(" ") || str.endsWith(" ")) {
        return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
      }
      return str || '""';
    }
    const yamlItems = items.map((item) => {
      const fields = Object.keys(item).filter((k) => item[k] !== null && item[k] !== undefined && item[k] !== "");
      const lines = fields.map((f) => {
        const valStr = yamlEscape(item[f], 1);
        return valStr.startsWith("\n") ? `  ${f}:${valStr}` : `  ${f}: ${valStr}`;
      });
      return "- " + lines.join("\n").trimStart();
    });
    const header = `# pm-web export\n# project: ${project.slug}\n# exported_at: ${exportedAt}\n# version: "2.0"\nitems:\n`;
    res.setHeader("Content-Type", "text/yaml");
    res.setHeader("Content-Disposition", `attachment; filename="${project.slug}-export.yaml"`);
    res.send(header + yamlItems.join("\n"));
  } else {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${project.slug}-export.json"`);
    res.json({ exportedAt, project: project.slug, version: "2.0", items: data?.items ?? [] });
  }
});

// POST /api/projects/:projectId/pm/import — import JSON items
router.post("/import", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
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

    const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
    if (result.ok && result.parsed) {
      // `pm create --json` (and the in-process SDK dispatcher) return the flat
      // envelope { id, status, changed_field_count } — no `item` wrapper.
      const parsed = result.parsed as { id?: string };
      created.push(parsed.id || `item[${i}]`);
    } else {
      errors.push(`item[${i}]: ${result.stderr || "create failed"}`);
    }
  }

  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "items-imported",
    data: { count: created.length, userId: req.user!.userId },
  });
  if (created.length > 0) scheduleGraphSync(routeParam(req, "projectId"), project, "items-imported");
  res.json({ created, errors, total: items.length });
});

// POST /api/projects/:projectId/pm/update-many
router.post("/update-many", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
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

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "update-many failed" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "items-bulk-updated",
    data: { userId: req.user!.userId },
  });
  scheduleGraphSync(routeParam(req, "projectId"), project, "items-bulk-updated");
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/close-many
// Bulk-close items matching filter criteria using pm close <id> <reason> for each matched item.
// Accepts same filter options as update-many plus a required `reason` field.
// Returns { closed_count, failed_count, skipped_count, rows }.
router.post("/close-many", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const body = req.body as Record<string, string>;
  const reason = body.reason?.trim();
  if (!reason) { res.status(400).json({ error: "A close reason is required" }); return; }

  const targetStatus: string = body.targetStatus === "canceled" ? "canceled" : "closed";

  // First, use update-many --dry-run to get the list of matched items
  const listArgs = ["update-many", "--dry-run", "--status", "open"];
  const filterFlags: Record<string, string> = {
    filterStatus: "--filter-status", filterType: "--filter-type",
    filterTag: "--filter-tag", filterPriority: "--filter-priority",
    filterAssignee: "--filter-assignee", filterParent: "--filter-parent",
    filterSprint: "--filter-sprint", filterRelease: "--filter-release",
    limit: "--limit",
  };
  for (const [key, flag] of Object.entries(filterFlags)) {
    if (body[key]) listArgs.push(flag, body[key]!);
  }

  const listResult = await runPm({ args: listArgs, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!listResult.ok) {
    res.status(pmErrorStatus(listResult)).json({ error: listResult.stderr || "Failed to list items for close-many" });
    return;
  }

  const parsed = listResult.parsed as Record<string, unknown> | null;
  const itemPlans = Array.isArray(parsed?.["item_plans"]) ? (parsed!["item_plans"] as Array<{ id: string }>) : [];
  const matchedIds = itemPlans.map((p) => p.id).filter(Boolean);

  if (matchedIds.length === 0) {
    res.json({ closed_count: 0, failed_count: 0, skipped_count: 0, rows: [], matched_count: 0 });
    return;
  }

  // Close (or cancel) each matched item individually
  const rows: Array<{ id: string; status: "ok" | "failed"; error?: string }> = [];
  let closedCount = 0;
  let failedCount = 0;

  for (const itemId of matchedIds) {
    const closeArgs = targetStatus === "canceled"
      ? ["update", itemId, "--status", "canceled"]
      : ["close", itemId, reason];
    const closeResult = await runPm({ args: closeArgs, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
    if (closeResult.ok) {
      rows.push({ id: itemId, status: "ok" });
      closedCount++;
    } else {
      rows.push({ id: itemId, status: "failed", error: closeResult.stderr || "close failed" });
      failedCount++;
    }
  }

  if (closedCount > 0) {
    broadcastProjectEvent(routeParam(req, "projectId"), {
      type: "items-bulk-updated",
      data: { userId: req.user!.userId },
    });
    scheduleGraphSync(routeParam(req, "projectId"), project, "items-bulk-updated");
  }

  res.json({
    closed_count: closedCount,
    failed_count: failedCount,
    skipped_count: 0,
    matched_count: matchedIds.length,
    rows,
  });
});

// GET /api/projects/:projectId/pm/docs/:itemId
router.get("/docs/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({
    args: ["docs", routeParam(req, "itemId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || {}) : { docs: [] });
});

// POST /api/projects/:projectId/pm/docs/:itemId
router.post("/docs/:itemId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { path: docPath, scope, note, remove, validatePaths } = req.body as Record<string, string>;
  const args = ["docs", routeParam(req, "itemId")];
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
  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to update docs" });
    return;
  }
  scheduleGraphSync(routeParam(req, "projectId"), project, "docs-updated");
  res.json(result.parsed || { ok: true });
});

// POST /api/projects/:projectId/pm/test-all
router.post("/test-all", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const body = req.body as Record<string, string>;
  const args = ["test-all"];
  if (body.status) args.push("--status", body.status);
  if (body.limit) args.push("--limit", body.limit);
  if (body.timeout) args.push("--timeout", body.timeout);
  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "test-all failed" });
    return;
  }
  res.json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/test-runs
router.get("/test-runs", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { status, limit } = req.query as Record<string, string>;
  const args = ["test-runs", "list"];
  if (status) args.push("--status", status);
  if (limit) args.push("--limit", limit);
  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { runs: [] });
});

// POST /api/projects/:projectId/pm/gc
router.post("/gc", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({ args: ["gc"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/templates
router.get("/templates", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({ args: ["templates", "list"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { templates: [] });
});

// GET /api/projects/:projectId/pm/templates/:name
router.get("/templates/:name", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({ args: ["templates", "show", routeParam(req, "name")], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/config
router.get("/config", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const result = await runPm({ args: ["config", "project", "list"], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// GET /api/projects/:projectId/pm/config/:key
router.get("/config/:key", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const key = routeParam(req, "key");
  const result = await runPm({ args: ["config", "project", "get", key], userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// PATCH /api/projects/:projectId/pm/config/:key
router.patch("/config/:key", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const key = routeParam(req, "key");
  const body = req.body as Record<string, string>;
  const args = ["config", "project", "set", key];
  if (body.value) args.push(body.value);
  if (body.policy) args.push("--policy", body.policy);
  if (body.format) args.push("--format", body.format);
  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  res.json(result.ok ? (result.parsed || {}) : { error: result.stderr });
});

// ─── List status shortcut routes ───
// These wrap pm list-draft, list-open, etc.
/**
 * Build an Express handler for a fixed list-shortcut command (e.g. `list-open`).
 *
 * Returns a route that verifies the project, forwards the supported list query
 * filters (`type`, `limit`, `offset`, `tag`, `priority`, `assignee`, `sprint`,
 * `release`) and the validated `after` cursor to `pm <pmCommand> --json`, and
 * responds with the parsed result. A USAGE failure becomes a 400; any other
 * failure yields an empty `items` array rather than an error.
 *
 * @param pmCommand - The pm list subcommand to invoke.
 * @returns An async Express route handler.
 */
function buildListShortcutRoute(pmCommand: string) {
  return async (req: AuthRequest, res: Response) => {
    const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    const { type, limit, offset, tag, priority, assignee, sprint, release, after } = req.query as Record<string, string>;
    const args = [pmCommand];
    if (type) args.push("--type", type);
    if (limit) args.push("--limit", limit);
    if (offset) args.push("--offset", offset);
    if (tag) args.push("--tag", tag);
    if (priority) args.push("--priority", priority);
    if (assignee) args.push("--assignee", assignee);
    if (sprint) args.push("--sprint", sprint);
    if (release) args.push("--release", release);
    const cursorResult = validateCursor(after);
    if (cursorResult.error) {
      res.status(400).json({ error: cursorResult.error, items: [] });
      return;
    }
    if (cursorResult.cursor) args.push("--after", cursorResult.cursor);
    const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
    if (!result.ok && result.exitCode === EXIT_CODE.USAGE) {
      res.status(400).json({ error: result.stderr, items: [] });
      return;
    }
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

// ─────────────────────────────────────────────────────────
// Plan routes
// ─────────────────────────────────────────────────────────

// POST /api/projects/:projectId/pm/plan
router.post("/plan", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { title, description, scope, tags, priority, body } = req.body as Record<string, string>;
  if (!title?.trim()) { res.status(400).json({ error: "Title is required" }); return; }

  const args = ["plan", "create", "--title", title.trim()];
  if (description) args.push("--description", description);
  if (scope) args.push("--scope", scope);
  if (tags) args.push("--tags", tags);
  if (priority) args.push("--priority", priority);
  if (body) args.push("--body", body);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to create plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-created",
    data: { result: result.parsed, userId: req.user!.userId },
  });
  res.status(201).json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/plan/:planId
router.get("/plan/:planId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["plan", "show", routeParam(req, "planId"), "--depth", "standard"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) { res.status(404).json({ error: result.stderr || "Plan not found" }); return; }
  res.json(result.parsed || {});
});

// PATCH /api/projects/:projectId/pm/plan/:planId
router.patch("/plan/:planId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { title, description } = req.body as Record<string, string>;
  const args = ["update", routeParam(req, "planId")];
  if (title?.trim()) args.push("--title", title.trim());
  if (description !== undefined) args.push("--description", description);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to update plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// DELETE /api/projects/:projectId/pm/plan/:planId
router.delete("/plan/:planId", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["delete", routeParam(req, "planId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to delete plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-deleted",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json({ ok: true });
});

// POST /api/projects/:projectId/pm/plan/:planId/steps
router.post("/plan/:planId/steps", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { title, description, dependsOn } = req.body as Record<string, string>;
  if (!title?.trim()) { res.status(400).json({ error: "Title is required" }); return; }

  const args = ["plan", "add-step", routeParam(req, "planId"), "--title", title.trim()];
  if (description) args.push("--description", description);
  if (dependsOn) args.push("--depends-on", dependsOn);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to add step" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.status(201).json(result.parsed || {});
});

// PATCH /api/projects/:projectId/pm/plan/:planId/steps/:stepRef
router.patch("/plan/:planId/steps/:stepRef", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { title, description } = req.body as Record<string, string>;
  const args = ["plan", "update-step", routeParam(req, "planId"), routeParam(req, "stepRef")];
  if (title) args.push("--title", title);
  if (description) args.push("--description", description);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to update step" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/plan/:planId/steps/:stepRef/complete
router.post("/plan/:planId/steps/:stepRef/complete", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["plan", "complete-step", routeParam(req, "planId"), routeParam(req, "stepRef")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to complete step" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/plan/:planId/steps/:stepRef/block
router.post("/plan/:planId/steps/:stepRef/block", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { reason } = req.body as { reason?: string };
  if (!reason?.trim()) { res.status(400).json({ error: "Block reason is required" }); return; }

  const result = await runPm({
    args: ["plan", "block-step", routeParam(req, "planId"), routeParam(req, "stepRef"), "--step-blocked-reason", reason.trim()],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to block step" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// DELETE /api/projects/:projectId/pm/plan/:planId/steps/:stepRef
router.delete("/plan/:planId/steps/:stepRef", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["plan", "remove-step", routeParam(req, "planId"), routeParam(req, "stepRef")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to remove step" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/plan/:planId/approve
router.post("/plan/:planId/approve", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["plan", "approve", routeParam(req, "planId")],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to approve plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/plan/:planId/materialize
router.post("/plan/:planId/materialize", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { materializeType, materializeParent, steps } = req.body as Record<string, string>;
  const args = ["plan", "materialize", routeParam(req, "planId")];
  if (materializeType) args.push("--materialize-type", materializeType);
  if (materializeParent) args.push("--materialize-parent", materializeParent);
  if (steps) args.push("--steps", steps);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to materialize plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-created",
    data: { result: result.parsed, userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/plan/:planId/steps/:stepRef/reorder
router.post("/plan/:planId/steps/:stepRef/reorder", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { reorderTo } = req.body as { reorderTo?: string | number };
  if (reorderTo === undefined || reorderTo === null || reorderTo === "") {
    res.status(400).json({ error: "reorderTo (new order integer) is required" });
    return;
  }

  const result = await runPm({
    args: ["plan", "reorder-step", routeParam(req, "planId"), routeParam(req, "stepRef"), String(reorderTo)],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to reorder step" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// POST /api/projects/:projectId/pm/plan/:planId/link
router.post("/plan/:planId/link", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { link, linkKind, linkNote, promoteToItemDep } = req.body as Record<string, string>;
  if (!link?.trim()) { res.status(400).json({ error: "link (item id) is required" }); return; }

  const args = ["plan", "link", routeParam(req, "planId"), "--link", link.trim()];
  if (linkKind) args.push("--link-kind", linkKind);
  if (linkNote) args.push("--link-note", linkNote);
  if (promoteToItemDep === "true") args.push("--promote-to-item-dep");

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to link plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.status(201).json(result.parsed || {});
});

// DELETE /api/projects/:projectId/pm/plan/:planId/link
router.delete("/plan/:planId/link", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { link, linkKind } = req.body as Record<string, string>;
  if (!link?.trim()) { res.status(400).json({ error: "link (item id) is required" }); return; }

  const args = ["plan", "unlink", routeParam(req, "planId"), "--link", link.trim()];
  if (linkKind) args.push("--link-kind", linkKind);

  const result = await runPm({ args, userId: project.ownerUserId, slug: project.slug, jsonOutput: true });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Failed to unlink plan" });
    return;
  }
  broadcastProjectEvent(routeParam(req, "projectId"), {
    type: "item-updated",
    data: { itemId: routeParam(req, "planId"), userId: req.user!.userId },
  });
  res.json(result.parsed || {});
});

// GET /api/projects/:projectId/pm/upgrade
// Returns a dry-run preview of what upgrade would do (safe, read-only).
// POST /api/projects/:projectId/pm/upgrade
// Runs pm upgrade --packages-only (never upgrades the CLI itself via the web UI).
router.get("/upgrade", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const result = await runPm({
    args: ["upgrade", "--dry-run", "--packages-only"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  res.json(result.ok ? (result.parsed || { dryRun: true }) : { error: result.stderr });
});

router.post("/upgrade", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  // Only allow package upgrades from the web UI — never self-upgrade the CLI binary.
  const result = await runPm({
    args: ["upgrade", "--packages-only"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(pmErrorStatus(result)).json({ error: result.stderr || "Upgrade failed" });
    return;
  }
  res.json(result.parsed || { ok: true });
});

// PATCH /api/projects/:projectId/pm/presence/:clientId
router.patch("/presence/:clientId", async (req: AuthRequest, res) => {
  const projectId = routeParam(req, "projectId");
  const access = await verifyProjectAccess(req.user!.userId, projectId);
  if (!access) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const { clientId } = req.params as { clientId: string };
  const { view } = req.body as { view?: string };
  if (!view || !/^[a-z][a-z0-9-]{0,63}$/.test(view)) {
    res.status(400).json({ error: "Invalid view" });
    return;
  }
  const updated = updateClientView(clientId, req.user!.userId, projectId, view);
  if (!updated) {
    res.status(404).json({ error: "Presence session not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── SSE endpoint ───
// GET /api/projects/:projectId/pm/events
router.get("/events", async (req: AuthRequest, res) => {
  try {
    const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  } catch (err) {
    console.error("SSE project verification failed:", err);
    res.status(500).json({ error: "Failed to verify project for real-time sync" });
    return;
  }

  const clientId = uuidv4();
  const projectId = routeParam(req, "projectId");
  const userId = req.user!.userId;
  let displayName: string;
  try {
    const userResult = await pool.query<{ display_name: string | null }>(
      "SELECT display_name FROM pm_users WHERE id = $1",
      [userId],
    );
    displayName = userResult.rows[0]?.display_name?.trim() || "Project member";
  } catch (error) {
    console.error("SSE presence lookup failed", error instanceof Error ? error.name : typeof error);
    res.status(500).json({ error: "Failed to initialize real-time presence" });
    return;
  }
  const currentView = String(req.query["view"] ?? "items");

  setupSSEHeaders(res);

  const unsubscribe = addSSEClient({
    id: clientId,
    projectId,
    userId,
    displayName,
    currentView,
    res,
    connectedAt: new Date(),
  });

  // Heartbeat every 30s to keep connection alive and refresh presence
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

// ─── Presence endpoint ───
// GET /api/projects/:projectId/pm/presence
router.get("/presence", async (req: AuthRequest, res) => {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const users = getProjectPresence(routeParam(req, "projectId"));
  res.json({ users });
});

export { router as pmRouter };
