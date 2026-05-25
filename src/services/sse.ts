import type { Response } from "express";

export interface SSEClient {
  id: string;
  projectId: string;
  userId: string;
  displayName?: string;
  userEmail?: string;
  res: Response;
  connectedAt: Date;
}

export interface PresenceUser {
  userId: string;
  displayName?: string;
  email: string;
  connectedSince: string;
}

const clients: SSEClient[] = [];

export function getProjectPresence(projectId: string): PresenceUser[] {
  const seen = new Set<string>();
  const result: PresenceUser[] = [];
  for (const client of clients) {
    if (client.projectId !== projectId) continue;
    if (seen.has(client.userId)) continue;
    seen.add(client.userId);
    result.push({
      userId: client.userId,
      displayName: client.displayName,
      email: client.userEmail ?? "",
      connectedSince: client.connectedAt.toISOString(),
    });
  }
  return result;
}

export function broadcastPresenceUpdate(projectId: string): void {
  const presence = getProjectPresence(projectId);
  const payload = `event: presence-update\ndata: ${JSON.stringify(presence)}\n\n`;
  for (const client of clients) {
    if (client.projectId !== projectId) continue;
    try {
      client.res.write(payload);
    } catch {
      // Client disconnected; will be cleaned up on next heartbeat
    }
  }
}

export function addSSEClient(client: SSEClient): () => void {
  clients.push(client);

  // Send initial connection confirmation
  client.res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientId: client.id })}\n\n`);

  // Broadcast presence update to all OTHER clients in the same project
  const otherClientsPayload = `event: presence-update\ndata: ${JSON.stringify(getProjectPresence(client.projectId))}\n\n`;
  for (const c of clients) {
    if (c.projectId !== client.projectId || c.id === client.id) continue;
    try {
      c.res.write(otherClientsPayload);
    } catch {
      // Client disconnected; will be cleaned up on next heartbeat
    }
  }

  // Return unsubscribe function
  return () => {
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
    // Broadcast updated presence to remaining clients after disconnect
    broadcastPresenceUpdate(client.projectId);
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
  for (let i = clients.length - 1; i >= 0; i--) {
    const client = clients[i];
    // If client connection has been open > 12 hours, close it
    if (now - client.connectedAt.getTime() > 12 * 60 * 60 * 1000) {
      try {
        client.res.end();
      } catch {
        // Already closed
      }
      clients.splice(i, 1);
    }
  }
}

export interface SSEEvent {
  type: string;
  data: unknown;
}
