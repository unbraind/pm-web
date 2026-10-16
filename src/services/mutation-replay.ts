/** Bounded overlap for committed facts whose mutation timestamps precede their visibility. */
import { type MutationEvent, type SubscribeMutationEventsOptions } from "@unbrained/pm-cli/sdk";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { HistoryReadGate, historyFingerprint, singleFlightMutationPage } from "./history-read-gate.ts";

/** One minute covers the web command timeout and the capacity writer timeout, with scheduling headroom. */
export const MUTATION_REPLAY_WINDOW_MS = 60_000;
/** Bound per-active-project dedupe memory; overflow is reported rather than silently evicting live keys. */
export const MUTATION_REPLAY_MAX_EVENTS = 10_000;

/** State survives subscription restarts, preventing a replay after an SDK read error from duplicating delivery. */
export interface MutationReplayState {
  /** Inclusive attachment time, excluding pre-existing history on first connection. */
  baseline: number;
  /** Item/version keys and their mutation times within the retained overlap. */
  seen: Map<string, number>;
  /** Successful scans and pending invalidations, retained across read-error recovery. */
  readGate: HistoryReadGate;
}

/** Allocate replay state at project attachment, excluding older history from initial delivery. */
export function createMutationReplayState(): MutationReplayState {
  return { baseline: Date.now(), seen: new Map(), readGate: new HistoryReadGate() };
}

/**
 * Re-read a bounded timestamp window rather than advancing an exclusive timestamp cursor forever.
 * A writer assigns its history timestamp before final persistence; another writer's later timestamp
 * can become visible first. Paging with the exclusive cursor alone then permanently skips the late
 * fact. Each admitted scan starts again at the inclusive window floor and dedupes by item/version, while
 * pagination within that poll retains the SDK's ordered cursor. The yielded resume boundary is
 * the inclusive floor, so a restart can recover every unconsumed fact in the window.
 */
export async function* followCommittedMutations(options: SubscribeMutationEventsOptions, state: MutationReplayState): AsyncGenerator<MutationEvent, void, void> {
  const since = Date.parse(options.since ?? "");
  if (!Number.isFinite(since)) throw new Error("Mutation replay requires an ISO timestamp boundary");
  state.baseline = Math.min(state.baseline, since);
  const pmRoot = path.resolve(options.cwd ?? process.cwd(), options.pmRoot ?? path.join(".agents", "pm"));
  while (!options.signal?.aborted) {
    const scanAt = Date.now();
    const read = state.readGate.begin(await historyFingerprint(pmRoot));
    if (read) {
      // Never age past a fact that could have become visible since the previous
      // complete scan. A safety check after skipped polls still sees facts that
      // appeared within the original one-minute visibility contract.
      const floor = Math.max(state.baseline, (state.readGate.completedScanAt ?? scanAt) - MUTATION_REPLAY_WINDOW_MS);
      for (const [key, timestamp] of state.seen) if (timestamp < floor) state.seen.delete(key);
      const boundary = new Date(floor).toISOString();
      let cursor: string | undefined = boundary;
      for (;;) {
        const page = await singleFlightMutationPage({ ...options, pmRoot, since: cursor, limit: 1000 });
        for (const event of page.events) {
          if (options.signal?.aborted) return;
          const key = `${event.item_id}:${event.version}`;
          if (state.seen.has(key)) continue;
          if (state.seen.size >= MUTATION_REPLAY_MAX_EVENTS) throw new Error("Mutation replay window exceeded its bounded event capacity");
          state.seen.set(key, Date.parse(event.ts));
          yield { ...event, cursor: boundary };
        }
        if (!page.has_more) break;
        if (!page.next_cursor || page.next_cursor === cursor) throw new Error("Mutation replay pagination made no progress");
        cursor = page.next_cursor;
      }
      read.complete(scanAt);
    }
    try { await delay(options.intervalMs ?? 250, undefined, { signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) return; throw error; }
  }
}
