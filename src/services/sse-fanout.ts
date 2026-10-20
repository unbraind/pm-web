import { randomUUID } from "node:crypto";
import type { Response } from "express";

/** Bounds apply to shared replay, pending response bytes, and stalled sockets independently. */
export const FANOUT_LIMITS = { windowMs: 4, queueBytes: 1024 * 1024, queueBatches: 64, stallMs: 15_000, replayBytes: 8 * 1024 * 1024, replayEvents: 10_000, replayMs: 60_000 } as const;

/** All HTTP viewers supply a fresh project membership reader; internal sinks are already trusted. */
export interface FanoutSink {
  id: string;
  userId: string;
  res: Response;
  authorizeProject?: () => Promise<ReadonlySet<string>>;
}

interface Frame { sequence: number; payload: Buffer; at: number }
interface Viewer { sink: FanoutSink; registration: number; cursor: number; queue: Buffer[]; presence?: Buffer; bytes: number; blocked: boolean; drain: () => void; deadline?: NodeJS.Timeout; onClose: () => void }
interface Project { epoch: string; sequence: number; registration: number; frames: Frame[]; presence?: Buffer; bytes: number; viewers: Map<string, Viewer>; timer?: NodeJS.Timeout; expiry?: NodeJS.Timeout; flushing: boolean }
const projects = new Map<string, Project>();

/** Create one bounded journal for one project, including periods without a connected viewer. */
function projectState(projectId: string): Project {
  let state = projects.get(projectId);
  if (!state) {
    state = { epoch: randomUUID(), sequence: 0, registration: 0, frames: [], bytes: 0, viewers: new Map(), flushing: false };
    projects.set(projectId, state);
  }
  return state;
}

/** Remove expired/overflow frames; old cursors are rejected explicitly rather than skipping gaps. */
function prune(state: Project): void {
  const now = Date.now();
  while (state.frames.length && (state.frames[0].at < now - FANOUT_LIMITS.replayMs || state.frames.length > FANOUT_LIMITS.replayEvents || state.bytes > FANOUT_LIMITS.replayBytes)) {
    state.bytes -= state.frames.shift()!.payload.length;
  }
}

/** Validate an opaque cursor against this project's epoch and contiguous retained range. */
function cursorSequence(state: Project, cursor: string): number | null {
  prune(state);
  const [epoch, raw, extra] = cursor.split(":");
  const sequence = Number(raw);
  const floor = state.frames[0]?.sequence ?? state.sequence + 1;
  return epoch === state.epoch && extra === undefined && /^\d+$/.test(raw ?? "") && Number.isSafeInteger(sequence) && sequence >= floor - 1 && sequence <= state.sequence ? sequence : null;
}

/** Check resume before sending HTTP headers, after the route has authorized this viewer. */
export function canResumeFanout(projectId: string, cursor: string): boolean {
  const state = projects.get(projectId);
  return !!state && cursor.length <= 128 && cursorSequence(state, cursor) !== null;
}

/** Keep detection alive for the bounded resume interval even when the last viewer disconnects. */
export function retainedFanoutProjects(): string[] {
  return [...projects.keys()];
}

/** Ignore bus traffic for projects this process has never served or whose replay journal expired. */
export function hasFanoutProject(projectId: string): boolean {
  return projects.has(projectId);
}

/** Stop one sink and its listeners/timers without waiting for its transport to drain. */
function detach(state: Project, viewer: Viewer, disconnect: boolean): void {
  if (state.viewers.get(viewer.sink.id) !== viewer) return;
  state.viewers.delete(viewer.sink.id);
  clearTimeout(viewer.deadline);
  viewer.sink.res.off?.("drain", viewer.drain);
  viewer.queue.length = 0;
  viewer.presence = undefined;
  viewer.bytes = 0;
  if (disconnect) {
    try { viewer.sink.res.destroy(); } catch { /* A failed socket is already disconnected. */ }
    viewer.onClose();
  }
  if (!state.viewers.size) {
    clearTimeout(state.expiry);
    state.expiry = setTimeout(() => {
      if (!state.viewers.size) {
        clearTimeout(state.timer);
        for (const [id, candidate] of projects) if (candidate === state) projects.delete(id);
      }
    }, FANOUT_LIMITS.replayMs);
    state.expiry.unref();
  }
}

