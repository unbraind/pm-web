/** Generated real-tracker round trips through the public exporter and the web read model. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { graphFromItems, type Graph } from "pm-graph";
import { listAllItemMetadata, serializeItemDocument, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { readProjectGraph, type ProjectGraph } from "../src/services/project-graph.ts";
import { createApp } from "../dist/app.js";
import { pool as builtPool } from "../dist/db.js";
import { authedFetch, ensureSchema, seedProject, seedUser, seedUserShare, uniqueEmail } from "./helpers/pg-harness.ts";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";

let root: string;
let previousRoot: string | undefined;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "graph-fidelity-"));
  previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
});

after(async () => {
  await builtPool.end();
  if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
  else process.env.PROJECTS_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

/** Build deterministic synthetic PM metadata with mixed lifecycles, facets and provenance. */
async function generatedTracker(owner: string, slug: string, seed: number, count: number): Promise<string> {
  const workspace = path.join(root, owner, slug);
  const pmRoot = path.join(workspace, ".agents", "pm");
  await mkdir(workspace, { recursive: true });
  execFileSync(path.resolve("node_modules/.bin/pm"), ["init", "fixture", "--path", pmRoot], {
    cwd: workspace, env: { ...process.env, PM_PATH: pmRoot }, stdio: "ignore",
  });
  let state = seed;
  /** Advance the deterministic generator so seeds reproduce the same graph. */
  const pick = (length: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % length;
  };
  const types = ["Task", "Issue", "Feature", "Epic"] as const;
  const folders = { Task: "tasks", Issue: "issues", Feature: "features", Epic: "epics" };
  const statuses = ["open", "in_progress", "blocked", "closed", "canceled"] as const;
  const kinds = ["related", "blocked_by", "blocks", "parent", "child"] as const;
  for (let index = 0; index < count; index += 1) {
    const type = types[pick(types.length)];
    const id = `fixture-${index.toString(36).padStart(4, "0")}`;
    const target = `fixture-${pick(Math.max(count, 1)).toString(36).padStart(4, "0")}`;
    const timestamp = `2026-01-${String(1 + pick(28)).padStart(2, "0")}T00:00:00.000Z`;
    const metadata: ItemMetadata = {
      id, type, title: `Synthetic ${index} “quoted”`, description: "Generated public fixture",
      status: statuses[pick(statuses.length)], priority: pick(5) as ItemMetadata["priority"],
      created_at: timestamp, updated_at: timestamp,
      tags: ["Parity", "parity", "unicode-ä", `tag-${pick(4)}`],
      assignee: `fixture-person-${pick(3)}`, sprint: `sprint-${pick(2)}`, release: "fixture-v1",
      deadline: "2026-12-31", parent: index % 3 === 0 ? target : undefined,
      blocked_by: index % 4 === 0 ? target : undefined, blocked_reason: "Synthetic reason",
      dependencies: [{ id: target, kind: kinds[pick(kinds.length)], created_at: timestamp,
        author: "fixture-agent", source_kind: "fixture:generated", author_source: "asserted" },
      { id: "fixture-external", kind: "related", created_at: timestamp, source_kind: "fixture:external" }],
      // Legacy dependency attributes exercise nested payloads and first-edge provenance.
      deps: [{ target, type: "custom-type", weight: index, provenance: { seed, flags: [true, false] }, _type: "retain-me" },
        { target, type: "custom-type", weight: -1 }],
    };
    const folder = path.join(pmRoot, folders[type]);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${id}.toon`), serializeItemDocument({ metadata, body: "Synthetic body" }));
  }
  return workspace;
}

/** Copy the exact published extension into a disposable tracker; never execute it on web reads. */
async function installFixtureGraph(workspace: string): Promise<string> {
  const directory = path.join(workspace, ".agents", "pm", "extensions", "pm-graph");
  await mkdir(directory, { recursive: true });
  await cp(path.resolve("node_modules/pm-graph/dist"), path.join(directory, "dist"), { recursive: true });
  await cp(path.resolve("node_modules/pm-graph/manifest.json"), path.join(directory, "manifest.json"));
  // Give the installed extension its real published runtime dependencies.
  await cp(path.resolve("node_modules/pm-graph/package.json"), path.join(directory, "package.json"));
  // Module resolution uses the package worktree dependencies through this fixture-only link.
  await symlink(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
  return directory;
}

/** Run the genuine installed extension command, with the real CLI and SDK readers. */
function extensionExport(workspace: string): Graph {
  return (JSON.parse(execFileSync(path.resolve("node_modules/.bin/pm"), ["pm-graph", "export", "--json"], {
    cwd: workspace, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PM_PATH: path.join(workspace, ".agents", "pm") },
  })) as { graph: Graph }).graph;
}

/** Compare every export field and array position, allowing only per-call generation time and web source. */
function assertExportParity(exported: Graph, model: ProjectGraph): void {
  assert.ok(Number.isFinite(Date.parse(model.generatedAt)));
  assert.ok(Number.isFinite(Date.parse(exported.generatedAt)));
  const { source, generatedAt: webTime, ...actual } = model;
  const { generatedAt: exportTime, ...expected } = exported;
  assert.ok(source === "pm-web" || source === "pm-graph");
  assert.ok(Math.abs(Date.parse(webTime) - Date.parse(exportTime)) < 30_000);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}

/** Snapshot tracker bytes recursively, excluding fixture links and reconstructible SDK metadata caches. */
async function trackerSnapshot(directory: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || /^metadata-cache(?:[.-]|$)/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = await trackerSnapshot(file);
      for (const [name, bytes] of Object.entries(children)) snapshot[`${entry.name}/${name}`] = bytes;
    } else snapshot[entry.name] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return snapshot;
}

test("round-trip property: generated real graphs preserve the installed export and built-in ordering", async () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const owner = `fixture-owner-${seed}`;
    const slug = `generated-${seed}`;
    const workspace = await generatedTracker(owner, slug, seed, seed === 1 ? 0 : seed * 3);
    await installFixtureGraph(workspace);
    const exported = extensionExport(workspace);
    const installed = await readProjectGraph(owner, slug);
    assertExportParity(exported, JSON.parse(JSON.stringify(installed.graph)) as ProjectGraph);
    assert.equal(installed.extensionAvailable, true);
    assert.equal(installed.graph.source, "pm-graph");
    await rm(path.join(workspace, ".agents", "pm", "extensions", "pm-graph"), { recursive: true });
    const builtIn = await readProjectGraph(owner, slug);
    assert.equal(builtIn.extensionAvailable, false);
    assert.equal(builtIn.graph.source, "pm-web");
    assertExportParity(exported, builtIn.graph);
  }
});

test("built GET/HEAD and neighbor reads preserve exports for viewers without running project code", async (t) => {
  await ensureSchema();
  const owner = await seedUser(uniqueEmail("export-owner"));
  const viewer = await seedUser(uniqueEmail("export-viewer"));
  const outsider = await seedUser(uniqueEmail("export-outsider"));
  const project = await seedProject(owner.id);
  await seedUserShare(project.id, viewer.id, "view");
  const workspace = await generatedTracker(owner.id, project.slug, 42, 40);
  const directory = await installFixtureGraph(workspace);
  const exported = extensionExport(workspace);
  // A poisoned entry throws and writes if any project code is imported during a read.
  await writeFile(path.join(directory, "dist", "index.js"),
    'import { writeFileSync } from "node:fs"; writeFileSync(new URL("../activated", import.meta.url), "unsafe"); throw new Error("project code executed");');
  const before = await trackerSnapshot(path.join(workspace, ".agents", "pm"));
  const server = await startEphemeralServer(createApp());
  t.after(() => server.close());
  const url = `/api/projects/${project.id}/pm/graph`;
  const response = await authedFetch(server, viewer, url);
  assert.equal(response.status, 200);
  const body = await response.json() as { graph: ProjectGraph; extensionAvailable: boolean };
  assertExportParity(exported, body.graph);
  assert.equal(body.extensionAvailable, true);
  assert.equal((await authedFetch(server, viewer, url, { method: "HEAD" })).status, 200);
  assert.equal((await authedFetch(server, outsider, url)).status, 404);
  assert.equal((await authedFetch(server, viewer, `${url}/sync`, { method: "POST" })).status, 403);
  const center = exported.nodes.find((node) => node.labels.includes("PmItem"));
  assert.ok(center);
  const neighborsUrl = `${url}/neighbors/${center.id}`;
  const neighbors = await authedFetch(server, viewer, neighborsUrl);
  assert.equal(neighbors.status, 200);
  const neighborhood = await neighbors.json() as {
    center: Graph["nodes"][number]; source: string; extensionAvailable: boolean;
    neighbors: Array<{ node: Graph["nodes"][number]; relationship: Graph["relationships"][number] & { direction: string } }>;
  };
  assert.equal(neighborhood.extensionAvailable, true);
  assert.equal(neighborhood.source, "pm-graph");
  assert.deepEqual(neighborhood.center.properties, center.properties);
  assert.deepEqual(neighborhood.center.labels, center.labels);
  const edges = exported.relationships.filter((edge) => edge.from === center.id || edge.to === center.id);
  assert.deepEqual(neighborhood.neighbors.map(({ relationship: { direction, ...edge } }) => {
    assert.ok(direction === "incoming" || direction === "outgoing");
    return edge;
  }), edges);
  for (const [index, entry] of neighborhood.neighbors.entries()) {
    const edge = edges[index];
    const node: Graph["nodes"][number] | undefined = exported.nodes.find((candidate) => candidate.id === (edge.from === center.id ? edge.to : edge.from));
    assert.deepEqual(entry.node.properties, node?.properties);
    assert.deepEqual(entry.node.labels, node?.labels);
  }
  assert.equal((await authedFetch(server, viewer, neighborsUrl, { method: "HEAD" })).status, 200);
  const missing = await authedFetch(server, viewer, `${url}/neighbors/missing`);
  assert.equal((await missing.json() as { extensionAvailable: boolean }).extensionAvailable, true);
  assert.deepEqual(await trackerSnapshot(path.join(workspace, ".agents", "pm")), before);
});

test("large-corpus certified graph reads are bounded without per-item commands", async (t) => {
  const workspace = await generatedTracker("fixture-large", "large", 73, 2000);
  const items = await listAllItemMetadata(path.join(workspace, ".agents", "pm"));
  const exported = graphFromItems(items, workspace, new Map());
  const started = performance.now();
  const model = await readProjectGraph("fixture-large", "large");
  const elapsed = performance.now() - started;
  assertExportParity(exported, model.graph);
  assert.equal(model.graph.nodes.filter((node) => node.labels.includes("PmItem")).length, 2000);
  assert.ok(elapsed < 10_000, `2000-item read exceeded 10 seconds: ${elapsed.toFixed(0)} ms`);
  t.diagnostic(`2000 items: ${elapsed.toFixed(0)} ms, ${model.graph.nodes.length} nodes, ${model.graph.relationships.length} edges`);
});

test("invalid graph manifests use the built-in model and malformed tracker data fails closed", async () => {
  const workspace = await generatedTracker("fixture-invalid", "invalid", 5, 3);
  const directory = path.join(workspace, ".agents", "pm", "extensions", "pm-graph");
  await mkdir(directory, { recursive: true });
  for (const manifest of ["{", "null", '{"name":"other","entry":"index.js"}', '{"name":"pm-graph"}']) {
    await writeFile(path.join(directory, "manifest.json"), manifest);
    assert.equal((await readProjectGraph("fixture-invalid", "invalid")).extensionAvailable, false);
  }
  await writeFile(path.join(workspace, ".agents", "pm", "tasks", "broken.toon"), "not valid item metadata");
  await assert.rejects(readProjectGraph("fixture-invalid", "invalid"));
});
