// Clients are indexed two ways so that per-event work scales with the number of
// clients on the *affected project*, not the total number of connected clients.
// This is what lets a single project sustain many concurrent viewers without an
// O(total-clients) scan on every event, presence update, and disconnect.
const byId = new Map();
const byProject = new Map();
const presenceTimers = new Map();
let projectEventPublisher = null;
const lastSignaledAt = new Map();
const SIGNAL_ENTRY_TTL_MS = 60_000;
// Record that an item mutation for this project was just delivered to clients
// (via API broadcast or a received cross-process NOTIFY). The filesystem
// change-detector uses this to suppress re-announcing changes already signaled.
export function noteSignaledMutation(projectId) {
    lastSignaledAt.set(projectId, Date.now());
}
export function wasSignaledWithin(projectId, windowMs, now = Date.now()) {
    const at = lastSignaledAt.get(projectId);
    return at !== undefined && now - at <= windowMs;
}
// Consume the recorded signal after the change-detector has attributed one
// filesystem delta to it. This makes suppression correlate 1:1 with a signaled
// write instead of swallowing every delta for the whole window — so a later,
// *unrelated* direct write on the shared volume is still surfaced rather than
// being silently absorbed by a recent API/NOTIFY event's window.
export function consumeSignaledMutation(projectId) {
    lastSignaledAt.delete(projectId);
}
export function getActiveProjectIds() {
    return [...byProject.keys()];
}
export function configureProjectEventPublisher(publisher) {
    projectEventPublisher = publisher;
}
function removeClient(client) {
    if (byId.get(client.id) === client)
        byId.delete(client.id);
    const set = byProject.get(client.projectId);
    if (set) {
        set.delete(client);
        if (set.size === 0)
            byProject.delete(client.projectId);
    }
}
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
function schedulePresence(projectId) {
    const active = presenceTimers.get(projectId);
    if (active)
        clearTimeout(active);
    presenceTimers.set(projectId, setTimeout(() => {
        presenceTimers.delete(projectId);
        broadcastPresence(projectId);
    }, 75));
}
export function addSSEClient(client) {
    byId.set(client.id, client);
    let set = byProject.get(client.projectId);
    if (!set) {
        set = new Set();
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
export function broadcastProjectEvent(projectId, event) {
    deliverProjectEvent(projectId, event);
    if (projectEventPublisher) {
        void projectEventPublisher(projectId, event).catch(() => undefined);
    }
}
export function deliverProjectEvent(projectId, event) {
    noteSignaledMutation(projectId);
    const set = byProject.get(projectId);
    if (!set || set.size === 0)
        return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of set) {
        try {
            client.res.write(payload);
        }
        catch {
            // Client disconnected; will be cleaned up on next heartbeat
        }
    }
}
export function broadcastPresence(projectId) {
    const set = byProject.get(projectId);
    if (!set || set.size === 0)
        return;
    const users = presenceUsers(set);
    const payload = `event: presence\ndata: ${JSON.stringify({ users })}\n\n`;
    for (const client of set) {
        try {
            client.res.write(payload);
        }
        catch {
            // Client disconnected
        }
    }
}
export function updateClientView(clientId, userId, projectId, currentView) {
    const client = byId.get(clientId);
    if (client && client.userId === userId && client.projectId === projectId) {
        client.currentView = currentView;
        schedulePresence(client.projectId);
        return true;
    }
    return false;
}
export function getProjectPresence(projectId) {
    return presenceUsers(byProject.get(projectId));
}
export function setupSSEHeaders(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
    });
}
export function getSSEClientCount() {
    return byId.size;
}
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
            removeClient(client);
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
}
//# sourceMappingURL=sse.js.map