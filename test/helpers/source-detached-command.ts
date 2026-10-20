/** Exercise the source lifecycle helper against the actual emitted server. */
import path from "node:path";
import { startDetached } from "../../src/detached-start.ts";

// Configure only the spawned child when injecting a bootstrap log failure.
if (process.env.TEST_CHILD_NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.TEST_CHILD_NODE_OPTIONS;

const port = process.env.PORT!;
const pidfile = path.join(process.env.PM_WEB_STATE_DIR!, `pm-web-${port}.pid`);
try {
  const child = await startDetached(path.resolve("dist/server.js"), port, pidfile, Number(process.env.PM_WEB_STARTUP_TIMEOUT_MS));
  console.log(JSON.stringify({ status: "started", pid: child.pid }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Detached startup failed");
  process.exitCode = 1;
}
