import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePort, pidfilePath, shapeStatusResult } from "../dist/index.js";

test("resolvePort prefers the --port flag", () => {
  assert.strictEqual(resolvePort({ port: "8080" }, { PORT: "4000" }), "8080");
});

test("resolvePort falls back to PORT env", () => {
  assert.strictEqual(resolvePort({}, { PORT: "5555" }), "5555");
});

test("resolvePort defaults to 4000", () => {
  assert.strictEqual(resolvePort({}, {}), "4000");
});

test("resolvePort ignores empty flag and empty env", () => {
  assert.strictEqual(resolvePort({ port: "" }, { PORT: "" }), "4000");
});

test("pidfilePath keys by port in the temp dir by default", () => {
  const p = pidfilePath(4555, {}, "/tmp");
  assert.strictEqual(p, path.join("/tmp", "pm-web-4555.pid"));
});

test("pidfilePath honors PM_WEB_STATE_DIR", () => {
  const p = pidfilePath("4000", { PM_WEB_STATE_DIR: "/var/state" }, os.tmpdir());
  assert.strictEqual(p, path.join("/var/state", "pm-web-4000.pid"));
});

test("shapeStatusResult marks a reachable server as up", () => {
  const r = shapeStatusResult({ port: "4000", reachable: true, body: { ok: true, version: "2026.6.2" } });
  assert.strictEqual(r.status, "up");
  assert.strictEqual(r.reachable, true);
  assert.strictEqual(r.port, 4000);
  assert.strictEqual(r.version, "2026.6.2");
  assert.strictEqual(r.url, "http://localhost:4000/healthz");
});

test("shapeStatusResult marks an unreachable server as down without throwing", () => {
  const r = shapeStatusResult({ port: 8080, reachable: false, error: "ECONNREFUSED" });
  assert.strictEqual(r.status, "down");
  assert.strictEqual(r.reachable, false);
  assert.strictEqual(r.version, null);
  assert.strictEqual(r.healthz, null);
  assert.strictEqual(r.error, "ECONNREFUSED");
});

test("shapeStatusResult tolerates a body without a version field", () => {
  const r = shapeStatusResult({ port: "4000", reachable: true, body: { ok: true } });
  assert.strictEqual(r.status, "up");
  assert.strictEqual(r.version, null);
});

test("extension registers web, status, stop and doctor commands", async () => {
  const { default: extension } = await import("../dist/index.js");
  const registered: string[] = [];
  const api = {
    registerCommand: (cmd: { name: string }) => { registered.push(cmd.name); },
    registerSchema: () => {},
  };
  extension.activate(api as any);
  for (const name of ["web", "web status", "web stop", "web doctor"]) {
    assert.ok(registered.includes(name), `expected command ${name}, got ${JSON.stringify(registered)}`);
  }
});
