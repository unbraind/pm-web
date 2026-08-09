import { PmClient, PmCliError, isPmCliExpectedError, EXIT_CODE, type GetItemAtResult } from "@unbrained/pm-cli/sdk";
export { PmCliError, isPmCliExpectedError, EXIT_CODE, type GetItemAtResult };
/**
 * Async semaphore bounding concurrent work to a fixed `limit`.
 *
 * Used to cap how many pm commands run at once: callers {@link Semaphore.acquire}
 * before work and invoke the returned release function after, so at most `limit`
 * critical sections execute concurrently.
 */
export declare class Semaphore {
    private active;
    private readonly waiting;
    private readonly limit;
    constructor(limit: number);
    /**
         * Reserve a slot, waiting when the limit is reached, and return a release fn.
         *
         * When fewer than `limit` slots are active, this increments the count
         * immediately; otherwise it awaits until a prior release wakes this caller.
         * The returned function releases exactly once (subsequent calls are no-ops):
         * if a waiter exists it is resumed, otherwise the active count is decremented.
         *
         * @returns A function that releases the acquired slot.
         */
    acquire(): Promise<() => void>;
}
/**
 * Resolve the filesystem root under which every project workspace lives.
 *
 * Reads `PROJECTS_ROOT`, defaulting to `/app/projects` (the in-container
 * location). Each project is stored at `<root>/<userId>/<slug>`.
 *
 * @returns The projects root directory.
 */
export declare function projectsRoot(): string;
/**
 * Resolve the on-disk directory for one project workspace.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 * @returns `<projectsRoot>/<userId>/<slug>`.
 */
export declare function getProjectDir(userId: string, slug: string): string;
/**
 * Resolve a project id to its on-disk directory, or `null` when the project row
 * is genuinely absent.
 *
 * Shared by both out-of-band change detectors (the mutation-event subscription
 * and the filesystem safety-net sweep), which each cache the result per active
 * SSE session. It lives here because this module already owns the
 * project-id → path mapping via {@link getProjectDir}.
 *
 * Database errors are deliberately **not** swallowed: a transient `pool.query`
 * failure must reach the caller's per-project error handling so the lookup is
 * retried. Returning `null` on failure would let a caller cache "no such
 * project" for the whole session and permanently stop watching it. `null`
 * therefore means "the row is absent", which is safe to cache.
 */
export declare function resolveProjectDir(projectId: string): Promise<string | null>;
/**
 * Create and initialize a project workspace on disk.
 *
 * Makes the project directory, runs `pm init <prefix>` serialized against the
 * workspace, configures local Ollama search, and ensures the graph extension is
 * installed. Throws when `pm init` fails.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 * @param prefix - The pm item-id prefix for the workspace.
 */
export declare function initProject(userId: string, slug: string, prefix: string): Promise<void>;
/**
 * Report whether a project workspace is already initialized on disk.
 *
 * True when the workspace's `.agents/pm/settings.json` exists, the marker `pm
 * init` writes. Used to decide whether to init before use.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 * @returns True when the workspace appears initialized.
 */
export declare function projectExists(userId: string, slug: string): boolean;
/**
 * Options for {@link runPm}: the pm arguments to run, the project owner/slug
 * that locate the workspace, optional stdin, a JSON-output request, and an
 * optional per-call timeout.
 */
export interface PmRunOptions {
    args: string[];
    userId: string;
    slug: string;
    input?: string;
    jsonOutput?: boolean;
    timeoutMs?: number;
}
export interface PmRunResult {
    stdout: string;
    stderr: string;
    ok: boolean;
    parsed?: unknown;
    /** pm CLI exit code from either the SDK dispatcher or spawned CLI fallback. */
    exitCode?: number;
}
export interface EnsureGraphExtensionResult {
    ok: boolean;
    installed: boolean;
    active: boolean;
    error?: string;
}
/**
 * The per-extension state shape emitted by `pm extension --json`. Only the
 * fields consumers read are typed; the command emits far more (triage, policy,
 * diagnostics) which is deliberately dropped.
 */
export interface ExtensionState {
    name: string;
    version?: string;
    active?: boolean;
    enabled?: boolean;
    runtime_active?: boolean;
    activation_status?: string;
    managed?: boolean;
    source?: {
        kind?: string;
        input?: string;
    };
}
/**
 * Outcome of reading per-project extension state.
 *
 * `ok` distinguishes "the command ran and this is the state" from "the command
 * failed, so we know nothing" — a distinction both previous copies of this
 * parser collapsed, reporting a failed `pm extension --json` identically to a
 * project with nothing installed.
 */
