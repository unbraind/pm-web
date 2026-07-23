import { type SSEEvent } from "./sse.js";
export interface ProjectWatcherDeps {
    intervalMs?: number;
    suppressWindowMs?: number;
    getActiveProjectIds?: () => string[];
    resolveProjectDir?: (projectId: string) => Promise<string | null>;
    readMaxMtimeMs?: (projectDir: string) => Promise<number>;
    wasSignaledWithin?: (projectId: string, windowMs: number) => boolean;
    emit?: (projectId: string, event: SSEEvent) => void;
    onError?: (err: unknown) => void;
}
export declare function createProjectWatchCycle(deps?: ProjectWatcherDeps): {
    tick: () => Promise<void>;
    suppressWindowMs: number;
};
export declare function startProjectWatcher(deps?: ProjectWatcherDeps): () => void;
