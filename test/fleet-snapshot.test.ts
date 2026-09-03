import assert from "node:assert/strict";
import test from "node:test";

import { readFleetExtensions, type FleetFs } from "../src/services/fleet-snapshot.ts";

/**
 * Build a {@link FleetFs} over an in-memory tree.
 *
 * The derivation is exercised against a synthetic fleet rather than the real
 * siblings so every rejection branch can be reached deliberately. Reading the
 * live fleet would only ever exercise the happy path, since every real package
 * is well formed — which is precisely how a malformed one would go unnoticed.
 */
function fakeFs(
  files: Record<string, string>,
  directories: string[],
  nonDirectories: string[] = [],
): FleetFs {
  return {
    existsSync: (p) => p === ROOT || p in files,
    readdirSync: () => [
      ...directories.map((name) => ({ name, isDirectory: () => true })),
      ...nonDirectories.map((name) => ({ name, isDirectory: () => false })),
    ],
    readFileSync: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
}

const ROOT = "/fleet";

test("an extension is a directory shipping a manifest that declares capabilities", () => {
  const found = readFleetExtensions(
    ROOT,
    fakeFs(
      {
        "/fleet/pm-thing/manifest.json": JSON.stringify({
          description: "does a thing",
          capabilities: ["schema", "commands"],
        }),
        "/fleet/pm-thing/package.json": JSON.stringify({
          description: "concise",
          publishConfig: { access: "public" },
        }),
      },
      ["pm-thing"],
    ),
  );
  assert.deepEqual(found, [
    {
      name: "pm-thing",
      description: "does a thing",
      packageDescription: "concise",
      // Sorted, so a manifest reordering its capabilities is not a snapshot change.
      capabilities: ["commands", "schema"],
      publishable: true,
    },
  ]);
});

test("a directory with no manifest, empty capabilities, or unreadable JSON is not an extension", () => {
  const files: Record<string, string> = {
    "/fleet/pm-empty/manifest.json": JSON.stringify({ capabilities: [] }),
    "/fleet/pm-broken/manifest.json": "{ not json",
    "/fleet/pm-nocaps/manifest.json": JSON.stringify({ description: "x" }),
  };
  const found = readFleetExtensions(
    ROOT,
    fakeFs(files, ["pm-empty", "pm-broken", "pm-nocaps", "pm-nomanifest"]),
  );
  assert.deepEqual(found, [], "none of these four shapes is an installable pm extension");
});

test("the host and the CLI are excluded, and so is any directory not named pm-*", () => {
  const manifest = JSON.stringify({ description: "d", capabilities: ["commands"] });
  const found = readFleetExtensions(
    ROOT,
    fakeFs(
      {
        "/fleet/pm-web/manifest.json": manifest,
        "/fleet/pm-cli/manifest.json": manifest,
        "/fleet/other/manifest.json": manifest,
      },
      ["pm-web", "pm-cli", "other"],
    ),
  );
  assert.deepEqual(
    found,
    [],
    "pm-web is the host and cannot install itself; pm-cli is the CLI, not an extension of it",
  );
});

test("a package without publishConfig is not publishable, and unreadable package.json is not either", () => {
  const manifest = JSON.stringify({ description: "d", capabilities: ["commands"] });
  const found = readFleetExtensions(
    ROOT,
    fakeFs(
      {
        "/fleet/pm-gated/manifest.json": manifest,
        "/fleet/pm-gated/package.json": JSON.stringify({ description: "g" }),
        "/fleet/pm-corrupt/manifest.json": manifest,
        "/fleet/pm-corrupt/package.json": "{ not json",
        "/fleet/pm-nopkg/manifest.json": manifest,
        // A package.json whose description is not a string. Valid JSON, so the
        // parse succeeds and the catch never runs - the guard on the type is
        // what keeps a number out of the snapshot, where it would serialise
        // and then fail a string comparison in the catalog gate with a
        // confusing message about a description mismatch.
        "/fleet/pm-numeric/manifest.json": manifest,
        "/fleet/pm-numeric/package.json": JSON.stringify({ description: 42 }),
      },
      ["pm-gated", "pm-corrupt", "pm-nopkg", "pm-numeric"],
    ),
  );
  assert.deepEqual(
    found.map((extension) => [extension.name, extension.publishable, extension.packageDescription]),
    [
      ["pm-corrupt", false, ""],
      ["pm-gated", false, "g"],
      ["pm-nopkg", false, ""],
      ["pm-numeric", false, ""],
    ],
    "publishable must default to false rather than throwing or defaulting to true",
  );
});

test("a plain file named like a package is not an extension", () => {
  // A stray `pm-notes.md` or a `pm-archive.tar` beside the packages must not be
  // walked into: the entry has to be a directory before anything else is asked
  // of it, or the manifest read below would be a read of a path that is not one.
  const found = readFleetExtensions(
    ROOT,
    fakeFs(
      { "/fleet/pm-file/manifest.json": JSON.stringify({ capabilities: ["commands"] }) },
      [],
      ["pm-file"],
    ),
  );
  assert.deepEqual(found, []);
});

test("a fleet root that does not exist yields no extensions rather than throwing", () => {
  // Callers must read an empty result as 'not resolvable here' rather than as
  // 'the fleet is empty' — which is why the generator refuses to write an empty
  // snapshot and the gate asserts the committed one is non-empty.
  assert.deepEqual(readFleetExtensions("/absent", fakeFs({}, [])), []);
});

test("a missing manifest description becomes an empty string rather than undefined", () => {
  const found = readFleetExtensions(
    ROOT,
    fakeFs(
      { "/fleet/pm-terse/manifest.json": JSON.stringify({ capabilities: ["commands"] }) },
      ["pm-terse"],
    ),
  );
  assert.equal(found[0]?.description, "", "an absent description must not serialise as undefined");
});
