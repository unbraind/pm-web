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

  const listener: PoolClient = await pool.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  listener.on("notification", (message) => {
    const event = parseEnvelope(message.payload);
    if (!event || event.sourceId === INSTANCE_ID) return;
    deliverProjectEvent(event.projectId, { type: event.type, data: event.data });
  });

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
    }
  });

  return async () => {
    configureProjectEventPublisher(null);
    await listener.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
    listener.release();
  };
}
