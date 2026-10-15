/** Bounded overlap for committed facts whose mutation timestamps precede their visibility. */
import { type MutationEvent, type SubscribeMutationEventsOptions } from "@unbrained/pm-cli/sdk";
/** One minute covers the web command timeout and the capacity writer timeout, with scheduling headroom. */
export declare const MUTATION_REPLAY_WINDOW_MS = 60000;
/** Bound per-active-project dedupe memory; overflow is reported rather than silently evicting live keys. */
export declare const MUTATION_REPLAY_MAX_EVENTS = 10000;
/** State survives subscription restarts, preventing a replay after an SDK read error from duplicating delivery. */
export interface MutationReplayState {
    /** Inclusive attachment time, excluding pre-existing history on first connection. */
    baseline: number;
    /** Item/version keys and their mutation times within the retained overlap. */
    seen: Map<string, number>;
}
/** Allocate replay state at project attachment, excluding older history from initial delivery. */
export declare function createMutationReplayState(): MutationReplayState;
/**
 * Re-read a bounded timestamp window rather than advancing an exclusive timestamp cursor forever.
 * A writer assigns its history timestamp before final persistence; another writer's later timestamp
 * can become visible first. Paging with the exclusive cursor alone then permanently skips the late
 * fact. Each poll starts again at the inclusive window floor and dedupes by item/version, while
 * pagination within that poll retains the SDK's ordered cursor. The yielded resume boundary is
 * the inclusive floor, so a restart can recover every unconsumed fact in the window.
 */
export declare function followCommittedMutations(options: SubscribeMutationEventsOptions, state: MutationReplayState): AsyncGenerator<MutationEvent, void, void>;
