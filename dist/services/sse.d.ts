import type { Response } from "express";
/**
 * One connected SSE viewer, indexed both by client id and by project so that
 * per-event work scales with the clients on the affected project rather than
 * the total number of connected clients.
 */
export interface SSEClient {
    id: string;
    projectId: string;
    userId: string;
    displayName: string;
    currentView: string;
    res: Response;
    connectedAt: Date;
}
export interface PresenceUser {
    userId: string;
    displayName: string;
    currentView: string;
    connectedAt: string;
}
/**
 * Record that a mutation in this project was just announced to clients, so the
 * filesystem change-detector can suppress re-announcing the same change.
 *
 * @param projectId - The project whose workspace changed.
 */
export declare function noteSignaledMutation(projectId: string): void;
/**
 * Record that a mutation of one specific item was just announced to clients.
 *
 * The mutation-event watcher consults {@link consumeSignaledItemMutation} to
 * skip the matching committed-mutation event, giving per-item dedupe so a
 * concurrent change to a different item by another agent is still delivered.
 *
 * @param projectId - The project containing the item.
 * @param itemId - The item that was announced.
 */
export declare function noteSignaledItemMutation(projectId: string, itemId: string): void;
/**
 * Consume one per-item signal, returning whether one was present.
 *
 * Returns `true` and deletes the entry when this instance already announced the
 * given project+item (so the mutation-event watcher skips its own write);
 * otherwise returns `false`. Consumption is one-shot: at most one event per
 * recorded signal is ever suppressed.
 *
 * @param projectId - The project containing the item.
 * @param itemId - The item to check.
 * @returns True when a signal was present and has been consumed.
 */
export declare function consumeSignaledItemMutation(projectId: string, itemId: string): boolean;
/**
 * Report whether a project was signaled within the given time window.
 *
 * @param projectId - The project to check.
 * @param windowMs - How recently a signal must have been recorded.
 * @param now - Current time in ms; defaults to `Date.now()` (injectable for tests).
 * @returns True when a signal exists and is within the window.
 */
export declare function wasSignaledWithin(projectId: string, windowMs: number, now?: number): boolean;
/**
 * Consume a project-level signal after the change-detector has attributed one
 * filesystem delta to it, so suppression correlates 1:1 with a signaled write
 * rather than swallowing every later delta in the window.
 *
 * @param projectId - The project whose signal to clear.
 */
export declare function consumeSignaledMutation(projectId: string): void;
/**
 * Return the ids of projects that currently have at least one connected client,
 * in the order they were first connected.
 */
export declare function getActiveProjectIds(): string[];
/**
 * Install (or clear, with `null`) the cross-instance event publisher.
 *
 * When set, {@link broadcastProjectEvent} forwards each event to it so other
 * pm-web instances receive it over the realtime bus; passing `null` detaches
 * the bus.
 *
 * @param publisher - The async publisher, or `null` to clear.
 */
export declare function configureProjectEventPublisher(publisher: ((projectId: string, event: SSEEvent) => Promise<void>) | null): void;
/**
 * Register a new SSE client and return its unsubscribe function.
 *
 * Indexes the client by id and project, writes an initial `connected` event,
 * and schedules a presence broadcast. The returned function removes the client
 * and schedules a fresh presence broadcast for the project on disconnect.
 *
 * @param client - The client to register.
 * @returns A function that unregisters the client.
 */
export declare function addSSEClient(client: SSEClient): () => void;
/**
 * Broadcast an event to a project's viewers locally and across instances.
 *
 * When the event data carries a plausible string `itemId`, records a per-item
 * signal so the mutation-event watcher can skip the matching committed fact,
 * then delivers the event to local clients and forwards it to the cross-instance
 * publisher when one is configured.
 *
 * @param projectId - The project to broadcast to.
 * @param event - The SSE event.
 */
export declare function broadcastProjectEvent(projectId: string, event: SSEEvent): void;
/**
 * Deliver an event to the local SSE clients of one project.
 *
 * Records a project-level signal, then writes the SSE-formatted payload to every
 * client in the project's set; a write to a disconnected client is swallowed
 * (cleanup happens on the next heartbeat). The project-level signal is recorded
 * even when the project has no clients, so a no-client call is not a complete
 * no-op.
 *
 * @param projectId - The project to deliver to.
 * @param event - The SSE event.
 */
export declare function deliverProjectEvent(projectId: string, event: SSEEvent): void;
/**
 * Broadcast the current presence list to a project's viewers.
 *
 * A no-op when the project has no clients; otherwise writes an SSE `presence`
 * event carrying the deduplicated user list to each connected client.
 *
 * @param projectId - The project whose presence to broadcast.
 */
export declare function broadcastPresence(projectId: string): void;
/**
 * Update a client's current view when caller and client agree.
 *
 * Sets the view only when a client with the given id belongs to the given user
 * and project, then schedules a presence broadcast. Returns whether the update
 * applied, so a mismatched/stale client id is reported rather than silently
 * mutating another user's view.
 */
export declare function updateClientView(clientId: string, userId: string, projectId: string, currentView: string): boolean;
/**
 * Return the presence list for a project.
 *
 * @param projectId - The project to read.
 * @returns The deduplicated presence users (empty when none connected).
 */
export declare function getProjectPresence(projectId: string): PresenceUser[];
/**
 * Write the SSE response headers for a streaming connection.
 *
 * Sets `text/event-stream`, no-cache, keep-alive, and `X-Accel-Buffering: no`
 * (so nginx/proxies do not buffer the stream), with status 200.
 */
export declare function setupSSEHeaders(res: Response): void;
/** Return the total number of currently connected SSE clients. */
export declare function getSSEClientCount(): number;
/**
 * Close long-lived clients and prune stale signal entries.
 *
 * Ends and removes any client connected for more than 12 hours, schedules a
 * presence broadcast for each affected project, and drops project/item signal
 * timestamps older than {@link SIGNAL_ENTRY_TTL_MS} (60 s).
 */
export declare function cleanupStaleClients(): void;
/**
 * One Server-Sent Events message: a client-facing event `type` and an opaque
 * `data` payload serialized to JSON on the wire.
 */
export interface SSEEvent {
    type: string;
    data: unknown;
}
