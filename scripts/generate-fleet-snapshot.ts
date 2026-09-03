/**
 * Regenerate the committed snapshot of every pm extension present in the fleet.
 *
 * The catalog completeness gate has to answer one question — does the catalog
 * cover every pm extension that exists? — and the authoritative answer lives in
 * the sibling package directories, which a standalone CI checkout of pm-web does
 * not have. Reading them directly made the gate skip itself in exactly the
 * environment that guards the merge, so a package could be (and was) absent from
 * the catalog while every CI run stayed green.
 *
 * This script writes what the fleet says into a file CI can read. The snapshot is
 * an input to the gate, never the source of truth: a second test asserts the
 * snapshot still matches the live fleet wherever the siblings are resolvable, so
 * a stale snapshot fails loudly rather than silently narrowing what CI checks.
 *
 * Run with `npm run fleet:snapshot` from a checkout that has the fleet siblings
 * beside it, or set `PM_FLEET_ROOT` to point at a fleet root explicitly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLEET_SNAPSHOT_PATH, readFleetExtensions } from "../src/services/fleet-snapshot.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fleetRoot = process.env["PM_FLEET_ROOT"]
  ? path.resolve(process.env["PM_FLEET_ROOT"])
  : path.resolve(packageRoot, "..");

const { extensions, problems } = readFleetExtensions(fleetRoot, { existsSync, readdirSync, readFileSync });
if (problems.length > 0) {
  // A directory whose metadata could not be read is a defect to fix, not a
  // package to omit. Writing the snapshot anyway would bake the omission in and
  // the freshness assertion would agree with it, because it runs the same
  // derivation - so neither would ever report the gap.
  for (const problem of problems) console.error(`fleet-snapshot: ${problem.name}: ${problem.reason}`);
  console.error("Refusing to write a snapshot derived from unreadable metadata.");
  process.exit(1);
}
if (extensions.length === 0) {
  console.error(
    `No pm extensions found under ${fleetRoot}. Run this from a checkout with the fleet `
      + "siblings beside it, or set PM_FLEET_ROOT. Refusing to write an empty snapshot, "
      + "because an empty one would make the completeness gate pass vacuously.",
  );
  process.exit(1);
}

/**
 * Ask the npm registry whether it serves `name`.
 *
 * Generation is the right moment for this question: it is a deliberate,
 * online act, whereas the gate that reads the snapshot must work on an offline
 * runner. `null` distinguishes "the registry says no" from "the registry could
 * not be reached", so a lost network cannot silently relabel every package as
 * unpublished.
 *
 * @param name - Package name to look up.
 * @returns True when the registry serves a version, false when it answers 404,
 *          null when the lookup itself failed.
 */
function npmServes(name: string): boolean | null {
  try {
    execFileSync("npm", ["view", name, "version"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return true;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes("E404") || stderr.includes("404 Not Found")) return false;
    return null;
  }
}

const withRegistry = extensions.map((extension) => ({
  ...extension,
  npmPublished: npmServes(extension.name),
}));
const unreachable = withRegistry.filter((extension) => extension.npmPublished === null);
if (unreachable.length > 0) {
  for (const extension of unreachable) {
    console.error(`fleet-snapshot: could not reach the npm registry for ${extension.name}`);
  }
  console.error(
    "Refusing to write a snapshot that records the registry as unknown for some packages: the gate "
      + "would fall back to publishConfig for exactly those, which is the proxy this field replaces.",
  );
  process.exit(1);
}

const target = path.join(packageRoot, FLEET_SNAPSHOT_PATH);
writeFileSync(target, `${JSON.stringify(withRegistry, null, 2)}\n`, "utf8");
console.log(`Wrote ${withRegistry.length} fleet extensions to ${target}`);
