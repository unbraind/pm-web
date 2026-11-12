import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db.ts";
import {
  agentSessionEnvironment,
  getSettingsPath,
  discoverExtensions,
  resolveItemTypeRegistry,
  pathExists,
  readSettingsWithMetadata,
  writeSettings,
  certifyCompleteListResult,
  getItemAt,
  listAllComplete,
  listAllItemMetadataLight,
  stripGlobalBootstrapTokens,
  PM_TOOL_PARAMETERS_SCHEMA,
  PmClient,
  PmCliError,
  isPmCliExpectedError,
  EXIT_CODE,
  type GetItemAtResult,
  type PmCompleteListResult,
  type ExtensionDescribeResult,
  type AgentSessionContext,
} from "@unbrained/pm-cli/sdk";
import { workspaceInitialized } from "../tracker-preflight.ts";
import { resolveNpmSpec } from "./package-catalog.ts";

// Re-exported so route handlers and tests can reference the verified projection
// shape and the typed error class without reaching into the SDK package map.
export { PmCliError, isPmCliExpectedError, EXIT_CODE, type GetItemAtResult };

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Async semaphore bounding concurrent work to a fixed `limit`.
 *
 * Used to cap how many pm commands run at once: callers {@link Semaphore.acquire}
 * before work and invoke the returned release function after, so at most `limit`
 * critical sections execute concurrently.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Reserve a slot, waiting when the limit is reached, and return a release fn.
   *
   * When fewer than `limit` slots are active, this increments the count
   * immediately; otherwise it awaits until a prior release wakes this caller.
   * The returned function releases exactly once (subsequent calls are no-ops):
   * if a waiter exists it is resumed, otherwise the active count is decremented.
   *
   * @returns A function that releases the acquired slot.
   */
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
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
/** Discovery may run concurrently; admission tickets join physical queues in invocation order. */
let storageAdmissions: Promise<void> = Promise.resolve();

/**
 * Resolve the filesystem root under which every project workspace lives.
 *
 * Reads `PROJECTS_ROOT`, defaulting to `/app/projects` (the in-container
 * location). Each project is stored at `<root>/<userId>/<slug>`.
 *
 * @returns The projects root directory.
 */
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

/**
 * Resolve the on-disk directory for one project workspace.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 * @returns `<projectsRoot>/<userId>/<slug>`.
 */
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
  exitCode?: number;
}

interface PmCommand {
  command: string;
  prefixArgs: string[];
}

let cachedPmCommand: Promise<PmCommand> | undefined;

/**
 * Resolve how to invoke the pm CLI binary, memoizing the result.
 *
 * `PM_CLI_BIN` always wins (returned verbatim). Otherwise, on Windows the
 * packaged `node_modules/@unbrained/pm-cli/dist/cli.js` is run with `node` when
 * present, else bare `pm`; elsewhere the local `node_modules/.bin/pm` is used
 * when present, else bare `pm`. The non-`PM_CLI_BIN` result is cached for the
 * process.
 *
 * @returns The command and any prefix args to pass before pm arguments.
 */
async function pmCliCommand(): Promise<PmCommand> {
  if (process.env.PM_CLI_BIN) return { command: process.env.PM_CLI_BIN, prefixArgs: [] };
  if (cachedPmCommand) return cachedPmCommand;

  const windows = process.platform === "win32";
  const entry = windows
    ? path.join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js")
    : path.join(process.cwd(), "node_modules", ".bin", "pm");
  cachedPmCommand = pathExists(entry).then(exists => exists
    ? { command: windows ? process.execPath : entry, prefixArgs: windows ? [entry] : [] }
    : { command: "pm", prefixArgs: [] });
  return cachedPmCommand;
}

/**
 * Spawn the pm CLI in a directory and collect its output, bounded and timed.
 *
 * Runs pm with `HOME=/tmp`, `NO_COLOR=1`, and any extra env, streaming stdout
 * and stderr into buffers. Output beyond {@link MAX_OUTPUT_BYTES} or runtime
 * beyond `timeoutMs` terminates the child (SIGTERM then SIGKILL after 1 s) and
 * records the reason in stderr. Never throws: spawn failures and captured
 * output are returned in the {@link ProcessResult}.
 * Pins PM_PATH to the captured tracker so inherited context, and a symlink
 * retarget after admission, cannot redirect fallback commands.
 *
 * @param cwd - Directory to run pm in. Serialized callers pass the pinned workspace.
 * @param args - pm arguments.
 * @param options - Optional stdin input, timeout, extra env, and pinned tracker path.
 * @returns The collected stdout/stderr, success flag, and exit code.
 */
