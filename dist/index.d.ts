import { type ExtensionApi, type SuppressedHostOutput } from "@unbrained/pm-cli/sdk";
/** Resolve the port from flag → PORT env → default 4000. */
export declare function resolvePort(options: Record<string, unknown>, env?: NodeJS.ProcessEnv): string;
/**
 * Resolve the pidfile path used to track a detached server.
 * Uses PM_WEB_STATE_DIR when set, else the OS temp dir, keyed by port so
 * multiple detached servers don't clobber each other's pidfile.
 */
export declare function pidfilePath(port: string | number, env?: NodeJS.ProcessEnv, tmpDir?: string): string;
/**
 * Report whether a Node version string satisfies the `>=22.18.0` requirement.
 *
 * Parses the leading `major.minor.patch` and compares element-wise against
 * `[22, 18, 0]`: a higher component at the first differing index passes, a
 * lower one fails, and an exact match through all three passes. A string with
 * no parseable leading version returns `false`.
 *
 * @param version - The version to check; defaults to the running Node version.
 * @returns True when the version is at least 22.18.0.
 */
export declare function nodeVersionMeetsRequirement(version?: string): boolean;
/**
 * Shape a /healthz probe outcome into a stable status result object.
 *
 * Reachability and readiness are separate answers. A server whose dependencies
 * are down answers 503 while being perfectly reachable, and reporting that as
 * DOWN sends an operator to look for a process that is running -- so the two
 * are reported separately, with "degraded" naming the state in between.
 */
export declare function shapeStatusResult(input: {
    port: string | number;
    reachable: boolean;
    healthy?: boolean;
    body?: unknown;
    error?: string;
}): {
    status: "up" | "degraded" | "down";
    port: number;
    reachable: boolean;
    healthy: boolean;
    url: string;
    version: string | null;
    healthz: unknown;
    error?: string;
};
/**
 * Write a command-owned JSON or human-readable payload exactly once.
 *
 * The public SDK marker retains the structured result for hooks and embedded
 * hosts while preventing the CLI presentation layer from appending a second
 * serialization to stdout.
 *
 * @param json - Whether to render the structured JSON representation.
 * @param result - Structured command result retained for host integrations.
 * @param humanLines - Lines rendered for an interactive non-JSON invocation.
 * @returns The host-output suppression marker carrying the structured result.
 */
export declare function emitOwnedOutput<TResult>(json: boolean, result: TResult, humanLines: readonly string[]): SuppressedHostOutput<TResult>;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
