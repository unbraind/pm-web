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

// Clients are indexed two ways so that per-event work scales with the number of
// clients on the *affected project*, not the total number of connected clients.
// This is what lets a single project sustain many concurrent viewers without an
// O(total-clients) scan on every event, presence update, and disconnect.
const byId = new Map<string, SSEClient>();
const byProject = new Map<string, Set<SSEClient>>();
const presenceTimers = new Map<string, NodeJS.Timeout>();
let projectEventPublisher: ((projectId: string, event: SSEEvent) => Promise<void>) | null = null;

const lastSignaledAt = new Map<string, number>();

// Per-item signal tracking: keyed on `` `${projectId}\u0000${itemId}` `` → timestamp.
// A NUL separator (never valid inside either id) keeps the composite key
// unambiguous even if a caller passes an itemId containing the separator.
// The mutation-event watcher uses this to skip events whose own API broadcast
// already announced the change to clients (dedupe across this instance's writes).
const signaledItemAt = new Map<string, number>();

const SIGNAL_ENTRY_TTL_MS = 60_000;

// Record that an item mutation for this project was just delivered to clients
// (via API broadcast or a received cross-process NOTIFY). The filesystem
// change-detector uses this to suppress re-announcing changes already signaled.
/**
 * Record that a mutation in this project was just announced to clients, so the
 * filesystem change-detector can suppress re-announcing the same change.
 *
 * @param projectId - The project whose workspace changed.
 */
export function noteSignaledMutation(projectId: string): void {
  lastSignaledAt.set(projectId, Date.now());
}

// Record that a mutation of this specific item was just announced to clients
// (typically via broadcastProjectEvent with a granular payload). The
// mutation-event watcher consults consumeSignaledItemMutation to skip the
// matching committed-mutation event so it does not duplicate its own API
// broadcast. This is per-item dedupe: a concurrent change to a *different* item
// by another agent is still delivered (unlike the coarse project-level window).
//
// Narrow race caveat: route handlers broadcast *after* the pm child process
// commits, so if the watcher's poll lands between commit and broadcast one
// duplicate workspace-changed can still reach clients. That is harmless because
// the client handler is an idempotent refetch — noted rather than pretended away.
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
export function noteSignaledItemMutation(projectId: string, itemId: string): void {
  signaledItemAt.set(`${projectId}\u0000${itemId}`, Date.now());
}

// Returns true and consumes the entry when a signal for this exact project+item
// is present (i.e. this instance already announced this item's mutation);
// returns false otherwise. The mutation-event watcher calls this for every
// received event so its own API writes are not re-announced by the stream.
//
// The signal is keyed on project+item, NOT on a mutation id or event cursor, and
// consumption is deliberately ONE-SHOT. That means a signal recorded for a later
// mutation M2 can be consumed by an earlier mutation M1 on the same item, so the
// event actually suppressed is not necessarily the one that was broadcast. This
// mis-pairing cannot lose a change, and tightening the key would buy nothing,
// because of three properties that hold together:
//
//   1. The SDK mutation stream is delivered in cursor order, so M1 (earlier
//      cursor) is durably committed to disk BEFORE the broadcast that recorded
//      M2's signal was ever issued.
//   2. The event payload is a refetch TRIGGER, not a delta — clients never apply
//      it as a patch. `refreshGraphData` in the frontend re-reads authoritative
//      state, so any single surviving event converges the client to the latest
//      state including every mutation that preceded it.
//   3. Consumption is one-shot, so at most ONE event per recorded signal is ever
//      suppressed; every subsequent event for that same item is delivered.
//
// Together: whichever event is suppressed, a later one still arrives and the
// refetch it triggers already includes the suppressed mutation's effect. What a
// mis-pair can do is attribute the surviving event's `operation`/`author`
// metadata to the wrong mutation — that metadata drives only a cosmetic toast,
// never state.
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
export function consumeSignaledItemMutation(projectId: string, itemId: string): boolean {
  const key = `${projectId}\u0000${itemId}`;
  if (signaledItemAt.has(key)) {
    signaledItemAt.delete(key);
    return true;
  }
  return false;
}

/**
 * Report whether a project was signaled within the given time window.
 *
 * @param projectId - The project to check.
 * @param windowMs - How recently a signal must have been recorded.
 * @param now - Current time in ms; defaults to `Date.now()` (injectable for tests).
 * @returns True when a signal exists and is within the window.
 */
