import type { Response } from "express";

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

const clients: SSEClient[] = [];

export function addSSEClient(client: SSEClient): () => void {
  clients.push(client);

  // Send initial connection confirmation
  client.res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientId: client.id })}\n\n`);

  // Broadcast presence update to all project viewers
  broadcastPresence(client.projectId);

  // Return unsubscribe function
  return () => {
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
    // Broadcast updated presence after disconnect
    broadcastPresence(client.projectId);
  };
}

export function broadcastProjectEvent(projectId: string, event: SSEEvent): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const recipients = clients.filter((c) => c.projectId === projectId);
  for (const client of recipients) {
    try {
      client.res.write(payload);
    } catch {
      // Client disconnected; will be cleaned up on next heartbeat
    }
  }
}

export function broadcastPresence(projectId: string): void {
  const projectClients = clients.filter((c) => c.projectId === projectId);

  // Deduplicate by userId — keep most recent connection per user
  const byUser = new Map<string, SSEClient>();
  for (const c of projectClients) {
    const existing = byUser.get(c.userId);
    if (!existing || c.connectedAt > existing.connectedAt) {
      byUser.set(c.userId, c);
    }
  }

  const users: PresenceUser[] = [...byUser.values()].map((c) => ({
    userId: c.userId,
    displayName: c.displayName,
    currentView: c.currentView,
    connectedAt: c.connectedAt.toISOString(),
  }));

  const payload = `event: presence\ndata: ${JSON.stringify({ users })}\n\n`;
  for (const client of projectClients) {
    try {
      client.res.write(payload);
    } catch {
      // Client disconnected
    }
  }
}

export function updateClientView(clientId: string, currentView: string): void {
  const client = clients.find((c) => c.id === clientId);
  if (client) {
    client.currentView = currentView;
    broadcastPresence(client.projectId);
  }
}

export function getProjectPresence(projectId: string): PresenceUser[] {
  const projectClients = clients.filter((c) => c.projectId === projectId);
  const byUser = new Map<string, SSEClient>();
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

export function setupSSEHeaders(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });
}

export function getSSEClientCount(): number {
  return clients.length;
}

export function cleanupStaleClients(): void {
  const now = Date.now();
  const staleProjectIds = new Set<string>();
  for (let i = clients.length - 1; i >= 0; i--) {
    const client = clients[i];
    // If client connection has been open > 12 hours, close it
    if (now - client.connectedAt.getTime() > 12 * 60 * 60 * 1000) {
      try {
        client.res.end();
      } catch {
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

export interface SSEEvent {
  type: string;
  data: unknown;
}
