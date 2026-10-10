import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { readFleetExtensions, type FleetExtension } from "../src/services/fleet-snapshot.ts";

/** Write real package metadata with optional malformed fields for discovery tests. */
function writePackage(root: string, directory: string, manifest: Record<string, unknown>, pkg: Record<string, unknown> = {}): string {
  const target = path.join(root, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "manifest.json"), JSON.stringify({
    name: "pm-thing", description: "does a thing", capabilities: ["schema", "commands"], ...manifest,
  }));
  writeFileSync(path.join(target, "package.json"), JSON.stringify({
    name: "pm-thing", description: "concise", repository: "git+https://github.com/unbraind/pm-thing.git",
    publishConfig: { access: "public" }, ...pkg,
  }));
  return target;
}

test("fleet discovery uses canonical identities regardless of checkout names and deduplicates repositories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-fleet-"));
  try {
    writePackage(root, "arbitrary-checkout", {});
    writePackage(root, "pm-thing-candidate", {}, { repository: { url: "git@github.com:unbraind/pm-thing.git" } });
    writePackage(root, "another-checkout", {}, { repository: "ssh://git@github.com/unbraind/pm-thing.git/" });
    writePackage(root, "pm-web-candidate", { name: "pm-web" }, { name: "@unbrained/pm-web" });
    writePackage(root, "cli-candidate", { name: "pm-cli" });
    writeFileSync(path.join(root, "pm-file"), "not a directory");
    mkdirSync(path.join(root, "pm-no-manifest"));
    writePackage(root, "pm-empty", { capabilities: [] });
    assert.deepEqual(readFleetExtensions(root, { existsSync, readdirSync, readFileSync }), {
      extensions: [{ name: "pm-thing", description: "does a thing", packageDescription: "concise",
        capabilities: ["commands", "schema"], publishable: true }],
      problems: [],
    });
    assert.deepEqual(readFleetExtensions(path.join(root, "absent"), { existsSync, readdirSync, readFileSync }), {
      extensions: [], problems: [],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovery reports malformed, missing and conflicting identity metadata without silently accepting it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-fleet-invalid-"));
  try {
    const invalid = [
      ["bad-json", "manifest.json exists but is not valid JSON"],
      ["null-manifest", "manifest.json exists but is not valid JSON"],
      ["missing-name", "manifest.json declares no canonical pm package name"],
      ["invalid-name", "manifest.json declares no canonical pm package name"],
      ["no-caps", "manifest.json declares no capabilities array"],
      ["numeric-cap", "manifest.json capabilities must be non-empty strings"],
      ["empty-cap", "manifest.json capabilities must be non-empty strings"],
      ["bad-pkg", "package.json is missing or is not valid JSON metadata"],
      ["null-pkg", "package.json is missing or is not valid JSON metadata"],
      ["no-pkg", "package.json is missing or is not valid JSON metadata"],
      ["wrong-name", "package name/repository does not match the canonical manifest identity"],
      ["wrong-repo", "package name/repository does not match the canonical manifest identity"],
      ["no-repo", "package name/repository does not match the canonical manifest identity"],
      ["numeric-repo", "package name/repository does not match the canonical manifest identity"],
    ];
    for (const [directory] of invalid) writePackage(root, directory!, {});
    writeFileSync(path.join(root, "bad-json/manifest.json"), "{ invalid");
    writeFileSync(path.join(root, "null-manifest/manifest.json"), "null");
    writePackage(root, "missing-name", { name: null });
    writePackage(root, "invalid-name", { name: "../pm-thing" });
    writePackage(root, "no-caps", { capabilities: null });
    writePackage(root, "numeric-cap", { capabilities: [42] });
    writePackage(root, "empty-cap", { capabilities: [""] });
    writeFileSync(path.join(root, "bad-pkg/package.json"), "{ invalid");
    writeFileSync(path.join(root, "null-pkg/package.json"), "null");
    rmSync(path.join(root, "no-pkg/package.json"));
    writePackage(root, "wrong-name", {}, { name: "pm-other" });
    writePackage(root, "wrong-repo", {}, { repository: "https://github.com/another/pm-thing" });
    writePackage(root, "no-repo", {}, { repository: null });
    writePackage(root, "numeric-repo", {}, { repository: { url: 42 } });
    assert.deepEqual(readFleetExtensions(root, { existsSync, readdirSync, readFileSync }), {
      extensions: [], problems: invalid.map(([name, reason]) => ({ name, reason })).sort((a, b) => a.name!.localeCompare(b.name!)),
    });
    for (const [incomplete, conflicting] of [["first", "second"], ["second", "first"]]) {
      writePackage(root, incomplete!, { description: null }, { description: 42, publishConfig: undefined });
      writePackage(root, conflicting!, { description: "conflict" });
      const result = readFleetExtensions(root, { existsSync, readdirSync, readFileSync });
      assert.ok([
        { name: "pm-thing", description: "", packageDescription: "",
          capabilities: ["commands", "schema"], publishable: false },
        { name: "pm-thing", description: "conflict", packageDescription: "concise",
          capabilities: ["commands", "schema"], publishable: true },
      ].some((expected) => isDeepStrictEqual(result.extensions, [expected])));
      assert.ok(result.problems.some((problem) => problem.reason === "conflicting worktree metadata for pm-thing"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fleet containing a sibling git worktree of another package yields one canonical extension", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-fleet-worktree-"));
  try {
    const fleet = path.join(root, "fleet");
    mkdirSync(fleet);
    const snapshot = JSON.parse(readFileSync("test/fleet-extensions.snapshot.json", "utf8")) as FleetExtension[];
    for (const extension of snapshot) {
      writePackage(fleet, `${extension.name}-checkout`, {
        name: extension.name, description: extension.description, capabilities: extension.capabilities,
      }, {
        name: extension.name, description: extension.packageDescription,
        repository: `https://github.com/unbraind/${extension.name}`,
        publishConfig: extension.publishable ? { access: "public" } : undefined,
      });
    }
    const repository = path.join(fleet, "pm-graph-checkout");
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", ["-C", repository, "add", "manifest.json", "package.json"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic package"]);
    const candidate = path.join(fleet, "pm-graph-candidate");
    execFileSync("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", candidate]);
    assert.ok(readFileSync(path.join(candidate, ".git"), "utf8").startsWith("gitdir:"));
    const result = readFleetExtensions(fleet, { existsSync, readdirSync, readFileSync });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.extensions, snapshot.map(({ npmPublished: _npmPublished, ...local }) => local));
    // Exercise the actual optional live-fleet assertions against renamed
    // checkouts plus the duplicate Git worktree, including manifest comparisons.
    execFileSync(process.execPath, ["--test", "test/catalog.test.ts"], {
      env: { ...process.env, PM_FLEET_ROOT: fleet }, stdio: "pipe",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
