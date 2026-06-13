// pm-web — Extension wrapper for the pm-web server
// This file registers the web server as a pm extension command.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Inline defineExtension helper (avoids runtime dependency on @unbrained/pm-cli/sdk)
function defineExtension<T>(m: T): T { return m; }

// Minimal type stubs so TypeScript is satisfied without the SDK package
interface ExtensionApi {
  registerCommand(def: {
    name: string;
    description: string;
    intent?: string;
    examples?: string[];
    flags?: Array<{ long: string; value_name?: string; description: string }>;
    run(ctx: CommandHandlerContext): Promise<unknown>;
  }): void;
  // Present on the v2 SDK runtime; guarded with a typeof check before use.
  registerService?: (service: string, override: (ctx: unknown) => unknown) => void;
}

interface CommandHandlerContext {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  global: Record<string, unknown>;
  pm_root: string;
}

// ---------------------------------------------------------------------------
// Error contract
// CommandError carries a numeric exitCode so the pm runtime surfaces a clean
// failure instead of double-invoking the handler on a plain thrown Error.
//   1 = generic, 2 = usage, 3 = not-found
// ---------------------------------------------------------------------------
class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

let serverProcess: ReturnType<typeof spawn> | null = null;

const DEFAULT_PORT = "4000";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/)
// ---------------------------------------------------------------------------

/** Resolve the port from flag → PORT env → default 4000. */
export function resolvePort(
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const flag = options["port"];
  if (flag !== undefined && flag !== null && String(flag).length > 0) {
    return String(flag);
  }
  if (env["PORT"] && String(env["PORT"]).length > 0) {
    return String(env["PORT"]);
  }
  return DEFAULT_PORT;
}

/**
 * Resolve the pidfile path used to track a detached server.
 * Uses PM_WEB_STATE_DIR when set, else the OS temp dir, keyed by port so
 * multiple detached servers don't clobber each other's pidfile.
 */
export function pidfilePath(
  port: string | number,
  env: NodeJS.ProcessEnv = process.env,
  tmpDir: string = os.tmpdir(),
): string {
  const baseDir = env["PM_WEB_STATE_DIR"] && String(env["PM_WEB_STATE_DIR"]).length > 0
    ? String(env["PM_WEB_STATE_DIR"])
    : tmpDir;
  return path.join(baseDir, `pm-web-${String(port)}.pid`);
}

