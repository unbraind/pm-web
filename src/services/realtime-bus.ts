import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.ts";
import {
  configureProjectEventPublisher,
  deliverProjectEvent,
  type SSEEvent,
} from "./sse.ts";

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

/**
 * Project a raw event payload down to a small, safe object for cross-instance
 * transport.
 *
 * Only a fixed whitelist of keys (`itemId`, `userId`, `change`, `target`,
 * `rel`, `reason`, `count`, `source`, `operation`) is copied, and only when the
 * value is a string of at most 256 characters or a finite number. Non-objects
 * and arrays yield an empty object, so the NOTIFY payload stays small and free
 * of arbitrary user data.
 *
 * @param data - The raw event data.
 * @returns The filtered, transport-safe data object.
 */
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
export function parseEnvelope(raw: string | undefined): RealtimeEnvelope | null {
  if (!raw || Buffer.byteLength(raw, "utf8") > 7_500) return null;
  try {
    const value = JSON.parse(raw) as Partial<RealtimeEnvelope>;
    if (!value.projectId || !PROJECT_ID.test(value.projectId) || !value.type || !EVENT_TYPE.test(value.type)) return null;
    return { projectId: value.projectId, type: value.type, data: safeSharedData(value.data), ...(value.sourceId ? { sourceId: value.sourceId } : {}) };
  } catch {
    return null;
  }
}

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
export function buildEnvelope(projectId: string, event: SSEEvent, sourceId: string): string | null {
  if (!PROJECT_ID.test(projectId) || !EVENT_TYPE.test(event.type)) return null;
  const payload = JSON.stringify({ projectId, type: event.type, data: safeSharedData(event.data), sourceId });
  return Buffer.byteLength(payload, "utf8") <= 7_500 ? payload : null;
}

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
export function handleIncomingEnvelope(
  raw: string | undefined,
  instanceId: string,
  deliver: (projectId: string, event: SSEEvent) => void,
): void {
  const event = parseEnvelope(raw);
  if (!event || event.sourceId === instanceId) return;
  deliver(event.projectId, { type: event.type, data: event.data });
}

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
      handleIncomingEnvelope(message.payload, INSTANCE_ID, deliverProjectEvent);
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
    const payload = buildEnvelope(projectId, event, INSTANCE_ID);
    if (payload) {
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