/** Drain only this response; a false write already accepted that buffer and must never be retried. */
function drainViewer(state: Project, viewer: Viewer, presence?: Buffer): void {
  if (state.viewers.get(viewer.sink.id) !== viewer || viewer.blocked) return;
  try {
    for (;;) {
      const payload = viewer.queue.shift() ?? (viewer.presence === presence ? presence : undefined);
      if (!payload) return;
      if (payload === viewer.presence) viewer.presence = undefined;
      else viewer.bytes -= payload.length;
      if (!viewer.sink.res.write(payload)) {
        viewer.blocked = true;
        viewer.deadline = setTimeout(() => detach(state, viewer, true), FANOUT_LIMITS.stallMs);
        viewer.deadline.unref();
        return;
      }
    }
  } catch { detach(state, viewer, true); }
}

/** Enqueue a shared buffer with a hard bound, including bytes already buffered by Node. */
function enqueue(state: Project, viewer: Viewer, payload: Buffer, mayDrain = true): void {
  if (viewer.bytes + (viewer.presence?.length ?? 0) + payload.length + (viewer.sink.res.writableLength ?? 0) > FANOUT_LIMITS.queueBytes || viewer.queue.length >= FANOUT_LIMITS.queueBatches) {
    detach(state, viewer, true);
    return;
  }
  viewer.queue.push(payload);
  viewer.bytes += payload.length;
  if (mayDrain) drainViewer(state, viewer);
  else schedule(state);
}

/** Write one pre-encoded batch to eligible viewers, grouping only identical replay positions. */
function writeFanoutBatch(state: Project, allowed: ReadonlySet<string> | undefined, throughSequence: number, throughRegistration: number, presence?: Buffer): void {
  prune(state);
  const batches = new Map<number, { payload: Buffer; sequence: number }>();
  for (const viewer of state.viewers.values()) {
    if (viewer.registration > throughRegistration) continue;
    if (viewer.sink.authorizeProject && !allowed?.has(viewer.sink.userId)) { detach(state, viewer, true); continue; }
    drainViewer(state, viewer, presence);
    if (viewer.cursor >= throughSequence) continue;
    if (viewer.cursor < (state.frames[0]?.sequence ?? state.sequence + 1) - 1) { detach(state, viewer, true); continue; }
    let batch = batches.get(viewer.cursor);
    if (!batch) {
      const frames: Frame[] = [];
      let bytes = 0;
      for (const frame of state.frames) {
        if (frame.sequence <= viewer.cursor) continue;
        if (frame.sequence > throughSequence) break;
        if (frames.length && bytes + frame.payload.length > 64 * 1024) break;
        frames.push(frame);
        bytes += frame.payload.length;
      }
      batch = { payload: frames.length === 1 ? frames[0].payload : Buffer.concat(frames.map((frame) => frame.payload)), sequence: frames.at(-1)!.sequence };
      batches.set(viewer.cursor, batch);
    }
    viewer.cursor = batch.sequence;
    enqueue(state, viewer, batch.payload);
    if (viewer.cursor < state.sequence && !viewer.blocked && state.viewers.has(viewer.sink.id)) schedule(state);
  }
}

/** Authorize once per project burst, then apply the membership decision separately to every sink. */
async function flushFanout(state: Project): Promise<void> {
  state.timer = undefined;
  if (state.flushing) { schedule(state); return; }
  state.flushing = true;
  // Later arrivals need a later permission read, even if this query's snapshot predates revocation.
  const throughSequence = state.sequence;
  const throughRegistration = state.registration;
  const throughPresence = state.presence;
  const authorization = [...state.viewers.values()].find((viewer) => viewer.sink.authorizeProject)?.sink.authorizeProject;
  try {
    const allowed = authorization ? await authorization() : undefined;
    writeFanoutBatch(state, allowed, throughSequence, throughRegistration, throughPresence);
  } catch {
    for (const viewer of [...state.viewers.values()]) if (viewer.registration <= throughRegistration) detach(state, viewer, true);
  } finally { state.flushing = false; }
}

