import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import {
  configureProjectEventPublisher,
  deliverProjectEvent,
  type SSEEvent,
} from "./sse.js";

const CHANNEL = "pm_workspace_events";
const INSTANCE_ID = randomUUID();
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z][a-z0-9-]{0,63}$/;

interface RealtimeEnvelope {
  projectId: string;
  type: string;
  data: unknown;
  sourceId?: string;
}

function safeSharedData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const source = data as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ["itemId", "userId", "change", "target", "rel", "reason", "count", "source", "operation"]) {
    const value = source[key];
    if (typeof value === "string" && value.length <= 256) safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

function parseEnvelope(raw: string | undefined): RealtimeEnvelope | null {
  if (!raw || Buffer.byteLength(raw, "utf8") > 7_500) return null;
  try {
    const value = JSON.parse(raw) as Partial<RealtimeEnvelope>;
    if (!value.projectId || !PROJECT_ID.test(value.projectId) || !value.type || !EVENT_TYPE.test(value.type)) return null;
    return { projectId: value.projectId, type: value.type, data: safeSharedData(value.data), ...(value.sourceId ? { sourceId: value.sourceId } : {}) };
  } catch {
    return null;
  }
}

export async function startRealtimeBus(): Promise<() => Promise<void>> {
  if (process.env.PM_REALTIME_ENABLED === "false") return async () => undefined;

  let listener: PoolClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelayMs = 250;
  let stopped = false;
  let connecting: Promise<void> | null = null;
  const handlers = new Map<PoolClient, {
    error: (error: Error) => void;
    notification: (message: { payload?: string }) => void;
  }>();

  const safeDiagnostic = (error: unknown): Record<string, string> => {
    if (!(error instanceof Error)) return { name: typeof error };
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      ...(code && /^[A-Z0-9_]{1,32}$/i.test(String(code)) ? { code: String(code) } : {}),
    };
  };

  const releaseClient = (client: PoolClient, destroy: boolean): void => {
    const registered = handlers.get(client);
    if (!registered) return;
    client.off("error", registered.error);
    client.off("notification", registered.notification);
    handlers.delete(client);
    client.release(destroy);
  };

  const scheduleReconnect = (error: unknown): void => {
    if (stopped || reconnectTimer) return;
    console.error("Realtime PostgreSQL listener disconnected", safeDiagnostic(error));
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(scheduleReconnect);
    }, delay);
    reconnectTimer.unref();
  };

  const connectOnce = async (): Promise<void> => {
    const client = await pool.connect();
    const notification = (message: { payload?: string }): void => {
      const event = parseEnvelope(message.payload);
      if (!event || event.sourceId === INSTANCE_ID) return;
      deliverProjectEvent(event.projectId, { type: event.type, data: event.data });
    };
    const error = (cause: Error): void => {
      if (listener !== client) return;
      listener = null;
      releaseClient(client, true);
      scheduleReconnect(cause);
    };
    handlers.set(client, { error, notification });
    client.on("error", error);
    client.on("notification", notification);
    listener = client;
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (cause) {
      if (listener === client) listener = null;
      releaseClient(client, true);
      throw cause;
    }
    if (stopped) {
      if (listener === client) listener = null;
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      releaseClient(client, false);
      return;
    }
    reconnectDelayMs = 250;
  };

  const connect = (): Promise<void> => {
    if (connecting) return connecting;
    connecting = connectOnce().finally(() => { connecting = null; });
    return connecting;
  };

  await connect();

  configureProjectEventPublisher(async (projectId: string, event: SSEEvent) => {
    if (!PROJECT_ID.test(projectId) || !EVENT_TYPE.test(event.type)) return;
    const payload = JSON.stringify({
      projectId,
      type: event.type,
      data: safeSharedData(event.data),
      sourceId: INSTANCE_ID,
    });
    if (Buffer.byteLength(payload, "utf8") <= 7_500) {
      await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
    } else {
      console.warn(`Realtime event payload exceeded size limit: ${projectId}/${event.type}`);
    }
  });

  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    configureProjectEventPublisher(null);
    const client = listener;
    listener = null;
    if (client) {
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      releaseClient(client, false);
    }
  };
}
