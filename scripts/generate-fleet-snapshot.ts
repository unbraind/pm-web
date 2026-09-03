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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLEET_SNAPSHOT_PATH, readFleetExtensions } from "../src/services/fleet-snapshot.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fleetRoot = process.env["PM_FLEET_ROOT"]
  ? path.resolve(process.env["PM_FLEET_ROOT"])
  : path.resolve(packageRoot, "..");

const extensions = readFleetExtensions(fleetRoot, { existsSync, readdirSync, readFileSync });
if (extensions.length === 0) {
  console.error(
    `No pm extensions found under ${fleetRoot}. Run this from a checkout with the fleet `
      + "siblings beside it, or set PM_FLEET_ROOT. Refusing to write an empty snapshot, "
      + "because an empty one would make the completeness gate pass vacuously.",
  );
  process.exit(1);
}

const target = path.join(packageRoot, FLEET_SNAPSHOT_PATH);
writeFileSync(target, `${JSON.stringify(extensions, null, 2)}\n`, "utf8");
console.log(`Wrote ${extensions.length} fleet extensions to ${target}`);
