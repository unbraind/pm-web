// Per-project mutation-event subscription manager.
//
// The primary out-of-band change detector for pm-web. Subscribes to the pm SDK's
// `subscribeMutationEvents` async generator for each active project, which reads
// from a persistent derived index of committed mutation facts (NOT a filesystem
// scan). Another process's mutation appears on this follower within `intervalMs`.
//
// Raw file edits that bypass pm (git merge, rsync restore, manual writes) produce
// NO mutation event — the stream is a committed-mutation fact stream derived from
// history. The filesystem sweep in project-watcher.ts is therefore KEPT as a safety
// net for those bypass-pm writes; this module is the primary path for pm-authored
// mutations.
//
// Events are emitted LOCALLY only (deliverProjectEvent, NOT broadcastProjectEvent).
// Every pm-web instance reads the same shared volume and will independently observe
// the same mutation events; publishing to the Postgres bus would duplicate them
// across instances. Each instance dedupes against its own API broadcasts via the
// per-item signal in sse.ts.

import path from "node:path";
import { subscribeMutationEvents, type MutationEvent } from "@unbrained/pm-cli/sdk";
import { resolveProjectDir } from "./pm-runner.ts";
import {
  consumeSignaledItemMutation,
  deliverProjectEvent,
  getActiveProjectIds,
  type SSEEvent,
} from "./sse.ts";

const DEFAULT_INTERVAL_MS = 250;
const MIN_INTERVAL_MS = 10;
const DEFAULT_RECONCILE_MS = 2_000;
const MIN_RECONCILE_MS = 500;

/**
 * Read a positive-integer environment variable, with a fallback.
 *
 * Returns the parsed integer when the variable is set and parses to a finite,
 * positive value; otherwise returns `fallback`. Non-numeric or non-positive
 * values fall back rather than throwing.
 *
 * @param name - The environment variable name.
 * @param fallback - Value used when unset or invalid.
 * @returns The parsed positive integer, or the fallback.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-project subscription state held across reconcile cycles. */
interface ProjectSubscription {
  /** AbortController for the detached async loop consuming the generator. */
  controller: AbortController;
  /** Durable cursor from the last consumed event; used to resume after an error so no event is missed or duplicated. */
  cursor: string;
  /** True once the loop has exited (so reconcile knows to replace it). */
  done: boolean;
}

/** Options for the async generator subscription seam. Mirrors the SDK's `SubscribeMutationEventsOptions`. */
export interface SubscribeOptions {
  /** Tracker root path (`.agents/pm` under the project directory). */
  pmRoot: string;
  /** Opaque cursor or inclusive ISO timestamp lower bound. */
  since: string;
  /** Delay between empty catch-up reads. */
  intervalMs: number;
  /** Cancellation signal for a long-lived subscription. */
  signal: AbortSignal;
}

/** Result of the subscribe seam — an async generator yielding mutation events. */
export type SubscribeFn = (
  options: SubscribeOptions,
) => AsyncGenerator<MutationEvent, void, void>;

/** Dependencies for `createMutationEventReconciler`, all injectable for testing. */
export interface MutationEventWatcherDeps {
  /** Delay between empty catch-up reads passed to the SDK subscription (default 250, floor 10). */
  intervalMs?: number;
  /** Reconcile interval for the periodic sweep (default 2000, floor 500). */
  reconcileMs?: number;
  /** Returns the currently active (SSE-connected) project ids. */
  getActiveProjectIds?: () => string[];
  /** Resolves a project id to its on-disk directory, or null when the project row is absent. */
  resolveProjectDir?: (projectId: string) => Promise<string | null>;
  /** SDK subscription factory; defaults to the real `subscribeMutationEvents`. */
  subscribe?: SubscribeFn;
  /** Checks whether an item mutation was already announced by this instance; returns true and consumes it. */
  consumeSignaledItemMutation?: (projectId: string, itemId: string) => boolean;
  /** Emits an SSE event to the local clients of one project. */
  emit?: (projectId: string, event: SSEEvent) => void;
  /** Error sink for non-abort errors from a subscription loop. */
  onError?: (err: unknown) => void;
}

// Determine whether an error from the subscription loop is an AbortError caused
// by a deliberate stop (project went inactive or shutdown). Those must NOT be
// reported as errors — only genuine failures are routed to onError.
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || /^aborted/i.test(err.message);
  }
  return false;
}

