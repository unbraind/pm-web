import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { authHeaders, type AppServer, type SeedUser } from "./pg-harness.ts";

/** A decoded message received from the production HTTP SSE endpoint. */
export interface LiveEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Keep a real SSE connection open while collecting complete wire frames. */
export async function connectLiveSSE(server: AppServer, user: SeedUser, projectId: string): Promise<{
  events: LiveEvent[];
  waitFor: (predicate: (events: LiveEvent[]) => boolean) => Promise<void>;
  close: () => Promise<void>;
}> {
  const controller = new AbortController();
  const response = await fetch(server.url(`/api/projects/${projectId}/pm/events?view=items`), {
    headers: authHeaders(user), signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(response.body);
  const events: LiveEvent[] = [];
  let failure: unknown;
  const body = response.body;
  const reading = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        pending += decoder.decode(chunk, { stream: true });
        let end = pending.indexOf("\n\n");
        while (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
          end = pending.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) failure = error;
    }
  })();
  return {
    events,
    /** Wait for an observable wire condition within a bounded deadline. */
    waitFor: async (predicate) => {
      const deadline = Date.now() + 5_000;
      while (!predicate(events) && Date.now() < deadline) {
        if (failure !== undefined) throw failure;
        await delay(10);
      }
      if (failure !== undefined) throw failure;
      assert.ok(predicate(events), `SSE condition timed out: ${JSON.stringify(events)}`);
    },
    /** Abort the socket and join its read loop before stopping the HTTP server. */
    close: async () => {
      controller.abort();
      await reading;
      if (failure !== undefined) throw failure;
    },
  };
}
