import { type SSEEvent } from "./sse.js";
export declare function computeWorkspaceSignature(dir: string): Promise<string>;
export interface ProjectWatcherDeps {
    intervalMs?: number;
    suppressWindowMs?: number;
    getActiveProjectIds?: () => string[];
    resolveProjectDir?: (projectId: string) => Promise<string | null>;
    readSignature?: (projectDir: string) => Promise<string>;
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
