import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listAllComplete } from "@unbrained/pm-cli/sdk";

import { findCatalogEntry, resolveNpmSpec } from "../dist/services/package-catalog.js";
import { readFleetExtensions } from "../dist/services/fleet-snapshot.js";

// Built-package acceptance: the real installed CLI creates a scratch tracker,
// and the real SDK verifies its contents. No provider or hosted data is used.
test("built catalog exposes Jev truthfully beside a real scratch tracker and excludes host worktrees", async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pm-web-built-catalog-"));
  try {
    const tracker = path.join(root, "tracker");
    fs.mkdirSync(tracker);
    const pmRoot = path.join(tracker, ".agents/pm");
    const cli = path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const env = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "codex-sol" };
    for (const args of [["init", "--prefix", "scratch"], ["create", "Synthetic catalog acceptance", "--type", "Task"]]) {
      execFileSync(process.execPath, [cli, ...args], { cwd: tracker, env, stdio: "pipe" });
    }
    const result = await listAllComplete({}, { cwd: tracker, pmRoot, noExtensions: true });
    assert.equal(result.items.length, 1);
    const before = fs.readFileSync(path.join(pmRoot, "settings.json"), "utf8");
    const entry = findCatalogEntry("pm-jev");
    assert.ok(entry, "pm-jev must appear in the built catalog");
    assert.deepEqual(entry.capabilities, ["commands", "schema"]);
    assert.equal(entry.category, "extension");
    assert.equal(entry.availability, "unreleased");
    assert.equal(resolveNpmSpec("pm-jev"), null, "npm returns 404; do not promise installation");
    assert.deepEqual(entry.links, {
      docs: "https://github.com/unbraind/pm-jev#readme", npm: "https://www.npmjs.com/package/pm-jev",
      repository: "https://github.com/unbraind/pm-jev", report: "https://github.com/unbraind/pm-jev/issues",
    });
    assert.match(entry.description, /local Ollama tev1 model by default/);
    assert.equal(entry.requiresCredentials?.[0]?.optional, true);
    assert.deepEqual(entry.requiresCredentials?.[0]?.envVars, ["TYPESAFE_API_KEY"]);
    const candidate = path.join(root, "pm-web-candidate");
    fs.mkdirSync(candidate);
    for (const file of ["manifest.json", "package.json"]) fs.writeFileSync(path.join(candidate, file), fs.readFileSync(file));
    assert.deepEqual(readFleetExtensions(root, { existsSync: fs.existsSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync }), { extensions: [], problems: [] });
    assert.equal(fs.readFileSync(path.join(pmRoot, "settings.json"), "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
