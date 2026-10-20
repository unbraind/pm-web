import { recordConnection, recordDisconnection, recordBroadcast } from "./realtime-observability.js";
import { logError } from "../observability.js";
import { signalMutationRead } from "./mutation-read-signals.js";
import { attachFanout, clearFanout, hasFanoutProject, prepareFanout, retainedFanoutProjects } from "./sse-fanout.js";
export { canResumeFanout, heartbeatFanout } from "./sse-fanout.js";
// Clients are indexed two ways so that per-event work scales with the number of
// clients on the *affected project*, not the total number of connected clients.
// This is what lets a single project sustain many concurrent viewers without an
// O(total-clients) scan on every event, presence update, and disconnect.
const byId = new Map();
const byProject = new Map();
const detachFanout = new Map();
const presenceTimers = new Map();
let projectEventPublisher = null;
const lastSignaledAt = new Map();
// Legacy identity-free callers retain one-shot signals. Committed paths include
// the item/version identity, so one mutation cannot consume another's signal.
const signaledItemAt = new Map();
const deliveryReceipts = new Map();
const SIGNAL_ENTRY_TTL_MS = 60_000;
/** Record a delivered invalidation for the raw-filesystem safety sweep. */
export function noteSignaledMutation(projectId) {
    lastSignaledAt.set(projectId, Date.now());
}
/** Record one exact committed identity, or a legacy item signal when no identity is available. */
export function noteSignaledItemMutation(projectId, itemId, eventId) {
    signaledItemAt.set(JSON.stringify([projectId, itemId, eventId]), Date.now());
}
/** Consume the exact identity first, then one legacy item signal when available. */
export function consumeSignaledItemMutation(projectId, itemId, eventId) {
    const keys = [JSON.stringify([projectId, itemId, eventId])];
    if (eventId !== undefined)
        keys.push(JSON.stringify([projectId, itemId, undefined]));
    for (const key of keys)
        if (signaledItemAt.delete(key))
            return true;
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
export function wasSignaledWithin(projectId, windowMs, now = Date.now()) {
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
export function consumeSignaledMutation(projectId) {
    lastSignaledAt.delete(projectId);
}
/**
 * Return projects with connected viewers or a retained resume journal, keeping
 * detection active during a bounded last-viewer disconnect.
 */
export function getActiveProjectIds() {
    const active = new Set([...byProject.keys(), ...retainedFanoutProjects()]);
    for (const projectId of deliveryReceipts.keys())
        if (!active.has(projectId))
            deliveryReceipts.delete(projectId);
    return [...active];
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
export function configureProjectEventPublisher(publisher) {
    projectEventPublisher = publisher;
}
/**
 * Remove a client from both indexes.
 *
 * Deletes it from the by-id map and from its project's client set, dropping the
 * project set entirely when it becomes empty so {@link getActiveProjectIds}
 * stops reporting a project with no viewers.
 */
function removeClient(client, reason = "client_closed") {
    if (byId.get(client.id) !== client)
        return;
    byId.delete(client.id);
    detachFanout.get(client.id)?.();
    detachFanout.delete(client.id);
    recordDisconnection(client.projectId, Math.max(0, Date.now() - client.connectedAt.getTime()), reason);
    const set = byProject.get(client.projectId);
    if (set) {
        set.delete(client);
        if (set.size === 0) {
            byProject.delete(client.projectId);
        }
    }
}
/**
 * Build the presence list for one project's clients, one entry per user.
 *
 * Deduplicates by `userId`, keeping the most-recently-connected client per user,
 * and maps each to a {@link PresenceUser}. An empty or absent set yields `[]`.
 */
function presenceUsers(set) {
    if (!set || set.size === 0)
        return [];
    // Deduplicate by userId — keep most recent connection per user
    const byUser = new Map();
    for (const c of set) {
        const existing = byUser.get(c.userId);
        if (!existing || c.connectedAt > existing.connectedAt)
            byUser.set(c.userId, c);
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
function schedulePresence(projectId) {
    const active = presenceTimers.get(projectId);
    if (active)
        clearTimeout(active);
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
export function addSSEClient(client, lastEventId) {
    const previous = byId.get(client.id);
    if (previous) {
        try {
            previous.res.end();
        }
        catch (error) {
            logError("sse_replacement_error", error);
        }
        finally {
            removeClient(previous, "replaced");
            schedulePresence(previous.projectId);
        }
    }
    byId.set(client.id, client);
    recordConnection(client.projectId, client.userId);
    let set = byProject.get(client.projectId);
    if (!set) {
        set = new Set();
        byProject.set(client.projectId, set);
    }
    set.add(client);
    detachFanout.set(client.id, attachFanout(client.projectId, client, () => {
        removeClient(client, "slow_or_unauthorized");
        schedulePresence(client.projectId);
    }, lastEventId));
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
export function broadcastProjectEvent(projectId, event) {
    signalMutationRead(projectId);
    const data = event.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const itemId = data.itemId;
        if (typeof itemId === "string" && itemId.length >= 1 && itemId.length <= 256) {
            noteSignaledItemMutation(projectId, itemId, event.id);
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
 * A committed identity is receipted for the replay window before fan-out, so
 * route, watcher and peer arrival order cannot write the same fact twice.
 * Receipts are shared by project and expire after one minute. They survive the
 * last viewer's disconnect until the bounded resume journal expires.
 *
 * Records a project-level signal, then prepares one shared UTF-8 frame for the
 * authorized batch writer. Unknown projects retain no payload or receipt. A
 * disconnected project's existing journal keeps recording during its resume window.
 *
 * @param projectId - The project to deliver to.
 * @param event - The SSE event.
 */
export function deliverProjectEvent(projectId, event) {
    noteSignaledMutation(projectId);
    const set = byProject.get(projectId);
    recordBroadcast(projectId, event.type, set?.size ?? 0);
    if (!hasFanoutProject(projectId))
        return;
    if (event.id) {
        const receipts = deliveryReceipts.get(projectId) ?? new Map();
        const now = Date.now();
        for (const [id, at] of receipts) {
            if (now - at <= SIGNAL_ENTRY_TTL_MS)
                break;
            receipts.delete(id);
        }
        if (receipts.has(event.id))
            return;
        receipts.set(event.id, now);
        deliveryReceipts.set(projectId, receipts);
    }
    prepareFanout(projectId, event);
}
/**
 * Broadcast the current presence list to a project's viewers.
 *
 * A no-op when the project has no clients; otherwise writes an SSE `presence`
 * event carrying the deduplicated user list to each connected client.
 *
 * @param projectId - The project whose presence to broadcast.
 */
export function broadcastPresence(projectId) {
    const set = byProject.get(projectId);
    if (!set || set.size === 0)
        return;
    recordBroadcast(projectId, "presence", set.size);
    const users = presenceUsers(set);
    prepareFanout(projectId, { type: "presence", data: { users } });
}
/**
 * Update a client's current view when caller and client agree.
 *
 * Sets the view only when a client with the given id belongs to the given user
 * and project, then schedules a presence broadcast. Returns whether the update
 * applied, so a mismatched/stale client id is reported rather than silently
 * mutating another user's view.
 */
export function updateClientView(clientId, userId, projectId, currentView) {
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
export function getProjectPresence(projectId) {
    return presenceUsers(byProject.get(projectId));
}
/**
 * Write the SSE response headers for a streaming connection.
 *
 * Sets `text/event-stream`, no-cache, keep-alive, and `X-Accel-Buffering: no`
 * (so nginx/proxies do not buffer the stream), with status 200.
 */
export function setupSSEHeaders(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
    });
}
/** Return the total number of currently connected SSE clients. */
export function getSSEClientCount() {
    return byId.size;
}
/**
 * End every active SSE response and remove it from the connection indexes.
 *
 * Server shutdown calls this before `server.close()` because open streaming
 * responses otherwise keep the HTTP server's close event pending indefinitely.
 */
export function closeAllSSEClients() {
    for (const client of [...byId.values()]) {
        try {
            client.res.end();
        }
        catch (error) {
            // One response that cannot end (e.g. its socket already failed) must not
            // abort shutdown: the remaining streams still have to close, and the
            // caller still has to reach server.close().
            logError("sse_shutdown_error", error);
        }
        finally {
            removeClient(client, "server_shutdown");
        }
    }
    clearFanout();
    deliveryReceipts.clear();
    for (const timer of presenceTimers.values())
        clearTimeout(timer);
    presenceTimers.clear();
}
/**
 * Close long-lived clients and prune stale signal entries.
 *
 * Ends and removes any client connected for more than 12 hours, schedules a
 * presence broadcast for each affected project, and drops project/item signal
 * timestamps older than {@link SIGNAL_ENTRY_TTL_MS} (60 s).
 */
export function cleanupStaleClients() {
    const now = Date.now();
    const staleProjectIds = new Set();
    for (const client of [...byId.values()]) {
        // If client connection has been open > 12 hours, close it
        if (now - client.connectedAt.getTime() > 12 * 60 * 60 * 1000) {
            try {
                client.res.end();
            }
            catch {
                // Already closed
            }
            removeClient(client, "max_age");
            staleProjectIds.add(client.projectId);
        }
    }
    // Broadcast updated presence for affected projects
    for (const projectId of staleProjectIds) {
        schedulePresence(projectId);
    }
    for (const [pid, at] of lastSignaledAt) {
        if (now - at > SIGNAL_ENTRY_TTL_MS)
            lastSignaledAt.delete(pid);
    }
    for (const [key, at] of signaledItemAt) {
        if (now - at > SIGNAL_ENTRY_TTL_MS)
            signaledItemAt.delete(key);
    }
}
/** Encode a committed fact without conflating same-item mutations or event types used as refetch triggers. */
export function mutationEventIdentity(event) {
    return JSON.stringify([event.item_id, event.version]);
}
//# sourceMappingURL=sse.js.map