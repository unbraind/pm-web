import { PmCliError, EXIT_CODE, type GetItemAtResult } from "@unbrained/pm-cli/sdk";
export { PmCliError, EXIT_CODE, type GetItemAtResult };
export declare class Semaphore {
    private readonly limit;
    private active;
    private readonly waiting;
    constructor(limit: number);
    acquire(): Promise<() => void>;
}
export declare function projectsRoot(): string;
export declare function getProjectDir(userId: string, slug: string): string;
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
}
export interface EnsureGraphExtensionResult {
    ok: boolean;
    installed: boolean;
    active: boolean;
    error?: string;
}
export declare function ensureGraphExtension(userId: string, slug: string): Promise<EnsureGraphExtensionResult>;
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