/** Shape a /healthz probe outcome into a stable status result object. */
export function shapeStatusResult(input: {
  port: string | number;
  reachable: boolean;
  body?: unknown;
  error?: string;
}): {
  status: "up" | "down";
  port: number;
  reachable: boolean;
  url: string;
  version: string | null;
  healthz: unknown;
  error?: string;
} {
  const portNum = Number(input.port);
  const body = (input.body ?? null) as Record<string, unknown> | null;
  const version =
    body && typeof body["version"] === "string" ? (body["version"] as string) : null;
  const result: {
    status: "up" | "down";
    port: number;
    reachable: boolean;
    url: string;
    version: string | null;
    healthz: unknown;
    error?: string;
  } = {
    status: input.reachable ? "up" : "down",
    port: portNum,
    reachable: input.reachable,
    url: `http://localhost:${portNum}/healthz`,
    version,
    healthz: input.body ?? null,
  };
  if (input.error) result.error = input.error;
  return result;
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function runtimeDependenciesInstalled(): boolean {
  const expressPackage = path.join(packageRoot, "node_modules", "express", "package.json");
  return fs.existsSync(expressPackage);
}

function ensureRuntimeDependencies(): void {
  if (runtimeDependenciesInstalled()) return;

  console.error("Installing pm-web runtime dependencies...");
  const install = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (install.error) throw install.error;
  if (install.status !== 0) {
    throw new CommandError(
      `npm install --omit=dev failed with exit code ${install.status ?? "unknown"}`,
    );
  }
}

/** HTTP GET /healthz with a short timeout. Never throws; returns a probe result. */
async function probeHealthz(
  port: string,
): Promise<{ reachable: boolean; body?: unknown; error?: string }> {
  const url = `http://localhost:${port}/healthz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { reachable: res.ok, body };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Check whether a TCP port is free to bind locally. Never throws. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

function pmOnPath(): boolean {
  const probe = spawnSync("pm", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function workspaceInitialized(pmRoot: string): boolean {
  if (!pmRoot) return false;
  // A pm workspace has a settings.json plus item-type directories under the
  // pm root (e.g. tasks/, features/). Match on the settings file or a known
  // item-type dir so detection is robust across pm versions.
  if (!fs.existsSync(pmRoot)) return false;
  return (
    fs.existsSync(path.join(pmRoot, "settings.json")) ||
    fs.existsSync(path.join(pmRoot, "schema")) ||
    fs.existsSync(path.join(pmRoot, "tasks"))
  );
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (treat as alive)
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export default defineExtension({
  name: "pm-web",
  version: "2026.6.13-2",

  activate(api: ExtensionApi) {
    // -----------------------------------------------------------------------
    // Command: pm web [--port <port>] [--detach]
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "web",
      description:
        "Start the pm-web server. Opens a browser-based UI for managing pm projects.",
      intent: "launch the pm-web server",
      examples: [
        "pm web",
        "pm web --port 8080",
        "pm web --detach",
      ],
      flags: [
        { long: "--port", value_name: "port", description: "Port to listen on (default: 4000 or PORT env var)" },
        { long: "--detach", description: "Run the server in the background" },
      ],
      async run(ctx: CommandHandlerContext) {
        const port = resolvePort(ctx.options);
        const detach = Boolean(ctx.options["detach"]);

        const serverPath = path.resolve(__dirname, "server.js");
        ensureRuntimeDependencies();

        if (detach) {
          if (serverProcess) {
            console.error(`pm-web is already running (PID ${serverProcess.pid})`);
            return { status: "already_running", pid: serverProcess.pid };
          }

          serverProcess = spawn("node", [serverPath], {
            env: { ...process.env, PORT: String(port) },
            detached: true,
            stdio: "ignore",
          });

          serverProcess.unref();

          // Track the detached PID so `pm web stop` can terminate it.
          if (serverProcess.pid) {
            try {
              fs.writeFileSync(pidfilePath(port), String(serverProcess.pid), "utf8");
            } catch (err) {
              console.error(
                `Warning: could not write pidfile: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          console.error(`pm-web started on port ${port} (PID ${serverProcess.pid})`);
          return { status: "started", port: Number(port), pid: serverProcess.pid };
        }

        // Foreground mode — the server takes over the process
        console.error(`Starting pm-web on port ${port}…`);
        console.error("Press Ctrl+C to stop.\n");

        const child = spawn("node", [serverPath], {
          env: { ...process.env, PORT: String(port) },
          stdio: "inherit",
        });

        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code, signal) => {
            if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
              resolve();
              return;
            }
            reject(new CommandError(`pm-web exited with code ${code ?? `signal ${signal}`}`));
          });
        });

        return { status: "stopped", port: Number(port) };
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm web status [--port <port>] [--json]
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "web status",
      description: "Report whether a pm-web server is reachable on the configured port.",
      intent: "check pm-web server status",
      examples: ["pm web status", "pm web status --port 8080 --json"],
      flags: [
        { long: "--port", value_name: "port", description: "Port to probe (default: 4000 or PORT env var)" },
        { long: "--json", description: "Emit machine-readable JSON" },
      ],
      async run(ctx: CommandHandlerContext) {
        const port = resolvePort(ctx.options);
        const json = Boolean(ctx.options["json"]);

        const probe = await probeHealthz(port);
        const result = shapeStatusResult({
          port,
          reachable: probe.reachable,
          body: probe.body,
          error: probe.error,
        });

        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.status === "up") {
          console.log(
            `pm-web is UP on port ${result.port}` +
              (result.version ? ` (version ${result.version})` : ""),
          );
        } else {
          console.log(`pm-web is DOWN on port ${result.port}`);
        }
        return result;
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm web stop [--port <port>] [--json]
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "web stop",
      description: "Stop a pm-web server previously started with --detach.",
      intent: "stop a detached pm-web server",
      examples: ["pm web stop", "pm web stop --port 8080"],
      flags: [
        { long: "--port", value_name: "port", description: "Port of the detached server (default: 4000 or PORT env var)" },
        { long: "--json", description: "Emit machine-readable JSON" },
      ],
      async run(ctx: CommandHandlerContext) {
        const port = resolvePort(ctx.options);
        const json = Boolean(ctx.options["json"]);
        const pidfile = pidfilePath(port);

        const emit = (result: Record<string, unknown>) => {
          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(String(result["message"]));
          }
          return result;
        };

        // Prefer the in-process handle if we started it this session.
        let pid: number | null = null;
        if (serverProcess?.pid) {
          pid = serverProcess.pid;
        } else if (fs.existsSync(pidfile)) {
          const raw = fs.readFileSync(pidfile, "utf8").trim();
          const parsed = Number.parseInt(raw, 10);
          if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
        }

        if (pid === null) {
          return emit({
            status: "not_running",
            port: Number(port),
            message: `pm-web is not running (no pidfile for port ${port}).`,
          });
        }

        if (!processAlive(pid)) {
          // Stale pidfile — clean it up and report gracefully.
          if (fs.existsSync(pidfile)) fs.rmSync(pidfile, { force: true });
          return emit({
            status: "not_running",
            port: Number(port),
            pid,
            message: `pm-web process (PID ${pid}) is not running; cleared stale pidfile.`,
          });
        }

        try {
          process.kill(pid, "SIGTERM");
        } catch (err) {
          throw new CommandError(
            `Failed to stop pm-web (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (fs.existsSync(pidfile)) fs.rmSync(pidfile, { force: true });
        if (serverProcess?.pid === pid) serverProcess = null;

        return emit({
          status: "stopped",
          port: Number(port),
          pid,
          message: `Stopped pm-web (PID ${pid}) on port ${port}.`,
        });
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm web doctor [--port <port>] [--json]
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "web doctor",
      description: "Preflight diagnostics for running pm-web (Node, deps, port, pm, workspace).",
      intent: "diagnose pm-web preflight readiness",
      examples: ["pm web doctor", "pm web doctor --json"],
      flags: [
        { long: "--port", value_name: "port", description: "Port to check availability for (default: 4000 or PORT env var)" },
        { long: "--json", description: "Emit machine-readable JSON" },
      ],
      async run(ctx: CommandHandlerContext) {
        const port = resolvePort(ctx.options);
        const json = Boolean(ctx.options["json"]);

        const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
        const depsInstalled = runtimeDependenciesInstalled();
        const portFree = await isPortFree(Number(port));
        const pmAvailable = pmOnPath();
        const wsInit = workspaceInitialized(ctx.pm_root);

        const checks = [
          {
            name: "node_version",
            ok: nodeMajor >= 20,
            detail: `Node ${process.versions.node} (requires >= 20)`,
          },
          {
            name: "runtime_dependencies",
            ok: depsInstalled,
            detail: depsInstalled
              ? "express and runtime deps installed"
              : "runtime deps missing (will auto-install on `pm web`)",
          },
          {
            name: "port_available",
            ok: portFree,
            detail: portFree
              ? `port ${port} is free`
              : `port ${port} is in use (a server may already be running)`,
          },
          {
            name: "pm_on_path",
            ok: pmAvailable,
            detail: pmAvailable ? "pm CLI is on PATH" : "pm CLI not found on PATH",
          },
          {
            name: "workspace_initialized",
            ok: wsInit,
            detail: wsInit
              ? `pm workspace found at ${ctx.pm_root}`
              : `no pm workspace at ${ctx.pm_root || "(unset)"} — run \`pm init\``,
          },
        ];

        // port_available is informational (in-use can be a healthy running server),
        // so it does not gate overall readiness.
        const ok = checks
          .filter((c) => c.name !== "port_available")
          .every((c) => c.ok);

        const result = {
          ok,
          version: readPackageVersion(),
          node: process.versions.node,
          port: Number(port),
          checks,
        };

        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`pm-web doctor — overall: ${ok ? "OK" : "ISSUES"}`);
          for (const c of checks) {
            console.log(`  [${c.ok ? "ok" : "!!"}] ${c.name}: ${c.detail}`);
          }
        }
        return result;
      },
    });

    // -----------------------------------------------------------------------
    // services capability — intentionally NOT registered.
    //
    // The SDK's `registerService(name, override)` only accepts one of the eight
    // fixed CORE service names (output_format, error_format, help_format,
    // lock_acquire, lock_release, history_append, item_store_write,
    // item_store_delete) and OVERRIDES that core service on every pm command.
    // There is no API to register a new "pm-web lifecycle" service, and
    // overriding a core service would alter/replace core output for unrelated
    // commands. The pm-web server lifecycle is surfaced safely via the
    // web/status/stop/doctor commands instead. The guarded block below
    // documents the deliberate no-op; the "services" capability is therefore
    // NOT declared in manifest.json.
    if (typeof api.registerService === "function") {
      // Deliberately register no service overrides — see comment above.
    }
  },
});
