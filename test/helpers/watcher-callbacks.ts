/**
 * Shared watcher callback helpers used by project-watcher and
 * mutation-event-watcher test suites to avoid duplicating the emit/onError
 * callback pattern.
 */
import type { SSEEvent } from "../../src/services/sse.ts";

export interface EmitRecord {
  projectId: string;
  event: SSEEvent;
}

/** Standard emit + onError callbacks that push to arrays for test assertions. */
export function stdWatcherCallbacks(emitted: EmitRecord[], errors: unknown[]) {
  return {
    emit: (projectId: string, event: SSEEvent) => { emitted.push({ projectId, event }); },
    onError: (err: unknown) => { errors.push(err); },
  };
}