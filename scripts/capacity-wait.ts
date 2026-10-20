/** Bounded readiness waits without SDK or database imports in client workers. */
import { setTimeout as delay } from "node:timers/promises";

/** Bound asynchronous lifecycle waits without polling outside the experiment. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      const codes: Record<string, string> = { "SSE connected frame": "SSE_CONNECTED_TIMEOUT", "complete project presence snapshot": "SSE_PRESENCE_TIMEOUT",
        "production server startup": "SERVER_STARTUP_TIMEOUT", "database sample completion": "DATABASE_SAMPLE_TIMEOUT", "database cleanup": "DATABASE_CLEANUP_TIMEOUT" };
      throw Object.assign(new Error(`Capacity timeout: ${label}`), { code: codes[label] ?? "CAPACITY_WAIT_TIMEOUT" });
    }
    await delay(20);
  }
}

