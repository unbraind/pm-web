import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import {
  getItemAt,
  PmClient,
  PmCliError,
  isPmCliExpectedError,
  EXIT_CODE,
  type GetItemAtResult,
} from "@unbrained/pm-cli/sdk";

// Re-exported so route handlers and tests can reference the verified projection
// shape and the typed error class without reaching into the SDK package map.
export { PmCliError, isPmCliExpectedError, EXIT_CODE, type GetItemAtResult };

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

const commandSlots = new Semaphore(positiveInteger(process.env.PM_WEB_PM_CONCURRENCY, 8));
const workspaceTails = new Map<string, Promise<void>>();

export function projectsRoot(): string {
  return process.env.PROJECTS_ROOT || "/app/projects";
}
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ||
  process.env.OLLAMA_HOST ||
  "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL =
  process.env.PM_OLLAMA_MODEL ||
  "qwen3-embedding:0.6b";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const PM_GRAPH_EXTENSION_PATH =
  process.env.PM_GRAPH_EXTENSION_PATH ||
  path.join(process.cwd(), "extensions", "pm-graph");

export function getProjectDir(userId: string, slug: string): string {
  return path.join(projectsRoot(), userId, slug);
}

/**
 * Resolve a project id to its on-disk directory, or `null` when the project row
 * is genuinely absent.
 *
 * Shared by both out-of-band change detectors (the mutation-event subscription
 * and the filesystem safety-net sweep), which each cache the result per active
 * SSE session. It lives here because this module already owns the
 * project-id → path mapping via {@link getProjectDir}.
 *
 * Database errors are deliberately **not** swallowed: a transient `pool.query`
 * failure must reach the caller's per-project error handling so the lookup is
 * retried. Returning `null` on failure would let a caller cache "no such
 * project" for the whole session and permanently stop watching it. `null`
 * therefore means "the row is absent", which is safe to cache.
 */
