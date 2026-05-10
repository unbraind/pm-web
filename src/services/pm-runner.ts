import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || "/app/projects";

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

export function runPm(opts: PmRunOptions): PmRunResult {
  const dir = getProjectDir(opts.userId, opts.slug);
  const args = opts.jsonOutput ? ["--json", ...opts.args] : opts.args;

  const result = spawnSync("pm", args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    input: opts.input,
    env: { ...process.env, HOME: "/tmp", NO_COLOR: "1" },
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
    execSync(`rm -rf "${dir}"`);
  }
}
