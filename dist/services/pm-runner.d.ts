import { PmClient, PmCliError, isPmCliExpectedError, EXIT_CODE, type GetItemAtResult } from "@unbrained/pm-cli/sdk";
export { PmCliError, isPmCliExpectedError, EXIT_CODE, type GetItemAtResult };
export declare class Semaphore {
    private readonly limit;
    private active;
    private readonly waiting;
    constructor(limit: number);
    acquire(): Promise<() => void>;
}
export declare function projectsRoot(): string;
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
export declare function initProject(userId: string, slug: string, prefix: string): Promise<void>;
export declare function projectExists(userId: string, slug: string): boolean;
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
 * first use. The SDK owns extension activation and serialization internally;
 * caching avoids reconstructing the immutable workspace defaults while each
 * call still receives the SDK's current extension snapshot. Author identity is
 * resolved by the SDK's default detection, preserving prior CLI behaviour.
 */
export declare function getPmClient(pmRoot: string): PmClient;
/** Drop a cached client when its workspace is deleted. */
export declare function evictPmClient(pmRoot: string): void;
/**
 * Read a workspace's parsed `settings.json` for the search-tuning resolvers.
 * Returns `{}` when absent so resolvers fall back to their built-in defaults.
 */
export declare function readPmSettings(userId: string, slug: string): unknown;
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
export declare function deleteProjectDir(userId: string, slug: string): void;
