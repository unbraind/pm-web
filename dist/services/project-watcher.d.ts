import { type SSEEvent } from "./sse.ts";
/**
 * Compute a one-shot change-detection signature for a whole workspace.
 *
 * Enumerates every eligible file, `stat`s each one, and folds a per-file
 * fingerprint (path bound to mtime) into a `count`, an XOR accumulator, and a
 * sum (wrapping mod 2^32) so distinct file/mtime arrangements are unlikely to
 * share the same `count:xor:sum` string (though the 32-bit fingerprint cannot
 * guarantee collision freedom). Files that vanish between `readdir` and
 * `stat` are ignored. This stats every file in one pass; the live watcher uses
 * the bounded {@link stepWorkspaceSweep} variant instead.
 *
 * @param dir - A project root (`<PROJECTS_ROOT>/<userId>/<slug>`).
 * @returns The workspace signature string.
 */
export declare function computeWorkspaceSignature(dir: string): Promise<string>;
/**
 * Accumulators and cursor for one project's round-robin filesystem sweep.
 *
 * A sweep folds every eligible file's fingerprint into `count`/`xor`/`sum` over
 * as many ticks as needed, statting at most `maxFilesPerTick` files per tick.
 * `cursor` is the index into the eligible-file list reached so far; a complete
 * sweep produces a `count:xor:sum` signature comparable to the previous one.
 */
export interface WorkspaceSweepState {
    cursor: number;
    count: number;
    xor: number;
    sum: number;
}
export declare function newSweepState(): WorkspaceSweepState;
export declare function stepWorkspaceSweep(dir: string, state: WorkspaceSweepState, maxFilesPerTick: number): Promise<{
    completed: boolean;
    signature?: string;
}>;
export interface ProjectWatcherDeps {
    intervalMs?: number;
    suppressWindowMs?: number;
    maxFilesPerTick?: number;
    getActiveProjectIds?: () => string[];
    resolveProjectDir?: (projectId: string) => Promise<string | null>;
    readSignature?: (projectDir: string) => Promise<string>;
    stepSignature?: (projectDir: string, state: WorkspaceSweepState, maxFilesPerTick: number) => Promise<{
        completed: boolean;
        signature?: string;
    }>;
    wasSignaledWithin?: (projectId: string, windowMs: number) => boolean;
    consumeSignal?: (projectId: string) => void;
    emit?: (projectId: string, event: SSEEvent) => void;
    onError?: (err: unknown) => void;
}
export declare function createProjectWatchCycle(deps?: ProjectWatcherDeps): {
    tick: () => Promise<void>;
    suppressWindowMs: number;
};
export declare function startProjectWatcher(deps?: ProjectWatcherDeps): () => void;
