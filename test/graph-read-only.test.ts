/**
 * Real HTTP, PostgreSQL, and PM workspace regression for graph reads.
 * A viewer may read a graph, but a safe-method request must not provision an
 * extension in the shared workspace.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authedFetch,
  ensureSchema,
  seedProject,
  seedUser,
  seedUserShare,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

test("graph GET and HEAD by a view-only collaborator leave extensions untouched", async (t) => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-graph-read-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  const owner = await seedUser(uniqueEmail("graph-owner"));
  const viewer = await seedUser(uniqueEmail("graph-viewer"));
  const project = await seedProject(owner.id);
  await seedUserShare(project.id, viewer.id, "view");
  const projectDir = path.join(root, owner.id, project.slug);
  const pmRoot = path.join(projectDir, ".agents", "pm");
  await mkdir(projectDir, { recursive: true });
  execFileSync("pm", ["init", "--pm-path", pmRoot], { stdio: "ignore" });
  const target = execFileSync("pm", [
    "create", "--type", "Task", "--title", "Graph dependency target",
    "--pm-path", pmRoot, "--json",
  ], { encoding: "utf8" });
  const targetId = (JSON.parse(target) as { id?: string }).id;
  assert.ok(targetId);
  const created = execFileSync("pm", [
    "create", "--type", "Task", "--title", "Graph read marker",
    "--blocked-by", targetId,
    "--pm-path", pmRoot, "--json",
  ], { encoding: "utf8" });
  const itemId = (JSON.parse(created) as { id?: string }).id;
  assert.ok(itemId);

  const graphInstall = path.join(pmRoot, "extensions", "pm-graph");
  const markerExtension = path.join(pmRoot, "extensions", "graph-read-marker");
  const marker = path.join(root, "extension-activated");
  await mkdir(markerExtension, { recursive: true });
  await writeFile(path.join(markerExtension, "manifest.json"), JSON.stringify({
    name: "graph-read-marker",
    version: "1.0.0",
    entry: "./index.mjs",
    capabilities: ["commands"],
  }));
  await writeFile(path.join(markerExtension, "index.mjs"),
    'import { writeFileSync } from "node:fs"; export function activate() { writeFileSync(process.env.PM_WEB_GRAPH_READ_MARKER, "activated"); }\n');
  const previousMarker = process.env.PM_WEB_GRAPH_READ_MARKER;
  process.env.PM_WEB_GRAPH_READ_MARKER = marker;
  t.after(() => {
    if (previousMarker === undefined) delete process.env.PM_WEB_GRAPH_READ_MARKER;
    else process.env.PM_WEB_GRAPH_READ_MARKER = previousMarker;
  });
  execFileSync("pm", ["extension", "--json", "--pm-path", pmRoot], { stdio: "ignore" });
  assert.equal(existsSync(marker), true, "the control proves an extension-state probe activates extensions");
  await unlink(marker);

  const settingsFile = path.join(pmRoot, "settings.json");
  const settingsBefore = await readFile(settingsFile);
  assert.equal(existsSync(graphInstall), false);

  const server = await startApp();
  t.after(() => server.close());
  const url = `/api/projects/${project.id}/pm/graph`;
  const get = await authedFetch(server, viewer, url);
  assert.equal(get.status, 200);
  const body = await get.json() as {
    extensionAvailable?: boolean;
    graph?: {
      source?: string;
      nodes?: Array<{ id?: string }>;
      relationships?: Array<{ from: string; to: string; type: string }>;
    };
  };
  assert.equal(body.extensionAvailable, false);
  assert.equal(body.graph?.source, "pm-web");
  assert.ok(body.graph?.nodes?.some((node) => node.id === itemId));
  assert.equal(body.graph?.relationships?.filter((edge) =>
    edge.from === itemId && edge.to === targetId && edge.type === "BLOCKED_BY").length, 1);

  const head = await authedFetch(server, viewer, url, { method: "HEAD" });
  assert.equal(head.status, 200);
  const ownerGet = await authedFetch(server, owner, url);
  assert.equal(ownerGet.status, 200);
  assert.equal((await ownerGet.json() as { extensionAvailable?: boolean }).extensionAvailable, false);

  const deniedSync = await authedFetch(server, viewer, `${url}/sync`, { method: "POST" });
  assert.equal(deniedSync.status, 403);

  const previousBin = process.env.PM_CLI_BIN;
  process.env.PM_CLI_BIN = path.join(root, "missing-pm-binary");
  try {
    const unreadable = await authedFetch(server, viewer, url);
    assert.equal(unreadable.status, 200);
    const unreadableBody = await unreadable.json() as { extensionAvailable?: boolean; graph?: { source?: string } };
    assert.equal(unreadableBody.extensionAvailable, false);
    assert.equal(unreadableBody.graph?.source, "pm-web");
  } finally {
    if (previousBin === undefined) delete process.env.PM_CLI_BIN;
    else process.env.PM_CLI_BIN = previousBin;
  }

  assert.equal(existsSync(graphInstall), false);
  assert.deepEqual(await readFile(settingsFile), settingsBefore);
  assert.equal(existsSync(marker), false, "graph reads must not activate installed extensions");
});