/**
 * Pure, testable reconciler. Holds per-project subscription state across
 * reconcile cycles. Drives the watcher without timers — tests call `reconcile()`
 * directly. Follows the same dependency-injection style as `createProjectWatchCycle`.
 */
export function createMutationEventReconciler(deps: MutationEventWatcherDeps = {}): {
  reconcile: () => Promise<void>;
  stopAll: () => Promise<void>;
} {
  const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_MUTATION_EVENT_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const getIds = deps.getActiveProjectIds ?? getActiveProjectIds;
  const resolveDir = deps.resolveProjectDir ?? resolveProjectDir;
  const subscribe = deps.subscribe ?? subscribeMutationEvents;
  const consumeSignal = deps.consumeSignaledItemMutation ?? consumeSignaledItemMutation;
  const emit = deps.emit ?? deliverProjectEvent;
  const onError = deps.onError ?? (() => undefined);

  const subs = new Map<string, ProjectSubscription>();
  const dirCache = new Map<string, string | null>();
  let inFlight = false;

  // Start (or restart after error) a detached async loop that consumes the SDK
  // generator for one project. Runs independently of reconcile; errors abort
  // the subscription and the next reconcile re-establishes it from the stored cursor.
  function startLoop(projectId: string, dir: string, since: string): void {
    const controller = new AbortController();
    const sub: ProjectSubscription = { controller, cursor: since, done: false };
    subs.set(projectId, sub);

    const pmRoot = path.join(dir, ".agents", "pm");

    // Detached async loop — intentionally not awaited by reconcile.
    void (async () => {
      try {
        const gen = subscribe({ pmRoot, since, intervalMs, signal: controller.signal });
        for await (const event of gen) {
          sub.cursor = event.cursor;
          // Skip events that this instance's own API already announced (per-item dedupe).
          if (consumeSignal(projectId, event.item_id)) continue;
          emit(projectId, {
            type: "workspace-changed",
            data: {
              source: "mutation-events",
              itemId: event.item_id,
              operation: event.type,
              author: event.author,
            },
          });
        }
      } catch (err) {
        if (!isAbortError(err)) onError(err);
      } finally {
        sub.done = true;
      }
    })();
  }

  const reconcile = async (): Promise<void> => {
    if (inFlight) return; // never overlap reconciles
    inFlight = true;
    try {
      const ids = getIds();
      const active = new Set(ids);

      // Abort and drop subscriptions for projects no longer active.
      for (const [id, sub] of subs) {
        if (!active.has(id)) {
          sub.controller.abort();
          subs.delete(id);
          dirCache.delete(id);
        }
      }
      // Clean up dir cache for inactive projects.
      for (const id of [...dirCache.keys()]) if (!active.has(id)) dirCache.delete(id);

      for (const projectId of ids) {
        try {
          let dir = dirCache.get(projectId);
          if (dir === undefined) {
            dir = await resolveDir(projectId);
            dirCache.set(projectId, dir);
          }
          if (!dir) continue;

          const existing = subs.get(projectId);
          if (existing) {
            // If the loop exited (e.g. after an error), restart from the stored cursor.
            if (existing.done) {
              startLoop(projectId, dir, existing.cursor);
            }
          // Otherwise the loop is still running — leave it alone.
          } else {
            // Newly-active project: start at the tail (no history replay).
            startLoop(projectId, dir, new Date().toISOString());
          }
        } catch (err) {
          onError(err);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const stopAll = async (): Promise<void> => {
    for (const sub of subs.values()) sub.controller.abort();
    subs.clear();
    dirCache.clear();
  };

  return { reconcile, stopAll };
}

/**
 * Start the mutation-event watcher. Returns a stop function, mirroring
 * `startProjectWatcher`. Disabled entirely when `PM_REALTIME_MUTATION_EVENTS=false`.
 */
export function startMutationEventWatcher(deps: MutationEventWatcherDeps = {}): () => void {
  if (process.env.PM_REALTIME_MUTATION_EVENTS === "false") return () => undefined;
  const reconcileMs = Math.max(MIN_RECONCILE_MS, deps.reconcileMs ?? positiveIntEnv("PM_MUTATION_EVENT_RECONCILE_MS", DEFAULT_RECONCILE_MS));
  const onError = deps.onError ?? ((err: unknown) => console.error("Mutation-event watcher reconcile failed", err instanceof Error ? err.message : err));
  const { reconcile, stopAll } = createMutationEventReconciler({ ...deps, onError });
  const timer = setInterval(() => { void reconcile().catch(onError); }, reconcileMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    void stopAll();
  };
}