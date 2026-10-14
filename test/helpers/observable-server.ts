import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AppServer } from "./pg-harness.ts";

/** Bounded polling for observable asynchronous conditions, including server startup. */
export async function waitObservable(ready: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready() && Date.now() < deadline) await delay(20);
  assert.ok(ready(), message);
}

/** Launch the production entrypoint with a real projects root and capture stdout JSON.
 * The mutation stream is disabled so it cannot mask a broken filesystem link.
 */
export async function startObservableServer(root: string): Promise<AppServer & {
  logs: Record<string, unknown>[];
  stdout: () => string;
}> {
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, PORT: "0", PROJECTS_ROOT: root, LOG_LEVEL: "info",
      LOG_HMAC_SECRET: "synthetic-observability-hmac-secret", PM_WATCH_PROJECTS: "true",
      PM_WATCH_INTERVAL_MS: "500", PM_REALTIME_MUTATION_EVENTS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  const logs: Record<string, unknown>[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      logs.push(JSON.parse(line) as Record<string, unknown>);
      index = pending.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  /** Join graceful shutdown before releasing the test root. */
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  };
  try {
    await waitObservable(() => logs.some((log) => log.event === "server_started") || child.exitCode !== null, "server must start within deadline");
    assert.equal(child.exitCode, null, `server exited: ${stderr}`);
    const port = logs.find((log) => log.event === "server_started")?.port;
    assert.equal(typeof port, "number");
    return { port: Number(port), url: (suffix) => `http://127.0.0.1:${port}${suffix}`, close, logs, stdout: () => stdout };
  } catch (error) {
    await close();
    throw error;
  }
}
