import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FLEET_NATIVE_COMMANDS_PATH, type FleetExtension } from "../src/services/fleet-snapshot.ts";
import { readFleetCommands, readFleetCommandMetadata, readNativeFleetCommands } from "../scripts/read-fleet-commands.ts";

test("command snapshots use manifest-selected source metadata and never execute handlers or alter the source", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-command-fixture-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ name: "pm-fixture", version: "1.0.0", entry: "./dist/index.js", capabilities: ["commands", "importers"] }));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pm-fixture", type: "module" }));
    const source = `export function activate(api) {
      for (const name of ["fixture validate", "fixture sync"]) api.registerCommand({ name, description: "Synthetic declaration", run() { throw new Error("Handlers must not run"); } });
      api.registerImporter("fixture-data", async () => { throw new Error("Importer must not run"); }, { description: "Synthetic importer" });
    }`;
    writeFileSync(path.join(root, "src/index.ts"), source);
    writeFileSync(path.join(root, "dist/index.js"), 'throw new Error("Stale build must not load");');
    const manifest = readFileSync(path.join(root, "manifest.json"), "utf8");
    assert.deepEqual(await readFleetCommands(root, "pm-fixture"), ["pm fixture sync", "pm fixture validate", "pm fixture-data import"]);
    assert.equal(readFileSync(path.join(root, "src/index.ts"), "utf8"), source);
    assert.equal(readFileSync(path.join(root, "manifest.json"), "utf8"), manifest);
    writeFileSync(path.join(root, "src/index.ts"), 'export function activate() { throw new Error("Invalid package activation"); }');
    await assert.rejects(readFleetCommands(root, "pm-fixture"), /command metadata load failed/);
    rmSync(path.join(root, "src/index.ts"));
    await assert.rejects(readFleetCommands(root, "pm-fixture"), /no source corresponding/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command snapshot remains fresh against available canonical package sources", async () => {
  const fleetRoot = process.env.PM_FLEET_ROOT;
  if (!fleetRoot) return; // Standalone CI still checks all committed command declarations in catalog.test.ts.
  const snapshot = JSON.parse(readFileSync("test/fleet-extensions.snapshot.json", "utf8")) as FleetExtension[];
  const native = JSON.parse(readFileSync(FLEET_NATIVE_COMMANDS_PATH, "utf8")) as Record<string, string[]>;
  assert.deepEqual(native["pm-rust"], readNativeFleetCommands(fleetRoot));
  const declared = await readFleetCommandMetadata(fleetRoot, snapshot.map((extension) => extension.name));
  for (const extension of snapshot) {
    assert.deepEqual(extension.commands, declared.get(extension.name),
      `${extension.name}: command declarations changed; regenerate with npm run fleet:snapshot`);
  }
});

test("command discovery uses manifest identities and rejects conflicting or empty declarations", async () => {
  const fleet = mkdtempSync(path.join(tmpdir(), "pm-web-command-fleet-"));
  try {
    for (const directory of ["a-renamed", "b-worktree"]) {
      const target = path.join(fleet, directory);
      mkdirSync(target);
      writeFileSync(path.join(target, "manifest.json"), JSON.stringify({ name: "pm-fixture", version: "1.0.0", entry: "index.ts", capabilities: ["commands"] }));
      writeFileSync(path.join(target, "package.json"), '{"type":"module"}');
      writeFileSync(path.join(target, "index.ts"), `export function activate(api) {
        api.registerCommand({ name: "fixture sync", description: "Fixture", run() { return { ok: true }; } });
      }`);
    }
    assert.deepEqual(await readFleetCommandMetadata(fleet, ["pm-fixture"]), new Map([["pm-fixture", ["pm fixture sync"]]]));
    await assert.rejects(readFleetCommandMetadata(fleet, ["pm-absent"]), /no command metadata found/);
    writeFileSync(path.join(fleet, "b-worktree/index.ts"), 'export function activate() {}');
    await assert.rejects(readFleetCommandMetadata(fleet, ["pm-fixture"]), /conflicting worktree command metadata/);
    rmSync(path.join(fleet, "a-renamed"), { recursive: true });
    await assert.rejects(readFleetCommandMetadata(fleet, ["pm-fixture"]), /no command metadata found/);
  } finally { rmSync(fleet, { recursive: true, force: true }); }
});

test("native command metadata comes from Cargo and README declarations and refuses empty receipts", () => {
  const fleet = mkdtempSync(path.join(tmpdir(), "pm-web-native-metadata-"));
  try {
    const directory = path.join(fleet, "pm-rust");
    mkdirSync(directory);
    const cargo = '[[bin]]\nname = "pm-rust"\npath = "src/main.rs"\n';
    writeFileSync(path.join(directory, "Cargo.toml"), cargo);
    writeFileSync(path.join(directory, "README.md"), `cargo run -- unrelated
## Current native slice
cargo run -- --workspace "generic workspace" list --json
cargo run -- claim fixture-id
cargo run -- claim another-id
## Development
cargo run -- unrelated
`);
    assert.deepEqual(readNativeFleetCommands(fleet), ["pm-rust claim", "pm-rust list"]);
    writeFileSync(path.join(directory, "Cargo.toml"), '[[bin]]\nname = "different"\n');
    assert.throws(() => readNativeFleetCommands(fleet), /must declare the native binary/);
    writeFileSync(path.join(directory, "Cargo.toml"), cargo);
    writeFileSync(path.join(directory, "README.md"), "No documented commands");
    assert.throws(() => readNativeFleetCommands(fleet), /declares no native command paths/);
  } finally { rmSync(fleet, { recursive: true, force: true }); }
});
