import { type SSEEvent } from "./sse.ts";
interface RealtimeEnvelope {
    projectId: string;
    type: string;
    data: unknown;
    sourceId?: string;
}
/**
 * Parse and validate a realtime NOTIFY payload into an envelope.
 *
 * Returns `null` when the payload is missing or exceeds 7,500 bytes, or when
 * JSON parsing, the project-id (UUID) check, or the event-type check fails. The
 * envelope's data is passed through {@link safeSharedData}; a `sourceId` is kept
 * only when present, so receivers can ignore their own broadcasts.
 *
 * @param raw - The raw NOTIFY payload string, or `undefined`.
 * @returns The validated envelope, or `null`.
 */
export declare function parseEnvelope(raw: string | undefined): RealtimeEnvelope | null;
/**
 * Serialize a project event into a realtime NOTIFY payload.
 *
 * Returns `null` without throwing when the project id is not a UUID or the event
 * type is malformed, or when the JSON payload (after {@link safeSharedData}) would
 * exceed 7,500 bytes — so an over-large event is dropped rather than corrupting
 * the channel.
 *
 * @param projectId - The project the event belongs to.
 * @param event - The SSE event to encode.
 * @param sourceId - This instance's id, embedded so other instances can skip it.
 * @returns The JSON payload string, or `null` when invalid or too large.
 */
export declare function buildEnvelope(projectId: string, event: SSEEvent, sourceId: string): string | null;
/**
 * Deliver one NOTIFY payload to local clients, ignoring this instance's own.
 *
 * Parses the payload (no-op when invalid); if it carries a `sourceId` matching
 * this instance the event is dropped to avoid echoing it back, otherwise the
 * event is handed to `deliver` for local SSE fan-out.
 *
 * @param raw - The raw NOTIFY payload.
 * @param instanceId - This instance's id, to suppress self-echo.
 * @param deliver - Sink that fans the event out to local clients.
 */
export declare function handleIncomingEnvelope(raw: string | undefined, instanceId: string, deliver: (projectId: string, event: SSEEvent) => void): void;
/**
 * Start the Postgres LISTEN/NOTIFY realtime bus and return a stop function.
 *
 * A no-op (returning a resolver that does nothing) when `PM_REALTIME_ENABLED`
 * is `"false"`. Otherwise reserves a pool client on the `pm_workspace_events`
 * channel, fans incoming envelopes out to local SSE clients (skipping this
 * instance's own), publishes local events via `pg_notify`, and reconnects with
 * exponential backoff on disconnect. The returned function undoes all of it.
 *
 * @returns A function that stops the bus and releases the listener.
 */
export declare function startRealtimeBus(): Promise<() => Promise<void>>;
export {};
