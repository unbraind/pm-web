// ═══════════════════════════════════════════════════════════════
// EXTENSIONS ROUTES — per-project pm package catalog management
// ═══════════════════════════════════════════════════════════════
//
// pm-web used to support exactly one pm package — a vendored copy of pm-graph —
// and offered no way to install any other. These routes expose the full pm
// package catalog (src/services/package-catalog.ts) joined with the live
// per-project state from `pm extension --json`, and let a user install,
// activate, deactivate, and uninstall packages for a project.
//
// SECURITY-CRITICAL: every `:name` route parameter is validated against the
// catalog BEFORE it is passed to any pm command. A catalog lookup miss must
// 400 before any process spawn — a user-supplied string can never be
// interpolated into an install target. The install target is the matched
// entry's own `npmSpec` constant, so the spawn argument always comes from the
// catalog, never from the raw request string.
//
// The router is mounted under the same project-scoped path as the pm router
// (`/api/projects/:projectId/extensions`), so `:projectId` is available via
// Express mergeParams. Authorization mirrors src/routes/pm.ts: a user must own
// or be shared on the project; one user can never touch another user's
// project. Every successful mutation publishes on the existing realtime bus
// (src/services/sse.ts) so all collaborators on the project see the change
// live — consistent with how item mutations already broadcast.

import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.ts";
import { verifyProjectAccess } from "./projects.ts";
import { routeParam } from "./route-params.ts";
import {
  INSTALL_COMMAND_TIMEOUT_MS,
  readProjectExtensionStates,
  runPm,
  getProjectDir,
  type ExtensionState,
} from "../services/pm-runner.ts";
import {
  PACKAGE_CATALOG,
  findCatalogEntry,
  type PackageCatalogEntry,
} from "../services/package-catalog.ts";
import { broadcastProjectEvent } from "../services/sse.ts";

const router = Router({ mergeParams: true });
router.use(requireAuth);

/**
 * Resolve and validate `:name` against the catalog exactly once per request.
 *
 * SECURITY GATE. Express runs a `router.param` callback before any matching
 * route handler, so a mutation route physically cannot run without the
 * validated entry — the previous per-handler lookup relied on every future
 * route remembering to repeat it, and a route that forgot would pass an
 * unvalidated string toward a process spawn.
 *
 * The resolved entry is stashed on the response so handlers read a catalog
 * constant rather than the request string.
 */
router.param("name", (req, res, next, value: string) => {
  const entry = findCatalogEntry(value);
  if (!entry) {
    res.status(400).json({ error: `Unknown package: ${value}` });
    return;
  }
  res.locals.catalogEntry = entry;
  next();
});

/** The catalog entry resolved by the `:name` param gate above. */
function catalogEntry(res: Response): PackageCatalogEntry {
  return res.locals.catalogEntry as PackageCatalogEntry;
}

/** The realtime event type broadcast on every successful extension mutation. */
export const EXTENSIONS_CHANGED_EVENT = "extensions-changed";

interface ProjectRef {
  slug: string;
  prefix: string;
  ownerUserId: string;
  /** `"edit"` or `"view"` — the caller's permission on this project. */
  permission: string;
}

/** Verify project access (owner or shared) and return the pm-runner ref. */
async function verifyProject(
  userId: string,
  projectId: string,
): Promise<ProjectRef | null> {
  const access = await verifyProjectAccess(userId, projectId);
  if (!access) return null;
  return {
    slug: access.slug,
    prefix: access.prefix,
    ownerUserId: access.ownerUserId,
    permission: access.permission,
  };
}

/**
 * Resolve the project for a mutating request, enforcing edit permission.
 *
 * Installing, activating, or removing a package changes the workspace for
 * *every* collaborator, so it is an edit-level action. Sharing grants either
 * `"view"` or `"edit"`; without this check a view-only collaborator could
 * install or uninstall packages on someone else's project. Mirrors the
 * guard `routes/pm.ts` applies to item mutations.
 *
 * Responds and returns `null` when access is denied, so callers `return`
 * immediately on a null result.
 */
async function requireEditableProject(
  req: AuthRequest,
  res: Response,
): Promise<ProjectRef | null> {
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  if (project.permission !== "edit") {
    res.status(403).json({ error: "This project is shared as view-only." });
    return null;
  }
  return project;
}

/** The catalog entry joined with its live per-project state, for the GET list. */
export interface PackageCatalogRow extends PackageCatalogEntry {
  installed: boolean;
  version: string | null;
  active: boolean;
  enabled: boolean;
  runtimeActive: boolean;
  activationStatus: string | null;
  managed: boolean;
  sourceKind: string | null;
}

