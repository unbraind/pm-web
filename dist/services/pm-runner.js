import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getItemAt, PmCliError, EXIT_CODE, } from "@unbrained/pm-cli/sdk";
// Re-exported so route handlers and tests can reference the verified projection
// shape and the typed error class without reaching into the SDK package map.
export { PmCliError, EXIT_CODE };
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export class Semaphore {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    async acquire() {
        if (this.active >= this.limit) {
            await new Promise((resolve) => this.waiting.push(resolve));
        }
        else {
            this.active += 1;
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const next = this.waiting.shift();
            if (next)
                next();
            else
                this.active -= 1;
        };
    }
}
const commandSlots = new Semaphore(positiveInteger(process.env.PM_WEB_PM_CONCURRENCY, 8));
const workspaceTails = new Map();
function projectsRoot() {
    return process.env.PROJECTS_ROOT || "/app/projects";
}
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_HOST ||
    "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL = process.env.PM_OLLAMA_MODEL ||
    "qwen3-embedding:0.6b";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const PM_GRAPH_EXTENSION_PATH = process.env.PM_GRAPH_EXTENSION_PATH ||
    path.join(process.cwd(), "extensions", "pm-graph");
export function getProjectDir(userId, slug) {
    return path.join(projectsRoot(), userId, slug);
}
let cachedPmCommand;
function pmCliCommand() {
    if (process.env.PM_CLI_BIN)
        return { command: process.env.PM_CLI_BIN, prefixArgs: [] };
    if (cachedPmCommand)
        return cachedPmCommand;
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
async function runProcess(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise((resolve) => {
        const pmCommand = pmCliCommand();
        let child;
        try {
            child = spawn(pmCommand.command, [...pmCommand.prefixArgs, ...args], {
                cwd,
                env: { ...process.env, HOME: "/tmp", NO_COLOR: "1", ...options.env },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        }
        catch (error) {
            resolve({
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                ok: false,
            });
            return;
        }
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let failure = "";
        let settled = false;
        let forceKill;
        const terminate = (reason) => {
            if (failure)
                return;
            failure = reason;
            child.kill("SIGTERM");
            forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
            forceKill.unref();
        };
        const collect = (chunks, chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                terminate(`pm command exceeded the ${MAX_OUTPUT_BYTES}-byte output limit`);
                return;
            }
            chunks.push(chunk);
        };
        child.stdout.on("data", (chunk) => collect(stdout, chunk));
        child.stderr.on("data", (chunk) => collect(stderr, chunk));
        child.on("error", (error) => {
            failure = error.message;
        });
        const timeout = setTimeout(() => terminate(`pm command timed out after ${timeoutMs}ms`), timeoutMs);
        timeout.unref();
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (forceKill)
                clearTimeout(forceKill);
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
async function runSerialized(workspace, work) {
    const previous = workspaceTails.get(workspace) ?? Promise.resolve();
    let releaseWorkspace;
    const gate = new Promise((resolve) => { releaseWorkspace = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    workspaceTails.set(workspace, tail);
    await previous.catch(() => undefined);
    const releaseSlot = await commandSlots.acquire();
    try {
        return await work();
    }
    finally {
        releaseSlot();
        releaseWorkspace();
        void tail.finally(() => {
            if (workspaceTails.get(workspace) === tail)
                workspaceTails.delete(workspace);
        });
    }
}
export async function initProject(userId, slug, prefix) {
    const dir = getProjectDir(userId, slug);
    fs.mkdirSync(dir, { recursive: true });
    const result = await runSerialized(dir, () => runProcess(dir, ["init", prefix], { timeoutMs: 15_000 }));
    if (!result.ok)
        throw new Error(result.stderr || "pm init failed");
    configureLocalOllamaSearch(dir);
    await ensureGraphExtension(userId, slug);
}
function configureLocalOllamaSearch(projectDir) {
    const settingsPath = path.join(projectDir, ".agents", "pm", "settings.json");
    if (!fs.existsSync(settingsPath))
        return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
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
export function projectExists(userId, slug) {
    const dir = getProjectDir(userId, slug);
    return fs.existsSync(path.join(dir, ".agents", "pm", "settings.json"));
}
function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    catch {
        return null;
    }
}
function bundledGraphExtensionManifest() {
    const manifestPath = path.join(PM_GRAPH_EXTENSION_PATH, "manifest.json");
    if (!fs.existsSync(manifestPath))
        return null;
    return readJsonFile(manifestPath);
}
function projectGraphExtensionManifest(projectDir) {
    return readJsonFile(path.join(projectDir, ".agents", "pm", "extensions", "pm-graph", "manifest.json"));
}
async function graphExtensionIsActive(projectDir) {
    const result = await runSerialized(projectDir, () => runProcess(projectDir, ["extension", "explore", "--project", "--json"], { timeoutMs: 15_000 }));
    if (!result.ok || !result.stdout)
        return false;
    try {
        const parsed = JSON.parse(result.stdout);
        return Boolean(parsed.details?.extensions?.some((extension) => extension.name === "pm-graph" && extension.active && extension.enabled));
    }
    catch {
        return false;
    }
}
async function runExtensionCommand(projectDir, args) {
    return runSerialized(projectDir, () => runProcess(projectDir, args));
}
export async function ensureGraphExtension(userId, slug) {
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
export async function runPm(opts) {
    const dir = getProjectDir(opts.userId, opts.slug);
    const args = opts.jsonOutput ? ["--json", ...opts.args] : opts.args;
    const result = await runSerialized(dir, () => runProcess(dir, args, {
        input: opts.input,
        timeoutMs: opts.timeoutMs,
        env: { PM_GRAPH_PROJECT_KEY: `${opts.userId}:${opts.slug}` },
    }));
    const { stdout, stderr, ok } = result;
    let parsed;
    if (opts.jsonOutput && ok && stdout) {
        try {
            parsed = JSON.parse(stdout);
        }
        catch {
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
export async function runGetItemAt(userId, slug, itemId, ref) {
    const pmRoot = path.join(getProjectDir(userId, slug), ".agents", "pm");
    return await getItemAt(itemId, ref, { pmRoot });
}
export function deleteProjectDir(userId, slug) {
    const dir = getProjectDir(userId, slug);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=pm-runner.js.map