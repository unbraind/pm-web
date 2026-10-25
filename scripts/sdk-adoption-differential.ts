/** Compare the audited SDK adapters with a built baseline using public Git snapshots only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scratch = await mkdtemp(path.join(tmpdir(), "pm-web-sdk-differential-"));
const repo = process.cwd();
const baseline = process.env.PM_SDK_BASE_REF || "74ee868";
const sources = process.argv.slice(2);
if (sources.length === 0) sources.push(repo);
const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() };

/** Extract tracked public files without reading runtime caches or changing the source checkout. */
async function archive(source: string, ref: string, destination: string, paths: string[] = []) {
  await mkdir(destination, { recursive: true });
  const bytes = execFileSync("git", ["-C", source, "archive", ref, ...paths], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", destination], { input: bytes });
}

try {
  for (const label of ["before", "after"]) {
    const build = path.join(scratch, label);
    if (label === "before") {
      await archive(repo, baseline, build);
      await symlink(path.join(repo, "node_modules"), path.join(build, "node_modules"), "junction");
      execFileSync(process.execPath, [path.join(repo, "node_modules/typescript/bin/tsc")], { cwd: build });
    } else {
      await mkdir(build);
      await cp(path.join(repo, "dist"), path.join(build, "dist"), { recursive: true });
      await writeFile(path.join(build, "package.json"), '{"type":"module"}');
      await symlink(path.join(repo, "node_modules"), path.join(build, "node_modules"), "junction");
    }
    // Expose the two private baseline functions in scratch builds only; their bodies stay unchanged.
    if (label === "before") await appendFile(path.join(build, "dist/services/pm-runner.js"), "\nexport { configureLocalOllamaSearch };\n");
    await appendFile(path.join(build, "dist/index.js"), "\nexport { workspaceInitialized };\n");
    const runnerUrl = pathToFileURL(path.join(build, "dist/services/pm-runner.js")).href;
    const indexUrl = pathToFileURL(path.join(build, "dist/index.js")).href;
    await writeFile(path.join(build, "probe.mjs"), `
import { configureLocalOllamaSearch, projectExists } from ${JSON.stringify(runnerUrl)};
import { workspaceInitialized } from ${JSON.stringify(indexUrl)};
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2];
process.env.PROJECTS_ROOT = root;
const project = path.join(root, 'owner', 'project');
const pmRoot = path.join(project, '.agents', 'pm');
const initialized = await workspaceInitialized(pmRoot);
const exists = await projectExists('owner', 'project');
const missing = await projectExists('owner', 'absent');
const historyPath = path.join(pmRoot, 'history', '_workspace.jsonl');
const beforeHistory = await fs.readFile(historyPath, 'utf8').catch(() => '');
await configureLocalOllamaSearch(project);
const settings = JSON.parse(await fs.readFile(path.join(pmRoot, 'settings.json'), 'utf8'));
const afterHistory = await fs.readFile(historyPath, 'utf8').catch(() => '');
const markerRoot = path.join(root, 'marker-only');
await fs.mkdir(path.join(markerRoot, 'tasks'), {recursive:true});
const markerOnly = await workspaceInitialized(markerRoot);
await fs.chmod(pmRoot, 0o111);
let unreadable; let unreadableProject;
try { unreadable = await workspaceInitialized(pmRoot); unreadableProject = await projectExists('owner', 'project'); }
finally { await fs.chmod(pmRoot, 0o755); }
const invalidProject = path.join(root, 'invalid');
await fs.mkdir(path.join(invalidProject, '.agents', 'pm'), {recursive:true});
await fs.writeFile(path.join(invalidProject, '.agents', 'pm', 'settings.json'), '{"search":{"max_results":"invalid"},"opaque":"keep"}');
let invalidSettingsRefused = false;
try { await configureLocalOllamaSearch(invalidProject); } catch { invalidSettingsRefused = true; }
console.log(JSON.stringify({initialized, exists, missing, settings, markerOnly, unreadable, unreadableProject, invalidSettingsRefused,
  appendedHistoryEntries: afterHistory.trim().split('\\n').filter(Boolean).length - beforeHistory.trim().split('\\n').filter(Boolean).length}));
`);
  }
  for (const [index, source] of sources.entries()) {
    const publicSnapshot = path.join(scratch, `tracker-${index}`);
    await archive(path.resolve(source), "HEAD", publicSnapshot, [".agents/pm"]);
    const outputs: Array<Record<string, unknown>> = [];
    for (const label of ["before", "after"]) {
      const workspace = path.join(scratch, `tracker-${index}-${label}`);
      await mkdir(path.join(workspace, "owner", "project"), { recursive: true });
      await cp(path.join(publicSnapshot, ".agents"), path.join(workspace, "owner", "project", ".agents"), { recursive: true });
      const output = execFileSync(process.execPath, [path.join(scratch, label, "probe.mjs"), workspace], { env, encoding: "utf8" });
      outputs.push(JSON.parse(output) as Record<string, unknown>);
    }
    const [before, after] = outputs;
    assert.equal(before.markerOnly, true);
    assert.equal(after.markerOnly, false);
    assert.equal(before.unreadable, true);
    assert.equal(after.unreadable, false);
    assert.equal(before.unreadableProject, true);
    assert.equal(after.unreadableProject, false);
    assert.equal(before.invalidSettingsRefused, false);
    assert.equal(after.invalidSettingsRefused, true);
    assert.equal(before.appendedHistoryEntries, 0);
    assert.equal(after.appendedHistoryEntries, 1);
    for (const output of outputs) { delete output.markerOnly; delete output.appendedHistoryEntries; delete output.unreadable; delete output.unreadableProject; delete output.invalidSettingsRefused; }
    assert.deepEqual(after, before, "settings values and project-presence outputs must match");
    console.log(JSON.stringify({ tracker: index + 1, baseline, identical: ["settings", "initialized", "exists", "missing"],
      intentionalDifferences: ["marker-only roots refused", "unreadable roots refused", "invalid schema refused", "one verified settings audit entry appended"] }));
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