async function runProcess(
  cwd: string,
  args: string[],
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; pmPath?: string } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const pmCommand = await pmCliCommand();
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(pmCommand.command, [...pmCommand.prefixArgs, ...args], {
        cwd,
        env: { ...process.env, HOME: "/tmp", NO_COLOR: "1", ...options.env, PM_PATH: options.pmPath ?? path.join(cwd, ".agents", "pm") },
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
        exitCode: typeof code === "number" ? code : undefined,
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

/** Spawn pm against storage captured when the operation joined the workspace queue. */
function runPinnedProcess(
  storage: PinnedProjectStorage,
  args: string[],
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return runProcess(storage.workspace, args, { ...options, pmPath: storage.tracker });
}

/** Resolve aliases and dangling targets; unresolvable paths retain a non-throwing lexical identity. */
async function physicalWorkspacePath(workspace: string): Promise<string> {
  const absolute = path.resolve(workspace);
  try {
    return await fs.promises.realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const parent = path.dirname(absolute);
    // Loops and inaccessible paths must not prevent queue admission or cache eviction during deletion.
    if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === absolute) return absolute;
    try {
      if ((await fs.promises.lstat(absolute)).isSymbolicLink()) {
        return physicalWorkspacePath(path.resolve(parent, await fs.promises.readlink(absolute)));
      }
    } catch {
      // A missing leaf or inaccessible link can still resolve through its nearest accessible ancestor.
    }
    return path.join(await physicalWorkspacePath(parent), path.basename(absolute));
  }
}

/** Physical workspace and tracker captured before a queued operation may wait. */
export interface PinnedProjectStorage {
  /** Workspace directory after resolving aliases, including a missing leaf under an existing ancestor. */
  readonly workspace: string;
  /** Tracker directory after resolving a tracker symlink independently of the workspace alias. */
  readonly tracker: string;
}

/**
 * Capture the storage a queued operation must keep using.
 *
 * Both identities are resolved once. A later symlink retarget must not move
 * work that already joined this pin's queue onto the new target.
 *
 * @param workspace - Logical or relative project directory.
 * @returns The physical workspace and tracker selected at this instant.
 */
export async function pinProjectStorage(workspace: string): Promise<PinnedProjectStorage> {
  return pinWorkspaceStorage(workspace, path.join('.agents', 'pm'));
}

/** Resolve the workspace once and anchor every subsequent tracker lookup beneath that capture. */
async function pinWorkspaceStorage(workspace: string, relativeTracker: string): Promise<PinnedProjectStorage> {
  const physical = await physicalWorkspacePath(path.resolve(workspace));
  return { workspace: physical, tracker: await physicalWorkspacePath(path.join(physical, relativeTracker)) };
}

/** Identify shared tracker storage even when only the tracker, rather than its workspace, is a symlink. */
async function physicalWorkspaceIdentity(workspace: string): Promise<string> {
  return (await pinProjectStorage(workspace)).tracker;
}

/**
 * Run async work for one workspace after all prior work there finishes.
 *
 * Chains `work` onto the workspace's tail promise so calls against the SAME
 * workspace run one at a time, while also acquiring a global command slot so
 * calls across independent workspaces overlap only up to the concurrency limit.
 * The pin passed to `work` is the storage captured at admission. Callers must
 * use that pin rather than resolving the logical path again after waiting.
 * Returns whatever `work` resolves to, and prunes the workspace's tail once the
 * chain settles.
 *
 * @param workspace - Logical project directory whose current physical tracker selects the queue.
 * @param work - Operation that must execute against the admitted pin.
 * @param onStoragePinned - Optional acknowledgement after storage resolution and queue admission.
 * @returns The operation result.
 */
export async function runSerialized<T>(workspace: string, work: (storage: PinnedProjectStorage) => Promise<T>, onStoragePinned: () => void = () => {}): Promise<T> {
  return admitStorage(() => pinProjectStorage(workspace), work, onStoragePinned);
}

/**
 * Serialize against storage that was already captured by an access check.
 *
 * Re-resolving the logical path here would let a symlink retarget move the
 * operation onto another queue while the access check still names the old one.
 *
 * @param storage - Workspace and tracker identities selected before waiting.
 * @param work - Operation pinned to those identities.
 * @returns The operation result.
 */
export async function runOnPinnedStorage<T>(storage: PinnedProjectStorage, work: (storage: PinnedProjectStorage) => Promise<T>): Promise<T> {
  return admitStorage(() => Promise.resolve(storage), work);
}

/** Reserve before discovery, then release as soon as this invocation joins its physical execution queue. */
async function admitStorage<T>(resolveStorage: () => Promise<PinnedProjectStorage>, work: (storage: PinnedProjectStorage) => Promise<T>, onStoragePinned: () => void = () => {}): Promise<T> {
  const previous = storageAdmissions;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Even a discovery failure must not let a later ticket overtake an earlier unresolved one.
  storageAdmissions = previous.then(() => gate);
  try {
    const [storage] = await Promise.all([resolveStorage(), previous]);
    const result = runQueuedStorage(storage, work);
    onStoragePinned();
    return result;
  } finally { release(); }
}

/** Serialize captured storage; independent tracker queues share only the bounded execution semaphore. */
async function runQueuedStorage<T>(storage: PinnedProjectStorage, work: (storage: PinnedProjectStorage) => Promise<T>): Promise<T> {
  const identity = storage.tracker;
  const previous = workspaceTails.get(identity) ?? Promise.resolve();
  let releaseWorkspace!: () => void;
  const gate = new Promise<void>((resolve) => { releaseWorkspace = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  workspaceTails.set(identity, tail);

  await previous.catch(() => undefined);
  const releaseSlot = await commandSlots.acquire();
  try {
    return await work(storage);
  } finally {
    releaseSlot();
    releaseWorkspace();
    void tail.finally(() => {
      if (workspaceTails.get(identity) === tail) workspaceTails.delete(identity);
    });
  }
}

/**
 * Create and initialize a project workspace on disk.
 *
 * Makes the project directory, explicitly initializes its own tracker serialized against the
 * workspace, configures local Ollama search, and ensures the graph extension is
 * installed. Throws when `pm init` fails.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 * @param prefix - The pm item-id prefix for the workspace.
 */
export async function initProject(userId: string, slug: string, prefix: string): Promise<void> {
  const dir = getProjectDir(userId, slug);
  await fs.promises.mkdir(dir, { recursive: true });
  const result = await runSerialized(dir, storage => runPinnedProcess(storage, [
    "workspace", "init", "--workspace", storage.workspace, "--prefix", prefix,
    "--defaults", "--agent-guidance", "skip",
  ], { timeoutMs: 15_000 }));
  if (!result.ok) throw new Error(result.stderr || "pm init failed");
  await configureLocalOllamaSearch(dir);
  await ensureGraphExtension(userId, slug);
}

/**
 * Write local Ollama search settings into a project's `settings.json`.
 *
 * A no-op when settings do not exist. Applies only the Ollama/LanceDB delta to
 * an SDK read snapshot; the SDK preserves opaque keys, serializes concurrent
 * writes and appends verified workspace history under its workspace lock.
 *
 * @param projectDir - The project workspace directory.
 */
export async function configureLocalOllamaSearch(projectDir: string): Promise<void> {
  const pmRoot = path.join(projectDir, ".agents", "pm");
  if (!await pathExists(getSettingsPath(pmRoot))) return;
  const { settings, warnings } = await readSettingsWithMetadata(pmRoot);
  if (warnings.some(warning => /^settings_read_(invalid_json|invalid_schema|merge_failed)(?::|$)/.test(warning))) {
    throw new PmCliError("Cannot configure Ollama search: repair invalid tracker settings first.", EXIT_CODE.USAGE);
  }

  settings.search.embedding_model = OLLAMA_EMBEDDING_MODEL;
  settings.providers.ollama.base_url = OLLAMA_BASE_URL;
  settings.providers.ollama.model = OLLAMA_EMBEDDING_MODEL;
  settings.vector_store.lancedb.path = ".agents/pm/search/lancedb/";

  await writeSettings(pmRoot, settings, "web.configure-local-ollama-search");
}

/**
 * Report whether a project workspace is already initialized on disk.
 *
 * Uses the SDK preflight against this project's explicit tracker root. Missing,
 * non-directory and unreadable roots return false without exposing their paths.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 * @returns True when the SDK admits the workspace as initialized and readable.
 */
export function projectExists(userId: string, slug: string): Promise<boolean> {
  return workspaceInitialized(path.join(getProjectDir(userId, slug), ".agents", "pm"));
}

/**
 * Options for {@link runPm}: the pm arguments to run, the project owner/slug
 * that locate the workspace, optional stdin, a JSON-output request, and an
 * optional per-call timeout.
 */
export interface PmRunOptions {
  args: string[];
  userId: string;
  slug: string;
  input?: string;
  jsonOutput?: boolean;
  timeoutMs?: number;
  /** Acknowledge resolved storage and queue admission without replacing any operation. */
  onStoragePinned?: () => void;
  /** Session declaration serialized for commands that fall back to the CLI. */
  agentSession?: AgentSessionContext;
  /** Require the runtime winner for this command, and for every path its positional args extend it to, to be the catalog package. */
  commandOwner?: { command: string; name: string; args?: readonly string[] };
}

/** Transport-neutral result shared by in-process SDK and child-process calls. */
export interface PmRunResult {
  /** Request boundary used to read committed identities, never inferred from the latest item version. */
  mutationSince?: string;
  /** Exact invocation correlation recorded on immutable committed history entries. */
  mutationEpisodeId?: string;
  stdout: string;
  stderr: string;
  ok: boolean;
  parsed?: unknown;
  /** pm CLI exit code from either the SDK dispatcher or spawned CLI fallback. */
  exitCode?: number;
  /** Ownership could not be established or belonged to another package; no command ran. */
  ownershipRefused?: boolean;
}

/** Stable pm-web checks that supplement the pm CLI SDK complete-list certificate. */
export const PM_WEB_COMPLETE_LIST_RECEIPT_FINDINGS = [
  "budget_disclosure_present",
] as const;

/** A stable reason pm-web refused an otherwise SDK-certified complete list. */
export type PmWebCompleteListReceiptFinding =
  (typeof PM_WEB_COMPLETE_LIST_RECEIPT_FINDINGS)[number];

/** Fail-closed error carrying every supplemental complete-read receipt defect. */
export class PmWebCompleteListReceiptError extends Error {
  /** Stable findings suitable for route diagnostics and regression assertions. */
  readonly findings: readonly PmWebCompleteListReceiptFinding[];

  /** Build an immutable receipt error from independently detected defects. */
  constructor(findings: readonly PmWebCompleteListReceiptFinding[]) {
    super(`Complete pm read receipt validation failed: ${findings.join(", ")}.`);
    this.name = "PmWebCompleteListReceiptError";
    this.findings = Object.freeze([...findings]);
  }
}

/** Result of a fail-closed whole-workspace read through the public pm SDK. */
export type PmCompleteListRunResult =
  | { readonly ok: true; readonly result: PmCompleteListResult }
  | { readonly ok: false; readonly stderr: string; readonly exitCode?: number };

/** Installation and activation state returned by the pm-graph provisioner. */
export interface EnsureGraphExtensionResult {
  ok: boolean;
  installed: boolean;
  active: boolean;
  error?: string;
}

/**
 * The per-extension state shape emitted by `pm extension --json`. Only the
 * fields consumers read are typed; the command emits far more (triage, policy,
 * diagnostics) which is deliberately dropped.
 */
export interface ExtensionState {
  name: string;
  version?: string;
  active?: boolean;
  enabled?: boolean;
  runtime_active?: boolean;
  activation_status?: string;
  managed?: boolean;
  source?: { kind?: string; input?: string };
}

interface ExtensionExploreResult {
  details?: { extensions?: ExtensionState[] };
}

/**
 * Outcome of reading per-project extension state.
 *
 * `ok` distinguishes "the command ran and this is the state" from "the command
 * failed, so we know nothing" — a distinction both previous copies of this
 * parser collapsed, reporting a failed `pm extension --json` identically to a
 * project with nothing installed.
 */
export interface ExtensionStatesResult {
  ok: boolean;
  states: Map<string, ExtensionState>;
  error?: string;
}

/**
 * Read the per-project extension state from `pm extension --json`, returning a
 * map keyed by extension name. Used both by {@link ensureGraphExtension} and
 * the extensions routes' catalog join.
 */
export async function readProjectExtensionStates(projectDir: string): Promise<ExtensionStatesResult> {
  return readPinnedProjectExtensionStates(await pinProjectStorage(projectDir));
}

/** Read inventory against the same admitted storage used by the provisioning transaction. */
async function readPinnedProjectExtensionStates(storage: PinnedProjectStorage): Promise<ExtensionStatesResult> {
  const result = await runOnPinnedStorage(storage, pin =>
    runPinnedProcess(pin, ["extension", "--json"], { timeoutMs: 15_000 }),
  );
  const states = new Map<string, ExtensionState>();
  if (!result.ok || !result.stdout) {
    return { ok: false, states, error: result.stderr || "pm extension --json failed" };
  }
  try {
    const parsed = JSON.parse(result.stdout) as ExtensionExploreResult;
    const extensions = parsed.details?.extensions;
    if (!Array.isArray(extensions)) {
      return { ok: false, states, error: "pm extension --json returned no extension list" };
    }
    for (const ext of extensions) {
      if (ext && typeof ext.name === "string") states.set(ext.name, ext);
    }
  } catch {
    return { ok: false, states, error: "pm extension --json returned malformed JSON" };
  }
  return { ok: true, states };
}

/**
 * Timeout for package installs, which resolve and download from the npm
 * registry rather than only touching local state.
 *
 * The 30s default is sized for local commands and leaves too thin a margin
 * here. Measured on this host: a warm-cache install is ~2s, and a cold-cache
 * install of the heaviest catalog package (pm-graph, which pulls
 * `neo4j-driver`) is ~10s. That is only a 3x margin on a fast connection,
 * before accounting for a container sharing bandwidth or a slow registry —
 * and the failure mode is a project create or package install that dies
 * mid-download. A hung install still terminates, just later.
 */
export const INSTALL_COMMAND_TIMEOUT_MS = 180_000;

async function runExtensionCommand(
  storage: PinnedProjectStorage,
  args: string[],
  timeoutMs?: number,
): Promise<PmRunResult> {
  return runOnPinnedStorage(storage, pin => runPinnedProcess(pin, args, { timeoutMs }));
}

let graphProvisionInventoryHook: (() => Promise<void>) | undefined;

/** @internal Pause after real inventory so regressions can retarget a tracker before installation. */
export function setGraphProvisionInventoryHookForTest(hook: (() => Promise<void>) | undefined): void {
  graphProvisionInventoryHook = hook;
}

const pendingGraphProvisions = new Map<string, Promise<EnsureGraphExtensionResult>>();

/**
 * Ensure the pm-graph package is installed and active for a project.
 *
 * This used to install a *vendored* copy of pm-graph from
 * `extensions/pm-graph/` (a stale fork pinned to pm-cli `^2026.7.5`). The
 * vendored fork is gone; pm-graph is now installed from npm through the same
 * generic catalog path as every other pm package
 * (src/services/package-catalog.ts). The npm spec is resolved from the catalog
 * — never built from a user-supplied string — so the install target is always
 * the verified `npm:pm-graph` constant.
 *
 * Explicit editor provisioning and graph sync call this; GET routes must never do so.
 * Graph sync calls this before `pm pm-graph export`,
 * and {@link initProject} calls it on project creation, so the user-facing
 * graph behaviour is unchanged.
 */
export async function ensureGraphExtension(userId: string, slug: string): Promise<EnsureGraphExtensionResult> {
  const storage = await pinProjectStorage(getProjectDir(userId, slug));
  const identity = storage.tracker;
  const pending = pendingGraphProvisions.get(identity);
  if (pending) return pending;
  const provision = provisionGraphExtension(storage);
  pendingGraphProvisions.set(identity, provision);
  try {
    return await provision;
  } finally {
    pendingGraphProvisions.delete(identity);
  }
}

/** Perform one explicit provisioning transaction; concurrent callers share its result. */
async function provisionGraphExtension(storage: PinnedProjectStorage): Promise<EnsureGraphExtensionResult> {
  // Resolve the verified npm install spec from the catalog — never a raw path.
  const npmSpec = resolveNpmSpec("pm-graph");
  if (!npmSpec) {
    return {
      ok: false,
      installed: false,
      active: false,
      error: "pm-graph is not present in the package catalog.",
    };
  }

  const inventory = await readPinnedProjectExtensionStates(storage);
  if (!inventory.ok) {
    return { ok: false, installed: false, active: false, error: inventory.error };
  }
  await graphProvisionInventoryHook?.();
  const graphState = inventory.states.get("pm-graph");
  const installed = Boolean(graphState);
  const active = Boolean(graphState?.active && graphState?.enabled);

  if (!installed) {
    const install = await runExtensionCommand(
      storage,
      ["install", npmSpec, "--project"],
      INSTALL_COMMAND_TIMEOUT_MS,
    );
    if (!install.ok) {
      return {
        ok: false,
        installed: false,
        active: false,
        error: install.stderr || install.stdout || "Failed to install pm-graph from npm.",
      };
    }
  }

  if (!active) {
    const activate = await runExtensionCommand(storage, ["extension", "activate", "pm-graph", "--project"]);
    if (!activate.ok) {
      return {
        ok: false,
        installed: true,
        active: false,
        error: activate.stderr || activate.stdout || "Failed to activate pm-graph.",
      };
    }
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
  // Extension management (`pm install <source> --project`, `pm extension
  // activate|deactivate|uninstall <name> --project`) takes a positional source
  // or subcommand that `PmClient.run(action, {options})` drops — the SDK's
  // `client.run("install", ...)` raises "requires extension source input" and
  // `client.run("extension", ...)` only performs the default explore, ignoring
  // activate/deactivate/uninstall. The per-project package catalog routes depend
  // on these positionals, so install + extension stay on the spawn fallback (the
  // verified `pm install npm:<pkg> --project` mechanism).
  "install",
  "extension",
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
  // `pm schema [subcommand] [name]` — e.g. `schema add-type Spike`. Without this
  // mapping both positionals are dropped and the SDK rejects the call with
  // "Missing required argument: subcommand".
  schema: ["subcommand", "name"],
  // `pm history-repair [id]` — omitted only when `--all` is passed, which the
  // per-item route never does.
  "history-repair": ["id"],
  config: ["scope", "configAction", "key", "value"],
};

const PM_CLIENT_CACHE_MAX = positiveInteger(process.env.PM_WEB_PM_CLIENT_CACHE_MAX, 256);

/** Bounded least-recently-used cache keyed by both storage and execution workspace. */
const pmClientCache = new Map<string, PmClient>();

/** Keep shared storage serialization separate from cwd-dependent SDK defaults. */
async function pmClientIdentity(pmRoot: string): Promise<{ pmRoot: string; cwd: string; key: string }> {
  const logicalRoot = path.resolve(pmRoot);
  const logicalWorkspace = path.dirname(path.dirname(logicalRoot));
  const storage = await pinWorkspaceStorage(logicalWorkspace, path.relative(logicalWorkspace, logicalRoot));
  return { pmRoot: storage.tracker, cwd: storage.workspace, key: JSON.stringify([storage.tracker, storage.workspace]) };
}

/** Keep one client per captured tracker and execution workspace, without resolving again. */
function cachedPmClient(key: string, pmRoot: string, cwd: string): PmClient {
  let client = pmClientCache.get(key);
  if (client) {
    pmClientCache.delete(key);
    pmClientCache.set(key, client);
    return client;
  }
  if (pmClientCache.size >= PM_CLIENT_CACHE_MAX) {
    const leastRecentlyUsed = pmClientCache.keys().next().value;
    if (typeof leastRecentlyUsed === "string") pmClientCache.delete(leastRecentlyUsed);
  }
  client = new PmClient({ pmRoot, cwd });
  pmClientCache.set(key, client);
  return client;
}

/** Return the cached client for storage already captured at queue admission. */
function pmClientForPinned(storage: PinnedProjectStorage): PmClient {
  return cachedPmClient(JSON.stringify([storage.tracker, storage.workspace]), storage.tracker, storage.workspace);
}

/**
 * Return a cached {@link PmClient} for a workspace pm-root, creating one on
 * first use. The SDK owns extension activation internally; per-workspace
 * serialization of mutating calls is enforced by {@link runPm}'s
 * {@link runSerialized} wrapper (the SDK's own queue is process-wide, not
 * per-workspace). Caching avoids reconstructing the immutable workspace
 * defaults while each call still receives the SDK's current extension
 * snapshot. Author identity is resolved by the SDK's default detection,
 * preserving prior CLI behaviour.
 *
 * @param pmRoot - Logical or physical tracker directory.
 * @returns The cached client for that tracker's current physical identity and workspace.
 */
export async function getPmClient(pmRoot: string): Promise<PmClient> {
  const identity = await pmClientIdentity(pmRoot);
  return cachedPmClient(identity.key, identity.pmRoot, identity.cwd);
}

/** Drop a cached client when its workspace is deleted. */
export async function evictPmClient(pmRoot: string): Promise<void> {
  pmClientCache.delete((await pmClientIdentity(pmRoot)).key);
}

/** Read SDK command ownership for the project layer used by isolated maintenance processes. */
export async function readProjectCommandOwners(projectDir: string): Promise<ExtensionDescribeResult["command_ownership"]> {
  return runSerialized(projectDir, async storage => {
    const result = await pmClientForPinned(storage).packageDescribe(undefined, { project: true });
    const owners = result.details.command_ownership;
    if (!result.ok || !Array.isArray(owners)) throw new Error("Cannot read project command capabilities.");
    // Describe includes global claims even with project scope. Maintenance
    // subprocesses isolate HOME, so project availability must exclude those
    // claims and apply the SDK's declared last-activated-wins policy to the
    // remaining activation-ordered claims.
    return (owners as ExtensionDescribeResult["command_ownership"]).map((row) => ({
      ...row,
      claimants: row.claimants.filter((claim) => claim.layer === "project")
        .map((claim, index, claims) => ({ ...claim, winner: index === claims.length - 1 })),
    })).filter((row) => row.claimants.length > 0);
  });
}

/**
 * Apply pm-web's supplemental truthfulness checks to a complete-list candidate.
 *
 * The public SDK certificate owns the shared corpus invariants. pm CLI 2026.8.31
 * closed unbraind/pm-cli#1078, so `certifyCompleteListResult` now rejects absent
 * or contradictory source counters (`source_incomplete`, `source_unchecked`),
 * omission receipts (`omission_receipt_missing`, `omission_receipt_invalid`),
 * universal-output receipts (`read_output_missing`, `read_output_invalid`,
 * `read_output_dimensions_incomplete`), and a truncation disclosure
 * (`budget_compaction`) on its own. pm-web no longer duplicates those checks:
 * duplicating them would leave branches the SDK makes unreachable, which cannot
 * be honestly covered.
 *
 * One gap remains. The SDK rejects an `output_budget_truncation` disclosure but
 * still accepts `output_budget_exceeded`, even though either one means the rows
 * may be short of the whole corpus. The hosted multi-tenant reader must not serve
 * a partial list as complete, so that single check stays here.
 *
 * @param candidate - Unknown result produced by the pm SDK.
 * @returns The SDK-certified full list when every supplemental receipt agrees.
 * @throws {PmWebCompleteListReceiptError} when supplemental proof is absent or contradictory.
 */
export function certifyPmWebCompleteList(candidate: unknown): PmCompleteListResult {
  const result = certifyCompleteListResult(candidate);
  const findings: PmWebCompleteListReceiptFinding[] = [];

  if ((candidate as Record<string, unknown>)["output_budget_exceeded"] !== undefined) {
    findings.push("budget_disclosure_present");
  }

  if (findings.length > 0) throw new PmWebCompleteListReceiptError(findings);
  return result;
}

/** Reject every inventory warning except the SDK's explicitly harmless legacy format coercion. */
export function assertObservationalInventoryWarnings(warnings: readonly string[]): void {
  const nonFatalWarnings = new Set(['settings_item_format_legacy_json_markdown_coerced_to_toon']);
  if (warnings.some(warning => !nonFatalWarnings.has(warning))) {
    throw new Error('Cannot establish the complete item-folder inventory.');
  }
}

/**
 * Establish the SDK's scan folders without executing extensions; refuse unprovable dynamic schemas.
 * Static contribution inventories with no item types remain compatible with observational reads.
 */
export async function observationalItemFolders(storage: PinnedProjectStorage): Promise<string[]> {
  const { settings, warnings } = await readSettingsWithMetadata(storage.tracker);
  assertObservationalInventoryWarnings(warnings);
  const discovered = await discoverExtensions({ pmRoot: storage.tracker, cwd: storage.workspace, settings });
  if (discovered.effective.some(extension =>
    (extension.contributions?.item_types?.length ?? 0) > 0
    || (extension.capabilities?.includes('schema') && extension.contributions?.item_types === undefined))) {
    throw new Error('Cannot establish all item folders without activating extensions.');
  }
  // Use the exact registry constructor used by the SDK item-store scanner, including file-backed schema.
  return resolveItemTypeRegistry(settings, null).folders;
}

/** Certify an observational corpus only while the SDK/schema folder inventory remains proven and unchanged. */
export async function readObservationalCompleteList(storage: PinnedProjectStorage, includeBody = false): Promise<PmCompleteListResult> {
  const folders = await observationalItemFolders(storage);
  const result = await listAllComplete({ includeBody }, { pmRoot: storage.tracker, cwd: storage.workspace, noExtensions: true });
  if (JSON.stringify(await observationalItemFolders(storage)) !== JSON.stringify(folders)) throw new Error('Item-folder inventory changed during the read.');
  return certifyPmWebCompleteList(result);
}

/**
 * Read and certify every item in a project through the public high-level SDK.
 *
 * The SDK's `listAllComplete` operation supplies all lifecycle states, full
 * metadata, strict source reads, and unbounded output. The same per-workspace
 * queue used by {@link runPm} prevents a whole-workspace read from racing a
 * mutation in this process, while independent projects can still overlap.
 *
 * @param userId - The project owner's user id.
 * @param slug - The project slug.
 * @param includeBody - Whether complete rows must include item bodies.
 * @param noExtensions - Disable extension activation for a strictly observational read.
 * @param sourceOrder - Preserve native store ordering under the same workspace lock.
 * @param onStoragePinned - Optional acknowledgement after asynchronous queue admission.
 * @returns A discriminated success result with certified rows, or a failure.
 */
export async function readCompletePmItems(
  userId: string,
  slug: string,
  includeBody = false,
  noExtensions = false,
  sourceOrder = false,
  onStoragePinned: () => void = () => {},
): Promise<PmCompleteListRunResult> {
  const dir = getProjectDir(userId, slug);
  return runSerialized(dir, async (storage): Promise<PmCompleteListRunResult> => {
    try {
      const result = noExtensions
        ? await readObservationalCompleteList(storage, includeBody)
        : certifyPmWebCompleteList(await pmClientForPinned(storage).listAllComplete({ includeBody }));
      if (sourceOrder) {
        // Only identifiers/order come from this light scan; heavy collections stay in certified rows.
        const sourceItems = await listAllItemMetadataLight(storage.tracker);
        const certifiedById = new Map(result.items.map((item) => [item.id, item]));
        const items = sourceItems.map((item) => {
          const certified = certifiedById.get(item.id);
          if (!certified) throw new Error("Graph source changed during the certified read");
          certifiedById.delete(item.id);
          return certified;
        });
        if (certifiedById.size > 0) throw new Error("Graph source changed during the certified read");
        return { ok: true, result: { ...result, items } };
      }
      return { ok: true, result };
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      if (error instanceof PmCliError || isPmCliExpectedError(error)) {
        return { ok: false, stderr, exitCode: error.exitCode };
      }
      return { ok: false, stderr };
    }
  }, onStoragePinned);
}

/**
 * Read a workspace's parsed `settings.json` for the search-tuning resolvers.
 * Returns `{}` when absent so resolvers fall back to their built-in defaults.
 */
export async function readPmSettings(userId: string, slug: string): Promise<unknown> {
  const settingsPath = path.join(getProjectDir(userId, slug), ".agents", "pm", "settings.json");
  try {
    return JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
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

type ToolSchemaProperty = {
  const?: unknown;
  type?: unknown;
};

type ToolSchemaBranch = {
  properties?: Record<string, ToolSchemaProperty>;
};

/**
 * Derive boolean option arity from the SDK's canonical action-scoped tool
 * schema. This keeps the adapter aligned when pm adds an option and lets string
 * values begin with `--` without being mistaken for another flag.
 */
function booleanOptionsByAction(): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  const branches = (PM_TOOL_PARAMETERS_SCHEMA as { oneOf?: ToolSchemaBranch[] }).oneOf ?? [];
  for (const branch of branches) {
    const properties = branch.properties ?? {};
    const action = properties["action"]?.const;
    if (typeof action !== "string") continue;
    const keys = Object.entries(properties)
      .filter(([, property]) => property.type === "boolean")
      .map(([key]) => key);
    result.set(action, new Set(keys));
  }
  return result;
}

const BOOLEAN_OPTIONS_BY_ACTION = booleanOptionsByAction();

/**
 * Parse a CLI-style argv tail (without the leading `--json` injected by the
 * spawn path) into the action name, a camelCase options bag, and positionals.
 * `--json` is dropped: the SDK returns structured objects, never JSON text.
 */
function parsePmArgs(args: readonly string[]): ParsedArgs {
  const action = args[0] ?? "";
  const booleanOptions = BOOLEAN_OPTIONS_BY_ACTION.get(action) ?? new Set<string>();
  const options: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--") {
      while (++i < args.length) positionals.push(args[i]!);
      break;
    }
    if (arg.startsWith("--no-")) {
      options[kebabToCamel(arg.slice(5))] = false;
    } else if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");
      const rawFlag = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
      const key = kebabToCamel(rawFlag);
      if (equalsIndex !== -1) {
        options[key] = arg.slice(equalsIndex + 1);
        continue;
      }
      if (booleanOptions.has(key)) {
        options[key] = true;
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined) {
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
async function runPmInProcess(opts: PmRunOptions, storage: PinnedProjectStorage): Promise<PmRunResult | null> {
  const client = pmClientForPinned(storage);
  const { action, options, positionals } = parsePmArgs(opts.args);
  // The linked-test runner consumes repeatable JSON entries as an array;
  // unlike `add`, the SDK does not normalize a single `addJson` string.
  if (action === "test" && typeof options.addJson === "string") {
    options.addJson = [options.addJson];
  }
  try {
    const result: unknown = await client.run(action, {
      options: withPositionals(action, positionals, options),
    });
    const stdout = JSON.stringify(result) ?? "";
    return { stdout, stderr: "", ok: true, parsed: result };
  } catch (err) {
    if (
      (err instanceof PmCliError || isPmCliExpectedError(err)) &&
      err.message.startsWith("Unsupported native pm action:")
    ) {
      return null;
    }
    if (err instanceof PmCliError || isPmCliExpectedError(err)) {
      return { stdout: "", stderr: err.message, ok: false, parsed: undefined, exitCode: err.exitCode };
    }
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), ok: false, parsed: undefined };
  }
}

/**
 * Run a pm command against a project workspace.
 *
 * Resolves the workspace directory and dispatches supported actions in-process
 * through the cached SDK client (no spawn) when there is no stdin input or
 * custom timeout; otherwise spawns the pm binary as a fallback. Both paths run
 * inside {@link runSerialized}, so same-workspace calls never overlap. When
 * `jsonOutput` is set and the command succeeds with stdout, the output is parsed
 * as JSON (a parse failure yields `{ raw: stdout }`). Never throws: errors are
 * returned in the {@link PmRunResult}.
 *
 * @param opts - The command, project, and I/O options.
 * @returns The stdout/stderr, success flag, parsed JSON (when requested), and exit code.
 */
export async function runPm(opts: PmRunOptions): Promise<PmRunResult> {
  const dir = getProjectDir(opts.userId, opts.slug);
  const action = opts.args[0] ?? "";

  // Supported actions run in-process through the cached PmClient — no spawn.
  const useInProcess =
    !SPAWN_FALLBACK_ACTIONS.has(action) &&
    opts.commandOwner === undefined &&
    opts.input === undefined &&
    opts.timeoutMs === undefined;

  // Both the in-process SDK dispatch and the spawn fallback must honour the
  // per-workspace serialization guarantee: calls against the SAME workspace
  // run one at a time, while calls against INDEPENDENT workspaces overlap
  // (bounded by the global command slot semaphore). The in-process path used
  // to be dispatched outside `runSerialized`, which let concurrent
  // same-workspace mutations race (the SDK's own queue is process-wide, not
  // per-workspace). Wrapping the whole dispatch — in-process attempt plus the
  // spawn fallback — in a single `runSerialized` restores the guarantee for
  // every action regardless of which path serves it.
  return runSerialized(dir, async (storage): Promise<PmRunResult> => {
    const env = { PM_GRAPH_PROJECT_KEY: `${opts.userId}:${opts.slug}`, ...agentSessionEnvironment(opts.agentSession ?? {}) };
    if (opts.commandOwner) {
      const error = await commandOwnershipError(storage, opts.commandOwner, env);
      if (error) return { ok: false, stdout: "", stderr: error, ownershipRefused: true };
    }
    if (useInProcess) {
      const sdkResult = await runPmInProcess(opts, storage);
      if (sdkResult) return sdkResult;
    }

    // Fallback: spawn the pm binary for actions the SDK dispatcher cannot serve.
    const args = opts.jsonOutput ? ["--json", ...opts.args] : opts.args;

    const result = await runPinnedProcess(storage, args, {
      input: opts.input,
      timeoutMs: opts.timeoutMs,
      env,
    });

    const { stdout, stderr, ok, exitCode } = result;

    let parsed: unknown;
    if (opts.jsonOutput && ok && stdout) {
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = { raw: stdout };
      }
    }

    return { stdout, stderr, ok, parsed, exitCode };
  }, opts.onStoragePinned);
}

/** Verify every possible owned command prefix using the pinned CLI's public package-describe contract. */
async function commandOwnershipError(storage: PinnedProjectStorage, expected: { command: string; name: string; args?: readonly string[] }, env: NodeJS.ProcessEnv): Promise<string | null> {
  const unknownOwner = `Cannot establish the effective owner of pm ${expected.command}; refusing to run ${expected.name}.`;
  const result = await runPinnedProcess(storage, ["package", "describe", "--project", "--json"], { timeoutMs: 15_000, env });
  if (!result.ok) return unknownOwner;
  try {
    const receipt = JSON.parse(result.stdout) as { ok?: unknown; details?: Partial<ExtensionDescribeResult> };
    const ownership = receipt.details?.command_ownership;
    if (receipt.ok !== true || !Array.isArray(ownership)) return unknownOwner;
    if (!ownership.some((row) => row.command === expected.command)) return unknownOwner;
    // Positional arguments can extend the dispatched path (`pm presets` + `list`
    // dispatches `presets list`), so every owned path the argv could resolve to
    // must be won by the selected package, not only the selected base command.
    const paths = new Set([expected.command]);
    let candidates = new Set([expected.command]);
    // Only prefixes of receipt commands can reach an owned path. Pruning and
    // deduplication bound the search by the receipt rather than argv branches.
    const ownedPrefixes = new Set<string>();
    for (const row of ownership) {
      const parts = row.command.split(" ");
      for (let length = 1; length <= parts.length; length += 1) {
        ownedPrefixes.add(parts.slice(0, length).join(" "));
      }
    }
    let uncertain = false;
    // Use the dispatcher's public arity contract, including equals forms and
    // terminators. A global option's value is not a command-path component.
    const args = [...(expected.args ?? [])];
    // Extensions can interpret terminator operands themselves, beyond the CLI
    // bootstrap contract. Their dispatch cannot be established from this receipt.
    const terminator = args.indexOf("--");
    if (terminator >= 0 && terminator < args.length - 1) return unknownOwner;
    const tokens = stripGlobalBootstrapTokens(args);
    for (const [index, token] of tokens.entries()) {
      if (token.startsWith("-")) continue;
      const previous = tokens[index - 1];
      const possibleValue = previous?.startsWith("-") === true && !previous.includes("=");
      uncertain ||= possibleValue;
      // An unknown local option may consume its next token. Keep both that
      // branch and the branch where the token extends the command path.
      const next = new Set<string>(possibleValue ? candidates : []);
      for (const candidate of candidates) {
        const extended = `${candidate} ${token}`;
        if (!ownedPrefixes.has(extended)) continue;
        next.add(extended);
        paths.add(extended);
      }
      candidates = next;
    }
    for (const row of ownership.filter((candidate) => paths.has(candidate.command))) {
      if (row.policy !== "last_activated_wins" || !["handler", "override"].includes(row.surface)) return unknownOwner;
      const winners = row.claimants.filter((claimant) => claimant.winner === true);
      const winner = winners[0];
      if (winners.length !== 1 || !winner || typeof winner.name !== "string") return unknownOwner;
      if (winner.name !== expected.name) {
        if (uncertain) return unknownOwner;
        return `pm ${row.command} is owned by ${winner.name} (${row.surface}), not ${expected.name}; refusing to run.`;
      }
    }
    return null;
  } catch {
    return unknownOwner;
  }
}

/**
 * Reconstruct a single item at a one-based version or ISO timestamp using the
 * pm CLI SDK's mutation-free `getItemAt` projection (the same verified replay
 * kernel that powers `pm get --at` and `pm restore`).
 *
 * Unlike {@link runPm}, this calls the SDK in-process — there is no history
 * write, lock acquisition, or derived-index mutation. It still joins the
 * physical workspace queue to avoid overlapping local mutations.
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
  onStoragePinned: () => void = () => {},
): Promise<GetItemAtResult> {
  return runSerialized(getProjectDir(userId, slug), storage => getItemAt(itemId, ref, { pmRoot: storage.tracker, cwd: storage.workspace }), onStoragePinned);
}

/**
 * Delete a project workspace from disk.
 *
 * Evicts the cached SDK client for the project's pm root first (so no stale
 * client outlives the deletion), then removes the whole workspace directory
 * recursively. A missing directory is not an error.
 *
 * @param userId - The owning user's id.
 * @param slug - The project slug.
 */
export async function deleteProjectDir(userId: string, slug: string): Promise<void> {
  const dir = getProjectDir(userId, slug);
  await evictPmClient(path.join(dir, ".agents", "pm"));
  await fs.promises.rm(dir, { recursive: true, force: true });
}
