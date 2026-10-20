import type { Response } from "express";
/** Bounds apply to shared replay, pending response bytes, and stalled sockets independently. */
export declare const FANOUT_LIMITS: {
    readonly windowMs: 4;
    readonly queueBytes: number;
    readonly queueBatches: 64;
    readonly stallMs: 15000;
    readonly replayBytes: number;
    readonly replayEvents: 10000;
    readonly replayMs: 60000;
};
/** All HTTP viewers supply a fresh project membership reader; internal sinks are already trusted. */
export interface FanoutSink {
    id: string;
    userId: string;
    res: Response;
    authorizeProject?: () => Promise<ReadonlySet<string>>;
}
/** Check resume before sending HTTP headers, after the route has authorized this viewer. */
export declare function canResumeFanout(projectId: string, cursor: string): boolean;
/** Keep detection alive for the bounded resume interval even when the last viewer disconnects. */
export declare function retainedFanoutProjects(): string[];
/** Ignore bus traffic for projects this process has never served or whose replay journal expired. */
export declare function hasFanoutProject(projectId: string): boolean;
/** Encode each event exactly once as UTF-8, retain it for replay, and schedule an ordered burst. */
export declare function prepareFanout(projectId: string, event: {
    type: string;
    data: unknown;
}): void;
/** Attach atomically to the journal and replay only frames after the last received cursor. */
export declare function attachFanout(projectId: string, sink: FanoutSink, onClose: () => void, lastEventId?: string): () => void;
/** Heartbeats obey the same per-client queue and stall deadline as event data. */
export declare function heartbeatFanout(projectId: string, clientId: string): void;
/** Shutdown discards process-local replay and all scheduled work. */
export declare function clearFanout(): void;
