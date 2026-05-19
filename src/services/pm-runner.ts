import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || "/app/projects";
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
  return path.join(PROJECTS_ROOT, userId, slug);
}

export function initProject(userId: string, slug: string, prefix: string): void {
  const dir = getProjectDir(userId, slug);
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync("pm", ["init", prefix], {
    cwd: dir,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, HOME: "/tmp" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "pm init failed");
  configureLocalOllamaSearch(dir);
  ensureGraphExtension(userId, slug);
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
}

export interface PmRunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  parsed?: unknown;
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

function graphExtensionIsActive(projectDir: string): boolean {
  const result = spawnSync("pm", ["extension", "explore", "--project", "--json"], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, HOME: "/tmp", NO_COLOR: "1" },
  });
  if (result.status !== 0 || !result.stdout) return false;

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

function runExtensionCommand(projectDir: string, args: string[]): PmRunResult {
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

export function ensureGraphExtension(userId: string, slug: string): EnsureGraphExtensionResult {
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

export function runPm(opts: PmRunOptions): PmRunResult {
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

export function deleteProjectDir(userId: string, slug: string): void {
  const dir = getProjectDir(userId, slug);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
