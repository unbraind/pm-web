/** Exercise the real SDK fallback in a runtime with SQLite disabled, without SDK mocks. */
import assert from "node:assert/strict";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { createMutationReplayState, followCommittedMutations } from "../../src/services/mutation-replay.ts";

const pmRoot = process.argv[2];
const since = new Date(0).toISOString();
const page = await listMutationEvents({ pmRoot, type: "update", since });
assert.equal(page.source, "authoritative_history");
assert.equal(page.count, 1);
const controller = new AbortController();
const state = createMutationReplayState();
const stream = followCommittedMutations({ pmRoot, since, type: "update", intervalMs: 20, signal: controller.signal }, state);
const timer = setTimeout(() => controller.abort(), 3000);
try {
  assert.equal((await stream.next()).value?.item_id, "fallback-one");
  assert.equal(state.seen.size, 1);
} finally { clearTimeout(timer); controller.abort(); await stream.return(); }
console.log("authoritative fallback delivered the real CLI update");
