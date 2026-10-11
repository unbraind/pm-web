import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { renderPackageCard, renderPackagesView } from "../public/src/views/packages.ts";
import { state } from "../public/src/state.js";
import { findCatalogEntry, type PackageCatalogEntry } from "../src/services/package-catalog.ts";
import { FLEET_SNAPSHOT_PATH, type FleetExtension } from "../src/services/fleet-snapshot.ts";

const snapshot: FleetExtension[] = JSON.parse(readFileSync(FLEET_SNAPSHOT_PATH, "utf8"));

/** Serialize a real catalog entry as an uninstalled extensions-response row. */
function card(entry: PackageCatalogEntry): string {
  return renderPackageCard(JSON.parse(JSON.stringify({
    ...entry, installed: false, version: null, active: false, enabled: false,
    runtimeActive: false, activationStatus: null, managed: false, sourceKind: null,
  })));
}

test("real Jev catalog card omits its unpublished npm link and retains supported links", () => {
  const entry = findCatalogEntry("pm-jev");
  assert.ok(entry);
  assert.equal(snapshot.find((pkg) => pkg.name === entry.name)?.npmPublished, false);
  assert.equal(entry.availability, "unreleased");
  const html = card(entry);
  assert.doesNotMatch(html, /npmjs\.com|href="undefined"|data-pkg-action="install"/);
  assert.equal(entry.links?.npm, undefined, "an unpublished package must not advertise an npm link");
  for (const label of ["docs", "repository", "report"] as const) {
    assert.ok(entry.links?.[label]);
    assert.ok(html.includes(`href="${entry.links[label]}"`), `${label} link must remain visible`);
  }
});

test("real published Graph metadata retains its npm link and install action in the card", () => {
  const entry = findCatalogEntry("pm-graph");
  assert.ok(entry);
  assert.equal(snapshot.find((pkg) => pkg.name === entry.name)?.npmPublished, true);
  // The installed published package supplies its actual catalog links; the
  // host's Graph entry currently omits the optional links object altogether.
  const require = createRequire(import.meta.url);
  const metadata = JSON.parse(readFileSync(require.resolve("pm-graph/package.json"), "utf8"));
  assert.equal(metadata.name, entry.name);
  const links: NonNullable<PackageCatalogEntry["links"]> = metadata.pm.catalog.links;
  assert.equal(links.npm, "https://www.npmjs.com/package/pm-graph");
  const html = card({ ...entry, links });
  assert.ok(html.includes(`href="${links.npm}"`), "published npm link must remain visible");
  assert.match(html, /data-pkg-action="install"/);
  for (const label of ["docs", "repository", "report"] as const) {
    assert.ok(html.includes(`href="${links[label]}"`), `${label} link must remain visible`);
  }
});

test("all public fleet cards expose verified command and documentation metadata", () => {
  for (const pkg of snapshot) {
    const entry = findCatalogEntry(pkg.name);
    assert.ok(entry);
    const html = card(entry);
    assert.ok(entry.commands.length > 0);
    for (const command of entry.commands) assert.ok(html.includes(command));
    assert.equal(Boolean(entry.links?.npm), pkg.npmPublished);
    for (const label of ["docs", "repository", "report"] as const) assert.ok(entry.links?.[label]);
  }
});

test("native Rust card explains its boundary without an install or enable control", () => {
  const entry = findCatalogEntry("pm-rust");
  assert.ok(entry);
  assert.equal(entry.npmName, null);
  assert.equal(entry.npmSpec, null);
  assert.deepEqual(entry.capabilities, []);
  const html = card(entry);
  assert.match(html, /native CLI, not an npm extension/);
  assert.doesNotMatch(html, /npmjs\.com|data-pkg-action|Run package command/);
});

test("enabled package card exposes labelled keyboard controls and command feedback", () => {
  const entry = findCatalogEntry("pm-presets");
  assert.ok(entry);
  const html = renderPackageCard({ ...entry, commands: [...entry.commands], capabilities: [...entry.capabilities], installed: true, active: true, enabled: true, runtimeActive: true,
    version: "synthetic", activationStatus: "active", managed: true, sourceKind: "npm" });
  assert.match(html, /<label>.*<select/);
  assert.match(html, /<label>.*<input/);
  assert.match(html, /data-pkg-action="run"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /placeholder='\["--help"\]' value='\[\]'/);
});

test("failed package commands retain stdout and error in the card and restore Run", async (t) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document;
  const originalFetch = globalThis.fetch;
  const originalProject = state.currentProject;
  t.after(() => {
    globals.document = originalDocument;
    globalThis.fetch = originalFetch;
    state.currentProject = originalProject;
  });
  let click: ((event: { target: unknown }) => void) | undefined;
  const output = { textContent: "" };
  const container = {
    innerHTML: "",
    /** Capture the actual delegated package-action listener. */
    addEventListener: (_name: string, listener: typeof click) => { click = listener; },
  };
  globals.document = {
    cookie: "csrf_token=command-token",
    getElementById: (id: string) => id === "content-packages" ? container : null,
    createElement: () => ({ remove: () => {} }),
  };
  state.currentProject = { id: "synthetic-project", name: "Synthetic" } as NonNullable<typeof state.currentProject>;
  const cardElement = {
    querySelector: (selector: string) => selector === "[data-pkg-command]" ? { value: "pm presets list" }
      : selector === "[data-pkg-args]" ? { value: "[]" } : output,
  };
  const button = { dataset: { pkgAction: "run", pkgName: "pm-presets" }, disabled: false,
    textContent: "Run", closest: () => cardElement };
  await renderPackagesView();
  assert.ok(click);
  for (const error of ["", "command stderr"]) {
    const payload = { ok: false, output: "command stdout explains failure", error };
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-csrf-token"), "command-token");
      assert.deepEqual(JSON.parse(String(init?.body)), { command: "pm presets list", args: [] });
      return new Response(JSON.stringify(payload), { status: 400 });
    };
    click({ target: { closest: () => button } });
    // The delegated listener launches async work; drain it before asserting the rendered result.
    for (let attempt = 0; button.disabled && attempt < 20; attempt++) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    assert.equal(output.textContent, JSON.stringify(payload, null, 2));
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Run");
  }
});
