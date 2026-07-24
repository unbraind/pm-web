import { type SSEEvent } from "./sse.js";
export declare function computeWorkspaceSignature(dir: string): Promise<string>;
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
