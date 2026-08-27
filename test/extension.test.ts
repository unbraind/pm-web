import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateExtensionForTest,
  assertRegisteredCommandContract,
} from "@unbrained/pm-cli/sdk/testing";

import extensionDefault, { resolvePort, pidfilePath, shapeStatusResult, nodeVersionMeetsRequirement } from "../src/index.ts";

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

test("nodeVersionMeetsRequirement enforces the package engine floor", () => {
  assert.strictEqual(nodeVersionMeetsRequirement("20.19.0"), false);
  assert.strictEqual(nodeVersionMeetsRequirement("22.17.9"), false);
  assert.strictEqual(nodeVersionMeetsRequirement("22.18.0"), true);
  assert.strictEqual(nodeVersionMeetsRequirement("22.19.0"), true);
  assert.strictEqual(nodeVersionMeetsRequirement("23.0.0"), true);
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
  const extension = extensionDefault;
  const activation = await activateExtensionForTest(extension, {
    name: "pm-web",
    capabilities: ["commands", "schema"],
  });
  assert.deepEqual(activation.failed, []);
  assert.equal(activation.command_handler_count, 4);
  assertRegisteredCommandContract(activation.registrations, {
    command: "web",
    flags: ["--port", "--detach"],
  });
  assertRegisteredCommandContract(activation.registrations, {
    command: "web status",
    flags: ["--port"],
  });
  assertRegisteredCommandContract(activation.registrations, {
    command: "web stop",
    flags: ["--port"],
  });
  assertRegisteredCommandContract(activation.registrations, {
    command: "web doctor",
    flags: ["--port"],
  });
});

test("a server answering 503 is reachable but unhealthy, not down", () => {
  // Conflating the two sends an operator to look for a process that is running.
  // The distinction is the whole reason /healthz reports dependency state.
  const degraded = shapeStatusResult({
    port: "4000",
    reachable: true,
    healthy: false,
    body: { ok: false, version: "2026.8.27", dependencies: { postgres: { ok: false } } },
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.reachable, true, "the server answered, so it is reachable");
  assert.equal(degraded.healthy, false);
  assert.equal(degraded.version, "2026.8.27", "a degraded server still reports its version");

  const down = shapeStatusResult({ port: "4000", reachable: false, healthy: false, error: "ECONNREFUSED" });
  assert.equal(down.status, "down");
  assert.equal(down.reachable, false);

  // A caller that does not pass `healthy` keeps the previous meaning.
  assert.equal(shapeStatusResult({ port: "4000", reachable: true, body: { ok: true } }).status, "up");
});
