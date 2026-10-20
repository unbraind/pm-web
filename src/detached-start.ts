import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { redactStartupLog } from "./startup-config.ts";

/** Start the built server and retain its handle only after its own listener is healthy. */
export async function startDetached(serverPath: string, port: string, pidfile: string, timeout: number): Promise<ChildProcess> {
  if (fs.existsSync(pidfile)) {
    const pid = Number(fs.readFileSync(pidfile, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error("A live PID already owns this pidfile; use pm web status or pm web stop first."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    fs.rmSync(pidfile);
  }
  const logfile = `${pidfile}.log`;
  const logFd = fs.openSync(logfile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  fs.fchmodSync(logFd, 0o600);
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: port, PM_WEB_STARTUP_TIMEOUT_MS: String(timeout) }, detached: true, stdio: ["ignore", logFd, logFd, "ipc"],
  });
  fs.closeSync(logFd);
  let listeningPort: number | undefined;
  let exited = false;
  let spawnFailed = false;
  const closed = new Promise<void>((resolve) => { child.once("close", () => { exited = true; resolve(); }); });
  child.once("error", () => { spawnFailed = true; });
  child.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "type" in message && message.type === "pm-web-listening" && "port" in message && typeof message.port === "number") listeningPort = message.port;
  });
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      if (exited || spawnFailed) break;
      if (listeningPort !== undefined) {
        let healthy = false;
        try {
          const response = await fetch(`http://127.0.0.1:${listeningPort}/healthz`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
          const body = await response.json() as { ok?: unknown };
          healthy = response.ok && body.ok === true;
        } catch { /* A dependency can become healthy before the deadline. */ }
        if (healthy && child.exitCode === null && child.signalCode === null && !exited) {
          fs.writeFileSync(pidfile, String(child.pid), { encoding: "utf8", mode: 0o600, flag: "wx" });
          child.disconnect();
          child.unref();
          return child;
        }
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    throw new Error(exited || spawnFailed ? "child exited before becoming healthy" : `health timeout after ${timeout}ms; set --startup-timeout or PM_WEB_STARTUP_TIMEOUT_MS`);
  } catch (error) {
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([closed, delay(1000)]);
      if (!exited) { child.kill("SIGKILL"); await closed; }
    }
    if (fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").trim() === String(child.pid)) fs.rmSync(pidfile);
    const pidState = fs.existsSync(pidfile) ? "present (not owned by this child)" : "absent (no stale pidfile)";
    const fd = fs.openSync(logfile, "r");
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 16384));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    fs.closeSync(fd);
    let tail = buffer.toString("utf8");
    if (size > buffer.length) {
      // An incomplete first line can start inside a credential or URL.
      const newline = tail.indexOf("\n");
      tail = newline < 0 ? "" : tail.slice(newline + 1);
    }
    const logs = redactStartupLog(tail).trim().split("\n").slice(-10).join("\n") || "(no complete child log lines in the retained tail)";
    throw new Error(`Detached startup failed: ${error instanceof Error ? error.message : "startup error"}.\npidfile: ${pidState}\nLast child log lines (redacted):\n${logs}`);
  }
}
