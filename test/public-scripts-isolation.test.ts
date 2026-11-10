/** Adversarial proof that generated artifacts belong to their individual test suite. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildStaticScripts, publicDir } from "./helpers/public-scripts.ts";

test("every generated script survives truncation and cleanup of a peer build without changing served files", (t) => {
  const names = ["cookie-consent.js", "sw.js"] as const;
  const served = names.map((name) => {
    const file = path.join(publicDir, name);
    return existsSync(file) ? readFileSync(file) : null;
  });
  const first = buildStaticScripts();
  t.after(first.cleanup);
  const second = buildStaticScripts();
  t.after(second.cleanup);
  const firstPaths = [first.cookieConsentOutputPath, first.swOutputPath];
  const secondPaths = [second.cookieConsentOutputPath, second.swOutputPath];
  for (const [index, file] of firstPaths.entries()) {
    const peer = secondPaths[index];
    assert.notEqual(file, peer, "suites must never share a generated path");
    const expected = readFileSync(peer, "utf8");
    assert.ok(expected.length > 0);
    new Function(expected);
    writeFileSync(file, ""); // Model a compiler truncating a file before emission.
    assert.equal(readFileSync(peer, "utf8"), expected);
  }
  first.cleanup();
  for (const file of secondPaths) assert.ok(readFileSync(file).length > 0, "peer cleanup must not remove this suite's outputs");
  for (const [index, name] of names.entries()) {
    const file = path.join(publicDir, name);
    assert.deepEqual(existsSync(file) ? readFileSync(file) : null, served[index], "tests must not emit into the served tree");
  }
});
