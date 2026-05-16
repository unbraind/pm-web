import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || "/app/projects";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_HOST ||
    "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL = process.env.PM_OLLAMA_MODEL ||
    "qwen3-embedding:0.6b";
const PM_GRAPH_EXTENSION_PATH = process.env.PM_GRAPH_EXTENSION_PATH ||
    path.join(process.cwd(), "extensions", "pm-graph");
export function getProjectDir(userId, slug) {
    return path.join(PROJECTS_ROOT, userId, slug);
}
export function initProject(userId, slug, prefix) {
    const dir = getProjectDir(userId, slug);
    fs.mkdirSync(dir, { recursive: true });
    const result = spawnSync("pm", ["init", prefix], {
        cwd: dir,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, HOME: "/tmp" },
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(result.stderr || "pm init failed");
    configureLocalOllamaSearch(dir);
    ensureGraphExtension(userId, slug);
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
function graphExtensionIsActive(projectDir) {
    const result = spawnSync("pm", ["extension", "explore", "--project", "--json"], {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, HOME: "/tmp", NO_COLOR: "1" },
    });
    if (result.status !== 0 || !result.stdout)
        return false;
    try {
        const parsed = JSON.parse(result.stdout);
        return Boolean(parsed.details?.extensions?.some((extension) => extension.name === "pm-graph" && extension.active && extension.enabled));
    }
    catch {
        return false;
    }
}
function runExtensionCommand(projectDir, args) {
    const result = spawnSync("pm", args, {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: "/tmp", NO_COLOR: "1" },
    });
    return {
        stdout: result.stdout || "",
        stderr: result.stderr || (result.error ? result.error.message : ""),
        ok: result.status === 0,
    };
}
export function ensureGraphExtension(userId, slug) {
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
        const install = runExtensionCommand(dir, ["install", PM_GRAPH_EXTENSION_PATH, "--project"]);
        if (!install.ok) {
            return {
                ok: false,
                installed: Boolean(projectManifest),
                active: false,
                error: install.stderr || install.stdout || "Failed to install bundled pm-graph extension.",
            };
        }
    }
    if (!graphExtensionIsActive(dir)) {
        const activate = runExtensionCommand(dir, ["extension", "activate", "pm-graph", "--project"]);
        if (!activate.ok) {
            return {
                ok: false,
                installed: true,
                active: false,
                error: activate.stderr || activate.stdout || "Failed to activate bundled pm-graph extension.",
            };
        }
    }
    const ping = runExtensionCommand(dir, ["pm-graph", "ping", "--json"]);
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
export function runPm(opts) {
    const dir = getProjectDir(opts.userId, opts.slug);
    const args = opts.jsonOutput ? ["--json", ...opts.args] : opts.args;
    const result = spawnSync("pm", args, {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        input: opts.input,
        env: {
            ...process.env,
            HOME: "/tmp",
            NO_COLOR: "1",
            PM_GRAPH_PROJECT_KEY: `${opts.userId}:${opts.slug}`,
        },
    });
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const ok = result.status === 0;
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
export function deleteProjectDir(userId, slug) {
    const dir = getProjectDir(userId, slug);
    if (fs.existsSync(dir)) {
        execSync(`rm -rf "${dir}"`);
    }
}
//# sourceMappingURL=pm-runner.js.map