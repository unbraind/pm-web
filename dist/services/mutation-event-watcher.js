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
import { subscribeMutationEvents } from "@unbrained/pm-cli/sdk";
import { pool } from "../db.js";
import { getProjectDir } from "./pm-runner.js";
import { consumeSignaledItemMutation, deliverProjectEvent, getActiveProjectIds, } from "./sse.js";
const DEFAULT_INTERVAL_MS = 250;
const MIN_INTERVAL_MS = 10;
const DEFAULT_RECONCILE_MS = 2_000;
const MIN_RECONCILE_MS = 500;
function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function defaultResolveProjectDir(projectId) {
    // Do NOT swallow DB errors here: a transient `pool.query` failure must reach
    // the reconciler's per-project try/catch (→ onError) so it is retried on the
    // next reconcile. Swallowing it would permanently stop watching this project.
    // `null` is returned only when the row is genuinely absent.
    const res = await pool.query("SELECT user_id, slug FROM pm_projects WHERE id = $1", [projectId]);
    const row = res.rows[0];
    if (!row)
        return null;
    return getProjectDir(row.user_id, row.slug);
}
// Determine whether an error from the subscription loop is an AbortError caused
// by a deliberate stop (project went inactive or shutdown). Those must NOT be
// reported as errors — only genuine failures are routed to onError.
function isAbortError(err) {
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
export function createMutationEventReconciler(deps = {}) {
    const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_MUTATION_EVENT_INTERVAL_MS", DEFAULT_INTERVAL_MS));
    const getIds = deps.getActiveProjectIds ?? getActiveProjectIds;
    const resolveDir = deps.resolveProjectDir ?? defaultResolveProjectDir;
    const subscribe = deps.subscribe ?? subscribeMutationEvents;
    const consumeSignal = deps.consumeSignaledItemMutation ?? consumeSignaledItemMutation;
    const emit = deps.emit ?? deliverProjectEvent;
    const onError = deps.onError ?? (() => undefined);
    const subs = new Map();
    const dirCache = new Map();
    let inFlight = false;
    // Start (or restart after error) a detached async loop that consumes the SDK
    // generator for one project. Runs independently of reconcile; errors abort
    // the subscription and the next reconcile re-establishes it from the stored cursor.
    function startLoop(projectId, dir, since) {
        const controller = new AbortController();
        const sub = { controller, cursor: since, done: false };
        subs.set(projectId, sub);
        const pmRoot = path.join(dir, ".agents", "pm");
        // Detached async loop — intentionally not awaited by reconcile.
        void (async () => {
            try {
                const gen = subscribe({ pmRoot, since, intervalMs, signal: controller.signal });
                for await (const event of gen) {
                    sub.cursor = event.cursor;
                    // Skip events that this instance's own API already announced (per-item dedupe).
                    if (consumeSignal(projectId, event.item_id))
                        continue;
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
            }
            catch (err) {
                if (!isAbortError(err))
                    onError(err);
            }
            finally {
                sub.done = true;
            }
        })();
    }
    const reconcile = async () => {
        if (inFlight)
            return; // never overlap reconciles
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
            for (const id of [...dirCache.keys()])
                if (!active.has(id))
                    dirCache.delete(id);
            for (const projectId of ids) {
                try {
                    let dir = dirCache.get(projectId);
                    if (dir === undefined) {
                        dir = await resolveDir(projectId);
                        dirCache.set(projectId, dir);
                    }
                    if (!dir)
                        continue;
                    const existing = subs.get(projectId);
                    if (existing) {
                        // If the loop exited (e.g. after an error), restart from the stored cursor.
                        if (existing.done) {
                            startLoop(projectId, dir, existing.cursor);
                        }
                        // Otherwise the loop is still running — leave it alone.
                    }
                    else {
                        // Newly-active project: start at the tail (no history replay).
                        startLoop(projectId, dir, new Date().toISOString());
                    }
                }
                catch (err) {
                    onError(err);
                }
            }
        }
        finally {
            inFlight = false;
        }
    };
    const stopAll = async () => {
        for (const sub of subs.values())
            sub.controller.abort();
        subs.clear();
        dirCache.clear();
    };
    return { reconcile, stopAll };
}
/**
 * Start the mutation-event watcher. Returns a stop function, mirroring
 * `startProjectWatcher`. Disabled entirely when `PM_REALTIME_MUTATION_EVENTS=false`.
 */
export function startMutationEventWatcher(deps = {}) {
    if (process.env.PM_REALTIME_MUTATION_EVENTS === "false")
        return () => undefined;
    const reconcileMs = Math.max(MIN_RECONCILE_MS, deps.reconcileMs ?? positiveIntEnv("PM_MUTATION_EVENT_RECONCILE_MS", DEFAULT_RECONCILE_MS));
    const onError = deps.onError ?? ((err) => console.error("Mutation-event watcher reconcile failed", err instanceof Error ? err.message : err));
    const { reconcile, stopAll } = createMutationEventReconciler({ ...deps, onError });
    const timer = setInterval(() => { void reconcile().catch(onError); }, reconcileMs);
    timer.unref();
    return () => {
        clearInterval(timer);
        void stopAll();
    };
}
//# sourceMappingURL=mutation-event-watcher.js.map