/** Use a fixed window from the first event; continuous writes cannot postpone a flush forever. */
function schedule(state: Project): void {
  if (!state.timer) {
    state.timer = setTimeout(() => { void flushFanout(state); }, FANOUT_LIMITS.windowMs);
    state.timer.unref();
  }
}

/** Encode once: journal mutations for replay and replace each viewer's pending presence snapshot. */
export function prepareFanout(projectId: string, event: { type: string; data: unknown }): void {
  const state = projects.get(projectId);
  if (!state) return;
  if (event.type === "presence") {
    const payload = Buffer.from(`event: presence\ndata: ${JSON.stringify(event.data)}\n\n`);
    state.presence = payload;
    for (const viewer of state.viewers.values()) {
      viewer.presence = payload;
      if (viewer.bytes + payload.length + (viewer.sink.res.writableLength ?? 0) > FANOUT_LIMITS.queueBytes) detach(state, viewer, true);
    }
    if (state.viewers.size) schedule(state);
    return;
  }
  const sequence = state.sequence + 1;
  const payload = Buffer.from(`event: ${event.type}\nid: ${state.epoch}:${sequence}\ndata: ${JSON.stringify(event.data)}\n\n`);
  state.sequence = sequence;
  state.frames.push({ sequence, payload, at: Date.now() });
  state.bytes += payload.length;
  prune(state);
  if (state.viewers.size) schedule(state);
}

/** Attach atomically to the journal and replay only frames after the last received cursor. */
export function attachFanout(projectId: string, sink: FanoutSink, onClose: () => void, lastEventId?: string): () => void {
  const state = projectState(projectId);
  const cursor = lastEventId ? cursorSequence(state, lastEventId) : state.sequence;
  if (cursor === null) {
    if (!state.viewers.size && !state.expiry) projects.delete(projectId);
    throw new Error("SSE resume cursor expired");
  }
  clearTimeout(state.expiry);
  state.expiry = undefined;
  const viewer: Viewer = { sink, registration: ++state.registration, cursor, queue: [], bytes: 0, blocked: false, onClose,
    drain: () => {
      viewer.blocked = false;
      clearTimeout(viewer.deadline);
      if (sink.authorizeProject) {
        if (viewer.queue.length || viewer.presence || viewer.cursor < state.sequence) schedule(state);
      }
      else { drainViewer(state, viewer, viewer.presence); if (viewer.cursor < state.sequence && !viewer.blocked) schedule(state); }
    } };
  state.viewers.set(sink.id, viewer);
  sink.res.on?.("drain", viewer.drain);
  enqueue(state, viewer, Buffer.from(`event: connected\nid: ${state.epoch}:${cursor}\ndata: ${JSON.stringify({ ok: true, clientId: sink.id })}\n\n`));
  if (cursor < state.sequence) schedule(state);
  return () => detach(state, viewer, false);
}

/** Heartbeats obey the same per-client queue and stall deadline as event data. */
export function heartbeatFanout(projectId: string, clientId: string): void {
  const state = projects.get(projectId);
  const viewer = state?.viewers.get(clientId);
  if (state && viewer) enqueue(state, viewer, Buffer.from(": heartbeat\n\n"), !viewer.sink.authorizeProject || viewer.queue.length === 0);
}

/** Shutdown discards process-local replay and all scheduled work. */
export function clearFanout(): void {
  for (const state of projects.values()) {
    clearTimeout(state.timer);
    clearTimeout(state.expiry);
    for (const viewer of [...state.viewers.values()]) detach(state, viewer, false);
    clearTimeout(state.expiry);
  }
  projects.clear();
}