export async function resolveProjectDir(projectId: string): Promise<string | null> {
  const res = await pool.query<{ user_id: string; slug: string }>(
    "SELECT user_id, slug FROM pm_projects WHERE id = $1",
    [projectId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return getProjectDir(row.user_id, row.slug);
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  ok: boolean;
}

interface PmCommand {
  command: string;
  prefixArgs: string[];
}

let cachedPmCommand: PmCommand | undefined;

function pmCliCommand(): PmCommand {
  if (process.env.PM_CLI_BIN) return { command: process.env.PM_CLI_BIN, prefixArgs: [] };
  if (cachedPmCommand) return cachedPmCommand;

  if (process.platform === "win32") {
    const entry = path.join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
    cachedPmCommand = fs.existsSync(entry)
      ? { command: process.execPath, prefixArgs: [entry] }
      : { command: "pm", prefixArgs: [] };
    return cachedPmCommand;
  }

  const local = path.join(process.cwd(), "node_modules", ".bin", "pm");
  cachedPmCommand = fs.existsSync(local)
    ? { command: local, prefixArgs: [] }
    : { command: "pm", prefixArgs: [] };
  return cachedPmCommand;
}

async function runProcess(
  cwd: string,
  args: string[],
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return new Promise((resolve) => {
    const pmCommand = pmCliCommand();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(pmCommand.command, [...pmCommand.prefixArgs, ...args], {
        cwd,
        env: { ...process.env, HOME: "/tmp", NO_COLOR: "1", ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        ok: false,
      });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure = "";
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const terminate = (reason: string): void => {
      if (failure) return;
      failure = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    };
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(`pm command exceeded the ${MAX_OUTPUT_BYTES}-byte output limit`);
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      failure = error.message;
    });

    const timeout = setTimeout(() => terminate(`pm command timed out after ${timeoutMs}ms`), timeoutMs);
    timeout.unref();
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: failure ? `${stderrText}${stderrText ? "\n" : ""}${failure}` : stderrText,
        ok: code === 0 && !failure,
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

async function runSerialized<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const previous = workspaceTails.get(workspace) ?? Promise.resolve();
  let releaseWorkspace!: () => void;
  const gate = new Promise<void>((resolve) => { releaseWorkspace = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  workspaceTails.set(workspace, tail);

  await previous.catch(() => undefined);
  const releaseSlot = await commandSlots.acquire();
  try {
    return await work();
  } finally {
    releaseSlot();
    releaseWorkspace();
    void tail.finally(() => {
      if (workspaceTails.get(workspace) === tail) workspaceTails.delete(workspace);
    });
  }
}

export async function initProject(userId: string, slug: string, prefix: string): Promise<void> {
  const dir = getProjectDir(userId, slug);
  fs.mkdirSync(dir, { recursive: true });
  const result = await runSerialized(dir, () => runProcess(dir, ["init", prefix], { timeoutMs: 15_000 }));
  if (!result.ok) throw new Error(result.stderr || "pm init failed");
  configureLocalOllamaSearch(dir);
  await ensureGraphExtension(userId, slug);
}

function configureLocalOllamaSearch(projectDir: string): void {
  const settingsPath = path.join(projectDir, ".agents", "pm", "settings.json");
  if (!fs.existsSync(settingsPath)) return;

  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    search?: Record<string, unknown>;
    providers?: { ollama?: Record<string, unknown> };
    vector_store?: { lancedb?: Record<string, unknown> };
  };

  settings.search = {
    ...(settings.search ?? {}),
    embedding_model: OLLAMA_EMBEDDING_MODEL,
  };
  settings.providers = {
    ...(settings.providers ?? {}),
    ollama: {
      ...(settings.providers?.ollama ?? {}),
      base_url: OLLAMA_BASE_URL,
      model: OLLAMA_EMBEDDING_MODEL,
    },
  };
  settings.vector_store = {
    ...(settings.vector_store ?? {}),
    lancedb: {
      ...(settings.vector_store?.lancedb ?? {}),
      path: ".agents/pm/search/lancedb/",
    },
  };

  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function projectExists(userId: string, slug: string): boolean {
  const dir = getProjectDir(userId, slug);
  return fs.existsSync(path.join(dir, ".agents", "pm", "settings.json"));
}

export interface PmRunOptions {
  args: string[];
  userId: string;
  slug: string;
  input?: string;
  jsonOutput?: boolean;
  timeoutMs?: number;
}

export interface PmRunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  parsed?: unknown;
  /**
   * pm CLI exit code from a {@link PmCliError} when the in-process dispatcher
   * translated an expected validation failure. Routes that want precise 4xx
   * mapping can branch on this; the string `stderr` always carries the message.
   */
  exitCode?: number;
}

export interface EnsureGraphExtensionResult {
  ok: boolean;
  installed: boolean;
  active: boolean;
  error?: string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function bundledGraphExtensionManifest(): { name?: string; version?: string } | null {
  const manifestPath = path.join(PM_GRAPH_EXTENSION_PATH, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return readJsonFile<{ name?: string; version?: string }>(manifestPath);
}

function projectGraphExtensionManifest(projectDir: string): { name?: string; version?: string } | null {
  return readJsonFile<{ name?: string; version?: string }>(
    path.join(projectDir, ".agents", "pm", "extensions", "pm-graph", "manifest.json")
  );
}

async function graphExtensionIsActive(projectDir: string): Promise<boolean> {
  const result = await runSerialized(projectDir, () =>
    runProcess(projectDir, ["extension", "explore", "--project", "--json"], { timeoutMs: 15_000 }),
  );
  if (!result.ok || !result.stdout) return false;

  try {
    const parsed = JSON.parse(result.stdout) as {
      details?: { extensions?: Array<{ name?: string; active?: boolean; enabled?: boolean }> };
    };
    return Boolean(parsed.details?.extensions?.some((extension) =>
      extension.name === "pm-graph" && extension.active && extension.enabled
    ));
  } catch {
    return false;
  }
}

async function runExtensionCommand(projectDir: string, args: string[]): Promise<PmRunResult> {
  return runSerialized(projectDir, () => runProcess(projectDir, args));
}

export async function ensureGraphExtension(userId: string, slug: string): Promise<EnsureGraphExtensionResult> {
  const dir = getProjectDir(userId, slug);
  const bundledManifest = bundledGraphExtensionManifest();
  if (!bundledManifest) {
    return {
      ok: false,
      installed: false,
      active: false,
      error: `Bundled pm-graph extension not found at ${PM_GRAPH_EXTENSION_PATH}`,
    };
  }

  const projectManifest = projectGraphExtensionManifest(dir);
  const needsInstall = !projectManifest || projectManifest.version !== bundledManifest.version;
  if (needsInstall) {
    const install = await runExtensionCommand(dir, ["install", PM_GRAPH_EXTENSION_PATH, "--project"]);
    if (!install.ok) {
      return {
        ok: false,
        installed: Boolean(projectManifest),
        active: false,
        error: install.stderr || install.stdout || "Failed to install bundled pm-graph extension.",
      };
    }
  }

  if (!(await graphExtensionIsActive(dir))) {
    const activate = await runExtensionCommand(dir, ["extension", "activate", "pm-graph", "--project"]);
    if (!activate.ok) {
      return {
        ok: false,
        installed: true,
        active: false,
        error: activate.stderr || activate.stdout || "Failed to activate bundled pm-graph extension.",
      };
    }
  }

  const ping = await runExtensionCommand(dir, ["pm-graph", "ping", "--json"]);
  if (!ping.ok) {
    return {
      ok: false,
      installed: true,
      active: false,
      error: ping.stderr || ping.stdout || "Bundled pm-graph extension is installed but did not activate at runtime.",
    };
  }

  return { ok: true, installed: true, active: true };
}

// ---------------------------------------------------------------------------
// In-process SDK dispatch
// ---------------------------------------------------------------------------
//
// The per-request `pm` binary spawn was the single biggest scalability defect
// in this package: every read/write of a workspace forked a node process, ran
// the CLI bootstrap, and acquired file locks through the OS. The pm CLI SDK
// (2026.7.26) exposes the same command runners the CLI uses as a typed,
// in-process `PmClient`. We now dispatch latency-bounded actions through one
// cached client configuration per workspace pm-root and retain the bounded
// spawn path for unsupported or potentially long-running actions. The latter
// prevents the SDK's process-wide activation queue from head-of-line blocking
// unrelated workspaces (tracked upstream as unbraind/pm-cli#742).

/**
 * Actions that cannot be served by `PmClient.run` and must keep using the
 * `pm` binary spawn. Each is documented with the concrete reason it is kept.
 */
const SPAWN_FALLBACK_ACTIONS: ReadonlySet<string> = new Set([
  // Semantic search can invoke remote providers. Keep it outside the SDK's
  // process-wide activation queue until unbraind/pm-cli#742 is resolved.
  "search",
  // Bulk updates can touch many items and must not block unrelated workspaces
  // behind the SDK's process-wide activation queue.
  "update-many",
  // Dependency/schema upgrades are long-running maintenance operations.
  "upgrade",
  // Linked acceptance suites execute arbitrary project commands and can run for
  // minutes, so test-all must not occupy the process-wide SDK queue.
  "test-all",
  // Full validation, health diagnostics, and garbage collection scan workspace
  // state and may invoke extension hooks or external checks.
  "validate",
  "health",
  "gc",
  // `pm guide` is a static help renderer with no SDK action.
  "guide",
  // Search-index rebuild is a long-running maintenance command not exposed as an SDK action.
  "reindex",
  // Workspace normalization is a maintenance command not exposed as an SDK action.
  "normalize",
  // Dedupe audit is a governance report not exposed as an SDK action.
  "dedupe-audit",
  // Comments audit is a governance report not exposed as an SDK action.
  "comments-audit",
  // Calendar rendering is a presentation command not exposed as an SDK action.
  "calendar",
  // Test-runs history is not exposed as an SDK action.
  "test-runs",
  // `pm templates list/show` is not a native SDK action.
  "templates",
  // `PmClient.run("plan", {options:{subcommand,id}})` does not accept the plan id
  // as an option key (only the typed convenience methods `planShow(id)` /
  // `planAddStep(id,...)` do). Converting all ~17 plan routes to typed methods is
  // out of scope for the spawn-removal hot path; plan stays on the spawn fallback.
  "plan",
  // pm-graph is an extension that emits its own JSON to stdout, which the graph
  // routes `JSON.parse` directly. Running it through `PmClient.run` would change
  // the result shape the routes depend on, so it stays on the spawn path.
  "pm-graph",
]);

/**
 * Per-positional option key mapping for actions whose CLI form takes positional
 * arguments (e.g. `pm get <id>`, `pm restore <id> <target>`). `PmClient.run`
 * takes a single options bag, so positionals must be mapped onto named keys.
 * Actions not listed here take options only (positionals are not expected).
 */
const POSITIONAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  init: ["prefix"],
  get: ["id"],
  update: ["id"],
  close: ["id", "reason"],
  delete: ["id"],
  comments: ["id", "add"],
  notes: ["id", "add"],
  learnings: ["id", "add"],
  test: ["id", "add"],
  files: ["id"],
  docs: ["id"],
  deps: ["id"],
  append: ["id", "body"],
  restore: ["id", "target"],
  claim: ["id"],
  release: ["id"],
  copy: ["id"],
  focus: ["id"],
  "start-task": ["id"],
  "pause-task": ["id"],
  "close-task": ["id", "reason"],
  history: ["id"],
  config: ["scope", "configAction", "key", "value"],
};

/** One cached `PmClient` configuration per workspace pm-root. */
const pmClientCache = new Map<string, PmClient>();

/**
 * Return a cached {@link PmClient} for a workspace pm-root, creating one on
 * first use. The SDK owns extension activation and serialization internally;
 * caching avoids reconstructing the immutable workspace defaults while each
 * call still receives the SDK's current extension snapshot. Author identity is
 * resolved by the SDK's default detection, preserving prior CLI behaviour.
 */
export function getPmClient(pmRoot: string): PmClient {
  let client = pmClientCache.get(pmRoot);
  if (!client) {
    client = new PmClient({
      pmRoot,
      cwd: path.dirname(path.dirname(pmRoot)),
    });
    pmClientCache.set(pmRoot, client);
  }
  return client;
}

/** Drop a cached client when its workspace is deleted. */
export function evictPmClient(pmRoot: string): void {
  pmClientCache.delete(pmRoot);
}

/**
 * Read a workspace's parsed `settings.json` for the search-tuning resolvers.
 * Returns `{}` when absent so resolvers fall back to their built-in defaults.
 */
export function readPmSettings(userId: string, slug: string): unknown {
  const settingsPath = path.join(getProjectDir(userId, slug), ".agents", "pm", "settings.json");
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Convert a kebab-case CLI flag name to the camelCase SDK option key.
 *
 * `PmClient.run` accepts single-word flag names as-is but **silently ignores**
 * multi-word kebab names (e.g. `dry-run`, `include-body`, `filter-status`),
 * which is catastrophic for boolean guards like `--dry-run`. The SDK option
 * contract is camelCase, so `--filter-deadline-before` must become
 * `filterDeadlineBefore`. Single-word names pass through unchanged.
 */
function kebabToCamel(flag: string): string {
  if (!flag.includes("-")) return flag;
  return flag.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

interface ParsedArgs {
  action: string;
  options: Record<string, unknown>;
  positionals: string[];
}

/**
 * Parse a CLI-style argv tail (without the leading `--json` injected by the
 * spawn path) into the action name, a camelCase options bag, and positionals.
 * `--json` is dropped: the SDK returns structured objects, never JSON text.
 */
function parsePmArgs(args: readonly string[]): ParsedArgs {
  const action = args[0] ?? "";
  const options: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--") {
      while (++i < args.length) positionals.push(args[i]!);
      break;
    }
    if (arg.startsWith("--no-") && (args[i + 1] === undefined || args[i + 1]!.startsWith("--"))) {
      options[kebabToCamel(arg.slice(5))] = false;
    } else if (arg.startsWith("--")) {
      const rawFlag = arg.slice(2);
      const key = kebabToCamel(rawFlag);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { action, options, positionals };
}

/** Merge mapped positionals onto the options bag for `PmClient.run`. */
function withPositionals(action: string, positionals: readonly string[], options: Record<string, unknown>): Record<string, unknown> {
  const keys = POSITIONAL_KEYS[action];
  if (!keys) return options;
  const merged: Record<string, unknown> = { ...options };
  for (let i = 0; i < keys.length && i < positionals.length; i++) {
    merged[keys[i]!] = positionals[i];
  }
  return merged;
}

/**
 * Dispatch a supported action in-process through {@link PmClient}.
 *
 * Supported actions go through the generic `client.run(action, {options})`
 * dispatcher, which accepts native and extension-contributed actions alike.
 *
 * The result object is returned both as `parsed` (structured) and stringified
 * into `stdout`, so routes that read either field keep working.
 */
async function runPmInProcess(opts: PmRunOptions, dir: string): Promise<PmRunResult> {
  const pmRoot = path.join(dir, ".agents", "pm");
  const client = getPmClient(pmRoot);
  const { action, options, positionals } = parsePmArgs(opts.args);
  try {
    const result: unknown = await client.run(action, {
      options: withPositionals(action, positionals, options),
    });
    const stdout = JSON.stringify(result) ?? "";
    return { stdout, stderr: "", ok: true, parsed: result };
  } catch (err) {
    if (err instanceof PmCliError || isPmCliExpectedError(err)) {
      return { stdout: "", stderr: err.message, ok: false, parsed: undefined, exitCode: err.exitCode };
    }
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), ok: false, parsed: undefined };
  }
}

export async function runPm(opts: PmRunOptions): Promise<PmRunResult> {
  const dir = getProjectDir(opts.userId, opts.slug);
  const action = opts.args[0] ?? "";

  // Supported actions run in-process through the cached PmClient — no spawn.
  if (!SPAWN_FALLBACK_ACTIONS.has(action)) {
    return runPmInProcess(opts, dir);
  }

  // Fallback: spawn the pm binary for actions the SDK dispatcher cannot serve.
  const args = opts.jsonOutput ? ["--json", ...opts.args] : opts.args;

  const result = await runSerialized(dir, () => runProcess(dir, args, {
    input: opts.input,
    timeoutMs: opts.timeoutMs,
    env: { PM_GRAPH_PROJECT_KEY: `${opts.userId}:${opts.slug}` },
  }));

  const { stdout, stderr, ok } = result;

  let parsed: unknown;
  if (opts.jsonOutput && ok && stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout };
    }
  }

  return { stdout, stderr, ok, parsed };
}

/**
 * Reconstruct a single item at a one-based version or ISO timestamp using the
 * pm CLI SDK's mutation-free `getItemAt` projection (the same verified replay
 * kernel that powers `pm get --at` and `pm restore`).
 *
 * Unlike {@link runPm}, this calls the SDK in-process — there is no history
 * write, lock acquisition, or derived-index mutation — so it is safe to run
 * concurrently with other readers and writers of the same workspace.
 *
 * @throws {PmCliError} with `exitCode` {@link EXIT_CODE}.NOT_FOUND when the item
 *   does not exist (or has no history), and {@link EXIT_CODE}.USAGE for an
 *   invalid ref or a version/timestamp outside the available history range.
 */
export async function runGetItemAt(
  userId: string,
  slug: string,
  itemId: string,
  ref: string,
): Promise<GetItemAtResult> {
  const pmRoot = path.join(getProjectDir(userId, slug), ".agents", "pm");
  return await getItemAt(itemId, ref, { pmRoot });
}

export function deleteProjectDir(userId: string, slug: string): void {
  const dir = getProjectDir(userId, slug);
  evictPmClient(path.join(dir, ".agents", "pm"));
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
