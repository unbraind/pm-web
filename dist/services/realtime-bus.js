import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { configureProjectEventPublisher, deliverProjectEvent, } from "./sse.js";
const CHANNEL = "pm_workspace_events";
const INSTANCE_ID = randomUUID();
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z][a-z0-9-]{0,63}$/;
function safeSharedData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data))
        return {};
    const source = data;
    const safe = {};
    for (const key of ["itemId", "userId", "change", "target", "rel", "reason", "count", "source", "operation"]) {
        const value = source[key];
        if (typeof value === "string" && value.length <= 256)
            safe[key] = value;
        else if (typeof value === "number" && Number.isFinite(value))
            safe[key] = value;
    }
    return safe;
}
export function parseEnvelope(raw) {
    if (!raw || Buffer.byteLength(raw, "utf8") > 7_500)
        return null;
    try {
        const value = JSON.parse(raw);
        if (!value.projectId || !PROJECT_ID.test(value.projectId) || !value.type || !EVENT_TYPE.test(value.type))
            return null;
        return { projectId: value.projectId, type: value.type, data: safeSharedData(value.data), ...(value.sourceId ? { sourceId: value.sourceId } : {}) };
    }
    catch {
        return null;
    }
}
export function buildEnvelope(projectId, event, sourceId) {
    if (!PROJECT_ID.test(projectId) || !EVENT_TYPE.test(event.type))
        return null;
    const payload = JSON.stringify({ projectId, type: event.type, data: safeSharedData(event.data), sourceId });
    return Buffer.byteLength(payload, "utf8") <= 7_500 ? payload : null;
}
export function handleIncomingEnvelope(raw, instanceId, deliver) {
    const event = parseEnvelope(raw);
    if (!event || event.sourceId === instanceId)
        return;
    deliver(event.projectId, { type: event.type, data: event.data });
}
export async function startRealtimeBus() {
    if (process.env.PM_REALTIME_ENABLED === "false")
        return async () => undefined;
    let listener = null;
    let reconnectTimer = null;
    let reconnectDelayMs = 250;
    let stopped = false;
    let connecting = null;
    const handlers = new Map();
    const safeDiagnostic = (error) => {
        if (!(error instanceof Error))
            return { name: typeof error };
        const code = error.code;
        return {
            name: error.name,
            ...(code && /^[A-Z0-9_]{1,32}$/i.test(String(code)) ? { code: String(code) } : {}),
        };
    };
    const releaseClient = (client, destroy) => {
        const registered = handlers.get(client);
        if (!registered)
            return;
        client.off("error", registered.error);
        client.off("notification", registered.notification);
        handlers.delete(client);
        client.release(destroy);
    };
    const scheduleReconnect = (error) => {
        if (stopped || reconnectTimer)
            return;
        console.error("Realtime PostgreSQL listener disconnected", safeDiagnostic(error));
        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connect().catch(scheduleReconnect);
        }, delay);
        reconnectTimer.unref();
    };
    const connectOnce = async () => {
        const client = await pool.connect();
        const notification = (message) => {
            handleIncomingEnvelope(message.payload, INSTANCE_ID, deliverProjectEvent);
        };
        const error = (cause) => {
            if (listener !== client)
                return;
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
        }
        catch (cause) {
            if (listener === client)
                listener = null;
            releaseClient(client, true);
            throw cause;
        }
        if (stopped) {
            if (listener === client)
                listener = null;
            await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
            releaseClient(client, false);
            return;
        }
        reconnectDelayMs = 250;
    };
    const connect = () => {
        if (connecting)
            return connecting;
        connecting = connectOnce().finally(() => { connecting = null; });
        return connecting;
    };
    await connect();
    configureProjectEventPublisher(async (projectId, event) => {
        const payload = buildEnvelope(projectId, event, INSTANCE_ID);
        if (payload) {
            await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
        }
        else {
            console.warn(`Realtime event payload exceeded size limit: ${projectId}/${event.type}`);
        }
    });
    return async () => {
        stopped = true;
        if (reconnectTimer)
            clearTimeout(reconnectTimer);
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
//# sourceMappingURL=realtime-bus.js.map