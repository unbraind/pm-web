const clients = [];
export function addSSEClient(client) {
    clients.push(client);
    // Send initial connection confirmation
    client.res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientId: client.id })}\n\n`);
    // Broadcast presence update to all project viewers
    broadcastPresence(client.projectId);
    // Return unsubscribe function
    return () => {
        const idx = clients.indexOf(client);
        if (idx !== -1)
            clients.splice(idx, 1);
        // Broadcast updated presence after disconnect
        broadcastPresence(client.projectId);
    };
}
export function broadcastProjectEvent(projectId, event) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const recipients = clients.filter((c) => c.projectId === projectId);
    for (const client of recipients) {
        try {
            client.res.write(payload);
        }
        catch {
            // Client disconnected; will be cleaned up on next heartbeat
        }
    }
}
export function broadcastPresence(projectId) {
    const projectClients = clients.filter((c) => c.projectId === projectId);
    // Deduplicate by userId — keep most recent connection per user
    const byUser = new Map();
    for (const c of projectClients) {
        const existing = byUser.get(c.userId);
        if (!existing || c.connectedAt > existing.connectedAt) {
            byUser.set(c.userId, c);
        }
    }
    const users = [...byUser.values()].map((c) => ({
        userId: c.userId,
        displayName: c.displayName,
        currentView: c.currentView,
        connectedAt: c.connectedAt.toISOString(),
    }));
    const payload = `event: presence\ndata: ${JSON.stringify({ users })}\n\n`;
    for (const client of projectClients) {
        try {
            client.res.write(payload);
        }
        catch {
            // Client disconnected
        }
    }
}
export function updateClientView(clientId, currentView) {
    const client = clients.find((c) => c.id === clientId);
    if (client) {
        client.currentView = currentView;
        broadcastPresence(client.projectId);
    }
}
export function getProjectPresence(projectId) {
    const projectClients = clients.filter((c) => c.projectId === projectId);
    const byUser = new Map();
    for (const c of projectClients) {
        const existing = byUser.get(c.userId);
        if (!existing || c.connectedAt > existing.connectedAt) {
            byUser.set(c.userId, c);
        }
    }
    return [...byUser.values()].map((c) => ({
        userId: c.userId,
        displayName: c.displayName,
        currentView: c.currentView,
        connectedAt: c.connectedAt.toISOString(),
    }));
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
    return clients.length;
}
export function cleanupStaleClients() {
    const now = Date.now();
    const staleProjectIds = new Set();
    for (let i = clients.length - 1; i >= 0; i--) {
        const client = clients[i];
        // If client connection has been open > 12 hours, close it
        if (now - client.connectedAt.getTime() > 12 * 60 * 60 * 1000) {
            try {
                client.res.end();
            }
            catch {
                // Already closed
            }
            staleProjectIds.add(client.projectId);
            clients.splice(i, 1);
        }
    }
    // Broadcast updated presence for affected projects
    for (const projectId of staleProjectIds) {
        broadcastPresence(projectId);
    }
}
//# sourceMappingURL=sse.js.map