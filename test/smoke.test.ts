import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/index.js";

test("pm-web extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("pm-web extension registers commands", () => {
  const registered: string[] = [];
  const api = {
    registerCommand: (cmd: { name: string }) => { registered.push(cmd.name); },
    registerSchema: () => {},
  };
  extension.activate(api as any);
  assert.ok(registered.length > 0, `pm-web should register at least one command, got: ${JSON.stringify(registered)}`);
});
