import { type ExtensionApi } from "@unbrained/pm-cli/sdk";
/** Resolve the port from flag → PORT env → default 4000. */
export declare function resolvePort(options: Record<string, unknown>, env?: NodeJS.ProcessEnv): string;
/**
 * Resolve the pidfile path used to track a detached server.
 * Uses PM_WEB_STATE_DIR when set, else the OS temp dir, keyed by port so
 * multiple detached servers don't clobber each other's pidfile.
 */
export declare function pidfilePath(port: string | number, env?: NodeJS.ProcessEnv, tmpDir?: string): string;
export declare function nodeVersionMeetsRequirement(version?: string): boolean;
/** Shape a /healthz probe outcome into a stable status result object. */
export declare function shapeStatusResult(input: {
    port: string | number;
    reachable: boolean;
    body?: unknown;
    error?: string;
}): {
    status: "up" | "down";
    port: number;
    reachable: boolean;
    url: string;
    version: string | null;
    healthz: unknown;
    error?: string;
};
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
