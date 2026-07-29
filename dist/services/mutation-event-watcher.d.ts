import { type MutationEvent } from "@unbrained/pm-cli/sdk";
import { type SSEEvent } from "./sse.ts";
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
export type SubscribeFn = (options: SubscribeOptions) => AsyncGenerator<MutationEvent, void, void>;
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
/**
 * Pure, testable reconciler. Holds per-project subscription state across
 * reconcile cycles. Drives the watcher without timers — tests call `reconcile()`
 * directly. Follows the same dependency-injection style as `createProjectWatchCycle`.
 */
export declare function createMutationEventReconciler(deps?: MutationEventWatcherDeps): {
    reconcile: () => Promise<void>;
    stopAll: () => Promise<void>;
};
/**
 * Start the mutation-event watcher. Returns a stop function, mirroring
 * `startProjectWatcher`. Disabled entirely when `PM_REALTIME_MUTATION_EVENTS=false`.
 */
export declare function startMutationEventWatcher(deps?: MutationEventWatcherDeps): () => void;
