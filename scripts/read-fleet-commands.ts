/** Read package-declared command metadata through the pinned SDK in disposable copies. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { activateExtensions, buildExtensionDescribeResult, init, loadExtensions, readSettings } from "@unbrained/pm-cli/sdk";

/**
 * Inspect source registrations without building or writing to a canonical checkout.
 * The manifest selects the entry; its corresponding TypeScript source is loaded
 * in a disposable package copy, avoiding stale dist metadata. No handlers run.
 */
export async function readFleetCommands(packageDirectory: string, name: string): Promise<string[]> {
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "manifest.json"), "utf8")) as { entry: string };
  const source = manifest.entry.replace(/^\.\//, "").replace(/^dist\//, "").replace(/\.js$/, ".ts");
  const entry = [source, `src/${source}`].find((candidate) => existsSync(path.join(packageDirectory, candidate)));
  if (!entry) throw new Error(`${name}: no source corresponding to manifest entry`);
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-command-metadata-"));
  try {
    symlinkSync(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "junction");
    const pmRoot = path.join(root, ".agents", "pm");
    await init("fixture", { defaults: true, mergeFence: false, agentGuidance: "skip" }, { pmRoot, cwd: root, noExtensions: true });
    const copy = path.join(pmRoot, "extensions", name);
    mkdirSync(path.dirname(copy), { recursive: true });
    cpSync(packageDirectory, copy, {
      recursive: true,
      filter: (candidate) => !["node_modules", ".git", ".agents", "dist", "dist-test", "coverage", "test"].includes(path.basename(candidate)),
    });
    symlinkSync(path.join(packageDirectory, "node_modules"), path.join(copy, "node_modules"), "junction");
    writeFileSync(path.join(copy, "manifest.json"), JSON.stringify({ ...manifest, entry: `./${entry}` }));
    const settings = await readSettings(pmRoot);
    settings.extensions.enabled = [name];
    const loaded = await loadExtensions({ pmRoot, cwd: root, settings, ignoreGlobalExtensions: true });
    const active = await activateExtensions(loaded);
    if (loaded.loaded.length !== 1 || loaded.failed.length || active.failed.length) {
      throw new Error(`${name}: command metadata load failed: ${JSON.stringify([...loaded.failed, ...active.failed])}`);
    }
    return buildExtensionDescribeResult(name, loaded, active).union.command_handlers.map((command) => `pm ${command}`).sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Resolve every matching checkout by manifest identity and reject conflicting command declarations. */
export async function readFleetCommandMetadata(fleetRoot: string, names: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const directories = readdirSync(fleetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const directory of directories) {
    const packageDirectory = path.join(fleetRoot, directory.name);
    const manifestPath = path.join(packageDirectory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string };
    if (!names.includes(manifest.name)) continue;
    const commands = await readFleetCommands(packageDirectory, manifest.name);
    const previous = result.get(manifest.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(commands)) {
      throw new Error(`${manifest.name}: conflicting worktree command metadata`);
    }
    result.set(manifest.name, commands);
  }
  for (const name of names) {
    if (!result.get(name)?.length) throw new Error(`${name}: no command metadata found`);
  }
  return result;
}

/** Read the native binary identity and documented cargo command paths without building or executing Rust. */
export function readNativeFleetCommands(fleetRoot: string): string[] {
  const directory = path.join(fleetRoot, "pm-rust");
  const cargo = readFileSync(path.join(directory, "Cargo.toml"), "utf8");
  let inBinaryTable = false;
  let nativeBinaryDeclared = false;
  for (const line of cargo.split(/\r?\n/)) {
    if (/^[\t ]*\[/.test(line)) {
      inBinaryTable = /^[\t ]*\[\[[\t ]*bin[\t ]*\]\][\t ]*(?:#.*)?$/.test(line);
    } else if (inBinaryTable && /^[\t ]*name[\t ]*=[\t ]*(?:"pm-rust"|'pm-rust')[\t ]*(?:#.*)?$/.test(line)) {
      nativeBinaryDeclared = true;
    }
  }
  if (!nativeBinaryDeclared) {
    throw new Error("pm-rust: Cargo metadata must declare the native binary");
  }
  const readme = readFileSync(path.join(directory, "README.md"), "utf8");
  const section = readme.split("## Current native slice")[1]?.split("\n## ")[0] ?? "";
  const commands = new Set<string>();
  for (const line of section.split("\n")) {
    const match = /^cargo run -- (?:--workspace (?:"[^"]*"|'[^']*'|\S+) )?([a-z][a-z-]*)\b/.exec(line);
    if (match) commands.add(`pm-rust ${match[1]}`);
  }
  if (!commands.size) throw new Error("pm-rust: README declares no native command paths");
  return [...commands].sort();
}