function toRow(
  entry: PackageCatalogEntry,
  state: ExtensionState | undefined,
): PackageCatalogRow {
  return {
    ...entry,
    installed: Boolean(state),
    version: state?.version ?? null,
    active: Boolean(state?.active),
    enabled: Boolean(state?.enabled),
    runtimeActive: Boolean(state?.runtime_active),
    activationStatus: state?.activation_status ?? null,
    managed: Boolean(state?.managed),
    sourceKind: state?.source?.kind ?? null,
  };
}

/** Broadcast an extensions-changed event to all project collaborators. */
function broadcastExtensionsChanged(projectId: string, userId: string, name: string, operation: string): void {
  broadcastProjectEvent(projectId, {
    type: EXTENSIONS_CHANGED_EVENT,
    data: { userId, name, operation },
  });
}

// GET /api/projects/:projectId/extensions
// Catalog joined with live `pm extension --json` state.
router.get("/", async (req: AuthRequest, res) => {
  // Read-only: a view-only collaborator may see which packages a project uses,
  // they just cannot change them.
  const project = await verifyProject(req.user!.userId, routeParam(req, "projectId"));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const { ok, states, error } = await readProjectExtensionStates(
    getProjectDir(project.ownerUserId, project.slug),
  );
  const rows = PACKAGE_CATALOG.map((entry) => toRow(entry, states.get(entry.name)));
  // Surface a failed read rather than rendering every package as "not
  // installed", which is indistinguishable from a healthy empty project.
  res.json(ok ? { packages: rows } : { packages: rows, stateError: error });
});

// POST /api/projects/:projectId/extensions/:name/install
router.post("/:name/install", async (req: AuthRequest, res) => {
  const project = await requireEditableProject(req, res);
  if (!project) return;
  const entry = catalogEntry(res);
  // An unreleased package is catalogued so the UI can show it honestly, but no
  // install spec resolves for it. Refuse here with a reason rather than
  // spawning a `pm install` that would fail against the registry with an
  // opaque 404 the user cannot act on.
  if (entry.availability === "unreleased") {
    res.status(409).json({
      error: `${entry.name} is not published to npm yet, so it cannot be installed.`,
    });
    return;
  }
  const result = await runPm({
    // entry.npmSpec is a catalog constant, never the request string.
    args: ["install", entry.npmSpec, "--project"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
    // Installs resolve and download from the npm registry; the 30s default is
    // sized for local commands and leaves too thin a margin for a cold cache.
    timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || `Failed to install ${entry.name}` });
    return;
  }
  broadcastExtensionsChanged(routeParam(req, "projectId"), req.user!.userId, entry.name, "install");
  res.status(201).json(result.parsed || { ok: true, name: entry.name });
});

// POST /api/projects/:projectId/extensions/:name/activate
router.post("/:name/activate", async (req: AuthRequest, res) => {
  const project = await requireEditableProject(req, res);
  if (!project) return;
  const entry = catalogEntry(res);
  const result = await runPm({
    args: ["extension", "activate", entry.name, "--project"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || `Failed to activate ${entry.name}` });
    return;
  }
  broadcastExtensionsChanged(routeParam(req, "projectId"), req.user!.userId, entry.name, "activate");
  res.json(result.parsed || { ok: true, name: entry.name });
});

// POST /api/projects/:projectId/extensions/:name/deactivate
router.post("/:name/deactivate", async (req: AuthRequest, res) => {
  const project = await requireEditableProject(req, res);
  if (!project) return;
  const entry = catalogEntry(res);
  const result = await runPm({
    args: ["extension", "deactivate", entry.name, "--project"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || `Failed to deactivate ${entry.name}` });
    return;
  }
  broadcastExtensionsChanged(routeParam(req, "projectId"), req.user!.userId, entry.name, "deactivate");
  res.json(result.parsed || { ok: true, name: entry.name });
});

// DELETE /api/projects/:projectId/extensions/:name
router.delete("/:name", async (req: AuthRequest, res) => {
  const project = await requireEditableProject(req, res);
  if (!project) return;
  const entry = catalogEntry(res);
  const result = await runPm({
    args: ["extension", "uninstall", entry.name, "--project"],
    userId: project.ownerUserId,
    slug: project.slug,
    jsonOutput: true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.stderr || `Failed to uninstall ${entry.name}` });
    return;
  }
  broadcastExtensionsChanged(routeParam(req, "projectId"), req.user!.userId, entry.name, "uninstall");
  res.json(result.parsed || { ok: true, name: entry.name });
});

export { router as extensionsRouter };