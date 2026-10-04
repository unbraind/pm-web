/**
 * Real HTTP, PostgreSQL, and PM workspace regression for graph reads.
 * A viewer may read a graph, but a safe-method request must not provision an
 * extension in the shared workspace.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

/**
 * Mutating pm actions that must never appear in a graph-read command log.
 * Reads (list/get/context/search/`extension --json` listings/graph queries)
 * stay allowed; anything that installs, provisions, creates, updates, closes,
 * claims, releases, or rewrites workspace state is a mutation entry.
 */
const MUTATION_ACTIONS = new Set([
  "install", "uninstall", "create", "update", "update-many", "close", "claim",
  "release", "plan", "merge", "test", "test-all", "gc", "reindex", "init",
  "upgrade", "snapshot", "comment", "note", "learning", "delete", "remove", "add",
]);

/** Mutating subcommands of the read-listing `pm extension` verb. */
const MUTATION_EXTENSION_SUBCOMMANDS = new Set([
  "activate", "deactivate", "install", "uninstall", "enable", "disable",
]);

/** Mutating subcommands of the `pm workspace` verb. */
const MUTATION_WORKSPACE_SUBCOMMANDS = new Set([
  "config", "schema", "profile", "snapshot", "merge", "init",
]);

/**
 * Decide whether one logged pm command line is a mutation entry.
 *
 * The log records the exact argv pm-web spawned, so the first token is the pm
 * action; `extension` and `workspace` carry their mutating subcommand second.
 *
 * @param line - One logged command line (space-joined argv).
 * @returns True when the line records a mutating command.
 */
function isMutationCommandEntry(line: string): boolean {
  const [first, second] = line.trim().split(/\s+/);
  if (first !== undefined && MUTATION_ACTIONS.has(first)) return true;
  if (first === "extension" && second !== undefined && MUTATION_EXTENSION_SUBCOMMANDS.has(second)) return true;
  if (first === "workspace" && second !== undefined && MUTATION_WORKSPACE_SUBCOMMANDS.has(second)) return true;
  return false;
}