export function wasSignaledWithin(projectId: string, windowMs: number, now: number = Date.now()): boolean {
  const at = lastSignaledAt.get(projectId);
  return at !== undefined && now - at <= windowMs;
}

// Consume the recorded signal after the change-detector has attributed one
// filesystem delta to it. This makes suppression correlate 1:1 with a signaled
// write instead of swallowing every delta for the whole window — so a later,
// *unrelated* direct write on the shared volume is still surfaced rather than
// being silently absorbed by a recent API/NOTIFY event's window.
/**
 * Consume a project-level signal after the change-detector has attributed one
 * filesystem delta to it, so suppression correlates 1:1 with a signaled write
 * rather than swallowing every later delta in the window.
 *
 * @param projectId - The project whose signal to clear.
 */
export function consumeSignaledMutation(projectId: string): void {
  lastSignaledAt.delete(projectId);
}

/**
 * Return the ids of projects that currently have at least one connected client,
 * in the order they were first connected.
 */
export function getActiveProjectIds(): string[] {
  return [...byProject.keys()];
}

/**
 * Install (or clear, with `null`) the cross-instance event publisher.
 *
 * When set, {@link broadcastProjectEvent} forwards each event to it so other
 * pm-web instances receive it over the realtime bus; passing `null` detaches
 * the bus.
 *
 * @param publisher - The async publisher, or `null` to clear.
 */
export function configureProjectEventPublisher(
  publisher: ((projectId: string, event: SSEEvent) => Promise<void>) | null,
): void {
  projectEventPublisher = publisher;
}

/**
 * Remove a client from both indexes.
 *
 * Deletes it from the by-id map and from its project's client set, dropping the
 * project set entirely when it becomes empty so {@link getActiveProjectIds}
 * stops reporting a project with no viewers.
 */
function removeClient(client: SSEClient): void {
  if (byId.get(client.id) === client) byId.delete(client.id);
  const set = byProject.get(client.projectId);
  if (set) {
    set.delete(client);
    if (set.size === 0) byProject.delete(client.projectId);
  }
}

/**
 * Build the presence list for one project's clients, one entry per user.
 *
 * Deduplicates by `userId`, keeping the most-recently-connected client per user,
 * and maps each to a {@link PresenceUser}. An empty or absent set yields `[]`.
 */
function presenceUsers(set: Set<SSEClient> | undefined): PresenceUser[] {
  if (!set || set.size === 0) return [];
  // Deduplicate by userId — keep most recent connection per user
  const byUser = new Map<string, SSEClient>();
  for (const c of set) {
    const existing = byUser.get(c.userId);
    if (!existing || c.connectedAt > existing.connectedAt) byUser.set(c.userId, c);
  }
  return [...byUser.values()].map((c) => ({
    userId: c.userId,
    displayName: c.displayName,
    currentView: c.currentView,
    connectedAt: c.connectedAt.toISOString(),
  }));
}

/**
 * Debounce a presence broadcast for a project by 75 ms.
 *
 * Replaces any pending presence timer for the project, so a burst of
 * joins/leaves/view changes triggers a single {@link broadcastPresence} rather
 * than one per event.
 */
