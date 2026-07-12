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

// Clients are indexed two ways so that per-event work scales with the number of
// clients on the *affected project*, not the total number of connected clients.
// This is what lets a single project sustain many concurrent viewers without an
// O(total-clients) scan on every event, presence update, and disconnect.
const byId = new Map<string, SSEClient>();
const byProject = new Map<string, Set<SSEClient>>();
const presenceTimers = new Map<string, NodeJS.Timeout>();
let projectEventPublisher: ((projectId: string, event: SSEEvent) => Promise<void>) | null = null;

export function configureProjectEventPublisher(
  publisher: ((projectId: string, event: SSEEvent) => Promise<void>) | null,
): void {
  projectEventPublisher = publisher;
}

function removeClient(client: SSEClient): void {
  if (byId.get(client.id) === client) byId.delete(client.id);
  const set = byProject.get(client.projectId);
  if (set) {
    set.delete(client);
    if (set.size === 0) byProject.delete(client.projectId);
  }
}

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

function schedulePresence(projectId: string): void {
  const active = presenceTimers.get(projectId);
  if (active) clearTimeout(active);
  presenceTimers.set(projectId, setTimeout(() => {
    presenceTimers.delete(projectId);
    broadcastPresence(projectId);
  }, 75));
}

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

export function broadcastProjectEvent(projectId: string, event: SSEEvent): void {
  deliverProjectEvent(projectId, event);
  if (projectEventPublisher) {
    void projectEventPublisher(projectId, event).catch(() => undefined);
  }
}

export function deliverProjectEvent(projectId: string, event: SSEEvent): void {
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

export function updateClientView(clientId: string, userId: string, projectId: string, currentView: string): boolean {
  const client = byId.get(clientId);
  if (client && client.userId === userId && client.projectId === projectId) {
    client.currentView = currentView;
    schedulePresence(client.projectId);
    return true;
  }
  return false;
}

export function getProjectPresence(projectId: string): PresenceUser[] {
  return presenceUsers(byProject.get(projectId));
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
  return byId.size;
}

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
}

export interface SSEEvent {
  type: string;
  data: unknown;
}