test("graph GET and HEAD by a view-only collaborator leave extensions untouched", async (t) => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-graph-read-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  const previousMarker = process.env.PM_WEB_GRAPH_READ_MARKER;
  const fixture: { server?: Awaited<ReturnType<typeof startApp>> } = {};
  process.env.PROJECTS_ROOT = root;
  t.after(async () => {
    try {
      if (fixture.server !== undefined) {
        try {
          assert.equal(existsSync(root), true, "the server closes before workspace deletion");
          assert.equal(process.env.PROJECTS_ROOT, root, "the server closes before environment restoration");
        } finally {
          await fixture.server.close();
        }
      }
    } finally {
      if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = previousRoot;
      if (previousMarker === undefined) delete process.env.PM_WEB_GRAPH_READ_MARKER;
      else process.env.PM_WEB_GRAPH_READ_MARKER = previousMarker;
      if (previousCliBin === undefined) delete process.env.PM_CLI_BIN;
      else process.env.PM_CLI_BIN = previousCliBin;
      if (previousCommandLog === undefined) delete process.env.PM_WEB_COMMAND_LOG;
      else process.env.PM_WEB_COMMAND_LOG = previousCommandLog;
      if (previousRealPmBin === undefined) delete process.env.PM_WEB_REAL_PM_BIN;
      else process.env.PM_WEB_REAL_PM_BIN = previousRealPmBin;
      await rm(root, { recursive: true, force: true });
    }
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
  process.env.PM_WEB_GRAPH_READ_MARKER = marker;
  execFileSync("pm", ["extension", "--json", "--pm-path", pmRoot], { stdio: "ignore" });
  assert.equal(existsSync(marker), true, "the control proves an extension-state probe activates extensions");
  await unlink(marker);

  const settingsFile = path.join(pmRoot, "settings.json");
  const settingsBefore = await readFile(settingsFile);
  assert.equal(existsSync(graphInstall), false);

  // Command log: PM_CLI_BIN wraps the real pm and records every spawn pm-web
  // makes (forwarding argv so a read spawn still succeeds). The acceptance is
  // that graph reads leave this log free of mutation entries: if a GET/HEAD
  // route ever provisions or mutates through a spawned pm command, the logged
  // line fails the assertion below.
  const commandLog = path.join(root, "commands.log");
  const commandLoggingPm = path.join(root, "pm-command-log-wrapper");
  await writeFile(commandLoggingPm, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const log = process.env.PM_WEB_COMMAND_LOG;
if (log) fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
const result = spawnSync(process.env.PM_WEB_REAL_PM_BIN || "pm", process.argv.slice(2), {
  stdio: "inherit",
});
process.exit(result.status ?? (result.error ? 1 : 0));
`);
  await chmod(commandLoggingPm, 0o755);
  const previousCliBin = process.env.PM_CLI_BIN;
  const previousCommandLog = process.env.PM_WEB_COMMAND_LOG;
  const previousRealPmBin = process.env.PM_WEB_REAL_PM_BIN;
  process.env.PM_CLI_BIN = commandLoggingPm;
  process.env.PM_WEB_COMMAND_LOG = commandLog;

  const server = await startApp();
  fixture.server = server;
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

  const neighborsUrl = `${url}/neighbors/${itemId}`;
  const neighbors = await authedFetch(server, viewer, neighborsUrl);
  assert.equal(neighbors.status, 200);
  const neighborsBody = await neighbors.json() as {
    extensionAvailable?: boolean;
    center?: { id?: string };
    neighbors?: Array<{ node?: { id?: string }; relationship?: { type?: string; direction?: string } }>;
  };
  assert.equal(neighborsBody.extensionAvailable, false);
  assert.equal(neighborsBody.center?.id, itemId);
  assert.ok(neighborsBody.neighbors?.some((entry) =>
    entry.node?.id === targetId && entry.relationship?.type === "BLOCKED_BY" && entry.relationship.direction === "outgoing"));
  const incoming = await authedFetch(server, viewer, `${url}/neighbors/${targetId}`);
  assert.equal(incoming.status, 200);
  const incomingBody = await incoming.json() as {
    neighbors?: Array<{ node?: { id?: string }; relationship?: { type?: string; direction?: string } }>;
  };
  assert.ok(incomingBody.neighbors?.some((entry) =>
    entry.node?.id === itemId && entry.relationship?.type === "BLOCKED_BY" && entry.relationship.direction === "incoming"));
  assert.equal((await authedFetch(server, viewer, neighborsUrl, { method: "HEAD" })).status, 200);
  const missingNeighbors = await authedFetch(server, viewer, `${url}/neighbors/unknown-item-id`);
  assert.equal(missingNeighbors.status, 200);
  const missingBody = await missingNeighbors.json() as { center?: unknown; neighbors?: unknown[]; extensionAvailable?: boolean };
  assert.equal(missingBody.center, null);
  assert.deepEqual(missingBody.neighbors, []);
  assert.equal(missingBody.extensionAvailable, false);

  const separateProject = await seedProject(viewer.id);
  const separatePmRoot = path.join(root, viewer.id, separateProject.slug, ".agents", "pm");
  await mkdir(path.dirname(path.dirname(separatePmRoot)), { recursive: true });
  execFileSync("pm", ["init", "--pm-path", separatePmRoot], { stdio: "ignore" });
  const separateItem = execFileSync("pm", [
    "create", "--type", "Task", "--title", "Separate project item", "--pm-path", separatePmRoot, "--json",
  ], { encoding: "utf8" });
  const separateItemId = (JSON.parse(separateItem) as { id?: string }).id;
  assert.ok(separateItemId);
  assert.notEqual(separateItemId, itemId);
  const separateRead = await authedFetch(server, viewer,
    `/api/projects/${separateProject.id}/pm/graph/neighbors/${itemId}`);
  assert.equal(separateRead.status, 200);
  const separateBody = await separateRead.json() as { center?: unknown; neighbors?: unknown[] };
  assert.equal(separateBody.center, null, "a project cannot read a node from another project");
  assert.deepEqual(separateBody.neighbors, []);
  assert.equal(existsSync(marker), false, "neighbor reads must not activate installed extensions");

  // The acceptance criterion this regression pins: the graph read phase's
  // command log must stay free of mutation entries. Reads (including an empty
  // log, since the graph read path dispatches through the in-process SDK) are
  // fine; any provisioning or tracker mutation recorded here fails.
  const commandLogText = await readFile(commandLog, "utf8").catch(() => "");
  const mutationEntries = commandLogText.split("\n").filter((line) => line.trim() !== "")
    .filter(isMutationCommandEntry);
  assert.deepEqual(mutationEntries, [],
    "graph GET and HEAD requests must never spawn a mutating pm command");

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