export interface ExtensionStatesResult {
    ok: boolean;
    states: Map<string, ExtensionState>;
    error?: string;
}
/**
 * Read the per-project extension state from `pm extension --json`, returning a
 * map keyed by extension name. Used both by {@link ensureGraphExtension} and
 * the extensions routes' catalog join.
 */
export declare function readProjectExtensionStates(projectDir: string): Promise<ExtensionStatesResult>;
/**
 * Timeout for package installs, which resolve and download from the npm
 * registry rather than only touching local state.
 *
 * The 30s default is sized for local commands and leaves too thin a margin
 * here. Measured on this host: a warm-cache install is ~2s, and a cold-cache
 * install of the heaviest catalog package (pm-graph, which pulls
 * `neo4j-driver`) is ~10s. That is only a 3x margin on a fast connection,
 * before accounting for a container sharing bandwidth or a slow registry —
 * and the failure mode is a project create or package install that dies
 * mid-download. A hung install still terminates, just later.
 */
export declare const INSTALL_COMMAND_TIMEOUT_MS = 180000;
/**
 * Ensure the pm-graph package is installed and active for a project.
 *
 * This used to install a *vendored* copy of pm-graph from
 * `extensions/pm-graph/` (a stale fork pinned to pm-cli `^2026.7.5`). The
 * vendored fork is gone; pm-graph is now installed from npm through the same
 * generic catalog path as every other pm package
 * (src/services/package-catalog.ts). The npm spec is resolved from the catalog
 * — never built from a user-supplied string — so the install target is always
 * the verified `npm:pm-graph` constant.
 *
 * The graph routes in src/routes/pm.ts call this before `pm pm-graph export`,
 * and {@link initProject} calls it on project creation, so the user-facing
 * graph behaviour is unchanged.
 */
export declare function ensureGraphExtension(userId: string, slug: string): Promise<EnsureGraphExtensionResult>;
/**
 * Return a cached {@link PmClient} for a workspace pm-root, creating one on
 * first use. The SDK owns extension activation internally; per-workspace
 * serialization of mutating calls is enforced by {@link runPm}'s
 * {@link runSerialized} wrapper (the SDK's own queue is process-wide, not
 * per-workspace). Caching avoids reconstructing the immutable workspace
 * defaults while each call still receives the SDK's current extension
 * snapshot. Author identity is resolved by the SDK's default detection,
 * preserving prior CLI behaviour.
 */
export declare function getPmClient(pmRoot: string): PmClient;
/** Drop a cached client when its workspace is deleted. */
export declare function evictPmClient(pmRoot: string): void;
/**
 * Read a workspace's parsed `settings.json` for the search-tuning resolvers.
 * Returns `{}` when absent so resolvers fall back to their built-in defaults.
 */
export declare function readPmSettings(userId: string, slug: string): unknown;
/**
 * Run a pm command against a project workspace.
 *
 * Resolves the workspace directory and dispatches supported actions in-process
 * through the cached SDK client (no spawn) when there is no stdin input or
 * custom timeout; otherwise spawns the pm binary as a fallback. Both paths run
 * inside {@link runSerialized}, so same-workspace calls never overlap. When
 * `jsonOutput` is set and the command succeeds with stdout, the output is parsed
 * as JSON (a parse failure yields `{ raw: stdout }`). Never throws: errors are
 * returned in the {@link PmRunResult}.
 *
 * @param opts - The command, project, and I/O options.
 * @returns The stdout/stderr, success flag, parsed JSON (when requested), and exit code.
 */
export declare function runPm(opts: PmRunOptions): Promise<PmRunResult>;
/**
 * Reconstruct a single item at a one-based version or ISO timestamp using the
 * pm CLI SDK's mutation-free `getItemAt` projection (the same verified replay
 * kernel that powers `pm get --at` and `pm restore`).
 *
 * Unlike {@link runPm}, this calls the SDK in-process — there is no history
 * write, lock acquisition, or derived-index mutation — so it is safe to run
 * concurrently with other readers and writers of the same workspace.
 *
 * @throws {PmCliError} with `exitCode` {@link EXIT_CODE}.NOT_FOUND when the item
 *   does not exist (or has no history), and {@link EXIT_CODE}.USAGE for an
 *   invalid ref or a version/timestamp outside the available history range.
 */
export declare function runGetItemAt(userId: string, slug: string, itemId: string, ref: string): Promise<GetItemAtResult>;
/**
 * Delete a project workspace from disk.
 *
 * Evicts the cached SDK client for the project's pm root first (so no stale
 * client outlives the deletion), then removes the whole workspace directory
 * recursively. A missing directory is not an error.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 */
export declare function deleteProjectDir(userId: string, slug: string): void;
