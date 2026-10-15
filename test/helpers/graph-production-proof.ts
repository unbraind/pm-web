/** Exercise the built production server with curl and a disposable project directory. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../../dist/db.js";
import { signToken } from "../../dist/auth.js";

const root = await mkdtemp(path.join(tmpdir(), "graph-production-"));
const owner = randomUUID();
const viewer = randomUUID();
const project = randomUUID();
const slug = "synthetic-graph";
const pmRoot = path.join(root, owner, slug, ".agents", "pm");
let child: ReturnType<typeof spawn> | undefined;

/** Hash persisted settings and extension registry, preserving missing-file identity. */
async function stateDigest(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of ["settings.json", "extensions/.managed-extensions.json"]) {
    hash.update(file);
    try {
      hash.update(await readFile(path.join(pmRoot, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("absent");
    }
  }
  return hash.digest("hex");
}

try {
  await pool.query("INSERT INTO pm_users (id,email,password_hash) VALUES ($1,$2,'x'),($3,$4,'x')", [owner, `owner-${owner}@example.test`, viewer, `viewer-${viewer}@example.test`]);
  await pool.query("INSERT INTO pm_projects (id,user_id,name,slug,prefix) VALUES ($1,$2,'Synthetic graph',$3,'fixture')", [project, owner, slug]);
  await pool.query("INSERT INTO pm_project_shares (project_id,shared_with_user_id,permission) VALUES ($1,$2,'view')", [project, viewer]);
  await mkdir(path.dirname(path.dirname(pmRoot)), { recursive: true });
  execFileSync(path.resolve("node_modules/.bin/pm"), ["init", "fixture", "--path", pmRoot], { stdio: "ignore" });
  const before = await stateDigest();
  const server = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, NODE_ENV: "production", PROJECTS_ROOT: root, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = server;
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("built server startup timed out")), 30_000);
    let buffered = "";
    server.once("exit", () => { clearTimeout(timer); reject(new Error("built server exited before readiness")); });
    server.once("error", reject);
    server.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const event = JSON.parse(line) as { event?: string; port?: number };
        if (event.event === "server_started" && event.port) {
          clearTimeout(timer);
          resolve(event.port);
        }
      }
    });
  });
  const url = `http://127.0.0.1:${port}/api/projects/${project}/pm/graph`;
  const session = `pm_token=${signToken({ userId: viewer, email: `viewer-${viewer}@example.test` })}`;
  for (const [scenario, headers, expected] of [
    ["anonymous", [], 401],
    ["viewer", ["-H", `Cookie: ${session}`], 200],
    ["cross-origin viewer without CSRF", ["-H", `Cookie: ${session}`, "-H", "Origin: https://foreign.example", "-H", "Sec-Fetch-Site: cross-site"], 200],
  ] as const) {
    const result = execFileSync("curl", ["--noproxy", "*", "--silent", "--show-error", "--max-time", "15", ...headers, "--write-out", "\n%{http_code}", url], { encoding: "utf8" });
    const split = result.lastIndexOf("\n");
    const status = Number(result.slice(split + 1));
    assert.equal(status, expected);
    if (status === 200) {
      const body = JSON.parse(result.slice(0, split)) as { graph: { source: string }; extensionAvailable: boolean; canProvision: boolean };
      assert.equal(body.graph.source, "pm-web");
      assert.equal(body.extensionAvailable, false);
      assert.equal(body.canProvision, false);
    }
    assert.equal(await stateDigest(), before);
    process.stdout.write(`production curl ${scenario}: HTTP ${status}; settings/registry unchanged\n`);
  }
  process.stdout.write(`production state SHA-256 before=after=${before}\n`);
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    await stopped;
  }
  await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner, viewer]]);
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
