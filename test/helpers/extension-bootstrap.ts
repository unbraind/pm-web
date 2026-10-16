import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import builtExtension from "../../dist/index.js";

/** Real extension host and resources owned by one bootstrap fixture. */
interface ExtensionBootstrap {
  host: Awaited<ReturnType<typeof createExtensionTestHarness>>;
  root: string;
  detached: { pid?: number };
}

/** Check PID existence without hiding permission or other unexpected failures. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

/** Join detached shutdown, escalating once under bounded deadlines. */
async function stopDetached(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { process.kill(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 5_000;
    while (processExists(pid)) {
      if (Date.now() >= deadline) break;
      await delay(25);
    }
    if (!processExists(pid)) return;
  }
  throw new Error("Detached bootstrap process did not exit; workspace retained");
}

/** Own cleanup before creating a host, including creation and assertion failures. */
export async function withExtensionBootstrap(
  t: Pick<TestContext, "after">,
  environment: (root: string) => NodeJS.ProcessEnv,
  run: (fixture: ExtensionBootstrap) => Promise<void>,
  createHost = () => createExtensionTestHarness(builtExtension, { name: "pm-web", capabilities: ["commands", "schema"] }),
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-extension-bootstrap-"));
  const saved = { ...process.env };
  const detached: ExtensionBootstrap["detached"] = {};
  let host: ExtensionBootstrap["host"] | undefined;
  let cleanupResult: Promise<void> | undefined;
  /** Preserve the workspace until shutdown completes and always restore the environment. */
  async function cleanup(): Promise<void> {
    try {
      await stopDetached(detached.pid);
      try { await host?.deactivate(); }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }
  /** Reuse the same cleanup result when both the finally block and test hook run. */
  function cleanupOnce(): Promise<void> {
    return cleanupResult ??= cleanup();
  }
  t.after(cleanupOnce);
  try {
    const env = { ...environment(root), PM_WEB_STATE_DIR: root };
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    host = await createHost();
    await run({ host, root, detached });
  } finally {
    await cleanupOnce();
  }
}
