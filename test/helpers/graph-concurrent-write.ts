/** Isolated SDK boundary seam; all reads and item writes delegate to the real SDK. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { mock } from "node:test";
import * as sdk from "@unbrained/pm-cli/sdk";

const [owner, slug, mode] = process.argv.slice(2);
let write: Promise<{ ok: boolean; stderr: string }> | undefined;
let writeEntered = false;
let enteredDuringOrderRead = false;
let certifiedIds: string[] = [];
let seamUsed = false;

const originalRun = sdk.PmClient.prototype.run;
mock.method(sdk.PmClient.prototype, "run", function (this: sdk.PmClient, ...args: Parameters<typeof originalRun>) {
  if (args[0] === "create") writeEntered = true;
  return originalRun.apply(this, args);
});

mock.module("@unbrained/pm-cli/sdk", {
  namedExports: {
    ...sdk,
    listAllComplete: async (...args: Parameters<typeof sdk.listAllComplete>) => {
      const result = await sdk.listAllComplete(...args);
      if (!seamUsed) {
        seamUsed = true;
        certifiedIds = result.items.map((item) => item.id);
        if (mode === "external") {
          // This writer bypasses the process queue; the ID-set guard must still reject it.
          execFileSync(path.resolve("node_modules/.bin/pm"), ["create", "--type", "Task", "--title", "External seam write"], {
            cwd: runner.getProjectDir(owner, slug),
            env: { ...process.env, PM_PATH: path.join(runner.getProjectDir(owner, slug), ".agents", "pm") },
            stdio: "ignore",
          });
        } else {
          write = runner.runPm({ userId: owner, slug,
            args: ["create", "--type", "Task", "--title", "Concurrent seam write"], jsonOutput: true });
        }
      }
      return result;
    },
    listAllItemMetadata: async (...args: Parameters<typeof sdk.listAllItemMetadata>) => {
      // Drain queued promise continuations. With the old lock boundary the real
      // writer enters here; await its commit to deterministically expose the mismatch.
      await setImmediate();
      enteredDuringOrderRead = writeEntered;
      if (writeEntered) assert.equal((await write!).ok, true);
      return sdk.listAllItemMetadata(...args);
    },
  },
});

/* eslint-disable no-restricted-syntax -- Built services must load after the isolated SDK module mock is installed. */
const runner = await import("../../dist/services/pm-runner.js");
const { readProjectGraph } = await import("../../dist/services/project-graph.js");
const { pool } = await import("../../dist/db.js");
/* eslint-enable no-restricted-syntax */
try {
  if (mode === "external") {
    await assert.rejects(readProjectGraph(owner, slug), /Graph source changed during the certified read/);
  } else {
    const snapshot = await readProjectGraph(owner, slug);
    assert.equal(seamUsed, true, "the certified-read boundary must be exercised");
    assert.equal(enteredDuringOrderRead, false, "the queued writer must wait through the order read");
    assert.deepEqual(snapshot.graph.nodes.filter((node) => node.labels.includes("PmItem")).map((node) => node.id).sort(), certifiedIds.sort());
    assert.ok(write, "a real concurrent create must be submitted at the seam");
    const written = await write;
    assert.equal(written.ok, true, written.stderr);
    assert.equal(writeEntered, true, "the real writer must eventually execute");
    mock.restoreAll();
    const next = await readProjectGraph(owner, slug);
    assert.equal(next.graph.nodes.filter((node) => node.labels.includes("PmItem")).length, certifiedIds.length + 1);
    assert.ok(next.graph.nodes.some((node) => node.properties.title === "Concurrent seam write"));
  }
} finally {
  mock.restoreAll();
  await pool.end();
}
