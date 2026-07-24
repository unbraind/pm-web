import { type SSEEvent } from "./sse.js";
interface RealtimeEnvelope {
    projectId: string;
    type: string;
    data: unknown;
    sourceId?: string;
}
export declare function parseEnvelope(raw: string | undefined): RealtimeEnvelope | null;
export declare function buildEnvelope(projectId: string, event: SSEEvent, sourceId: string): string | null;
export declare function handleIncomingEnvelope(raw: string | undefined, instanceId: string, deliver: (projectId: string, event: SSEEvent) => void): void;
export declare function startRealtimeBus(): Promise<() => Promise<void>>;
export {};