function schedulePresence(projectId: string): void {
  const active = presenceTimers.get(projectId);
  if (active) clearTimeout(active);
  presenceTimers.set(projectId, setTimeout(() => {
    presenceTimers.delete(projectId);
    broadcastPresence(projectId);
  }, 75));
}

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
export function addSSEClient(client: SSEClient): () => void {
  byId.set(client.id, client);
  let set = byProject.get(client.projectId);
  if (!set) {
    set = new Set<SSEClient>();
    byProject.set(client.projectId, set);
  }
  set.add(client);

  // Send initial connection confirmation
  client.res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientId: client.id })}\n\n`);

  // Broadcast presence update to all project viewers
  schedulePresence(client.projectId);

  // Return unsubscribe function
  return () => {
    removeClient(client);
    // Broadcast updated presence after disconnect
    schedulePresence(client.projectId);
  };
}

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
export function broadcastProjectEvent(projectId: string, event: SSEEvent): void {
  // When a route broadcasts an item-scoped event, note it per-item so the
  // mutation-event watcher can skip the corresponding committed-mutation fact.
  // This gives per-item dedupe for free across all ~15 existing route call sites
  // with no route changes — only events whose data carries a string `itemId` of
  // plausible length are tracked. (See noteSignaledItemMutation for the narrow
  // race caveat.)
  const data = event.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const itemId = (data as { itemId?: unknown }).itemId;
    if (typeof itemId === "string" && itemId.length >= 1 && itemId.length <= 256) {
      noteSignaledItemMutation(projectId, itemId);
    }
  }
  deliverProjectEvent(projectId, event);
  if (projectEventPublisher) {
    void projectEventPublisher(projectId, event).catch(() => undefined);
  }
}

/**
 * Deliver an event to the local SSE clients of one project.
 *
 * Records a project-level signal, then writes the SSE-formatted payload to every
 * client in the project's set; a write to a disconnected client is swallowed
 * (cleanup happens on the next heartbeat). A no-op when the project has no
 * clients.
 *
 * @param projectId - The project to deliver to.
 * @param event - The SSE event.
 */
export function deliverProjectEvent(projectId: string, event: SSEEvent): void {
  noteSignaledMutation(projectId);
  const set = byProject.get(projectId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const client of set) {
    try {
      client.res.write(payload);
    } catch {
    // Client disconnected; will be cleaned up on next heartbeat
    }
  }
}

/**
 * Broadcast the current presence list to a project's viewers.
 *
 * A no-op when the project has no clients; otherwise writes an SSE `presence`
 * event carrying the deduplicated user list to each connected client.
 *
 * @param projectId - The project whose presence to broadcast.
 */
export function broadcastPresence(projectId: string): void {
  const set = byProject.get(projectId);
  if (!set || set.size === 0) return;
  const users = presenceUsers(set);
  const payload = `event: presence\ndata: ${JSON.stringify({ users })}\n\n`;
  for (const client of set) {
    try {
      client.res.write(payload);
    } catch {
    // Client disconnected
    }
  }
}

/**
 * Update a client's current view when caller and client agree.
 *
 * Sets the view only when a client with the given id belongs to the given user
 * and project, then schedules a presence broadcast. Returns whether the update
 * applied, so a mismatched/stale client id is reported rather than silently
 * mutating another user's view.
 */
export function updateClientView(clientId: string, userId: string, projectId: string, currentView: string): boolean {
  const client = byId.get(clientId);
  if (client && client.userId === userId && client.projectId === projectId) {
    client.currentView = currentView;
    schedulePresence(client.projectId);
    return true;
  }
  return false;
}

/**
 * Return the presence list for a project.
 *
 * @param projectId - The project to read.
 * @returns The deduplicated presence users (empty when none connected).
 */
export function getProjectPresence(projectId: string): PresenceUser[] {
  return presenceUsers(byProject.get(projectId));
}

/**
 * Write the SSE response headers for a streaming connection.
 *
 * Sets `text/event-stream`, no-cache, keep-alive, and `X-Accel-Buffering: no`
 * (so nginx/proxies do not buffer the stream), with status 200.
 */
export function setupSSEHeaders(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });
}

/** Return the total number of currently connected SSE clients. */
export function getSSEClientCount(): number {
  return byId.size;
}

/**
 * Close long-lived clients and prune stale signal entries.
 *
 * Ends and removes any client connected for more than 12 hours, schedules a
 * presence broadcast for each affected project, and drops project/item signal
 * timestamps older than {@link SIGNAL_ENTRY_TTL_MS} (60 s).
 */
export function cleanupStaleClients(): void {
  const now = Date.now();
  const staleProjectIds = new Set<string>();
  for (const client of [...byId.values()]) {
    // If client connection has been open > 12 hours, close it
    if (now - client.connectedAt.getTime() > 12 * 60 * 60 * 1000) {
      try {
        client.res.end();
      } catch {
      // Already closed
      }
      removeClient(client);
      staleProjectIds.add(client.projectId);
    }
  }
  // Broadcast updated presence for affected projects
  for (const projectId of staleProjectIds) {
    schedulePresence(projectId);
  }
  for (const [pid, at] of lastSignaledAt) {
    if (now - at > SIGNAL_ENTRY_TTL_MS) lastSignaledAt.delete(pid);
  }
  for (const [key, at] of signaledItemAt) {
    if (now - at > SIGNAL_ENTRY_TTL_MS) signaledItemAt.delete(key);
  }
}

/**
 * One Server-Sent Events message: a client-facing event `type` and an opaque
 * `data` payload serialized to JSON on the wire.
 */
export interface SSEEvent {
  type: string;
  data: unknown;
}
