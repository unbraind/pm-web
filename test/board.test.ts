import assert from "node:assert/strict";
import test from "node:test";

import { boardColumns, filterItemsByQuery } from "../dist/board.js";

const items = [
  { id: "pm-1", title: "Fix login", status: "open", tags: ["auth"], body: "token bug" },
  { id: "pm-2", title: "Write docs", status: "in_progress", tags: ["docs"] },
  { id: "pm-3", title: "Ship release", status: "closed", tags: [] },
  { id: "pm-4", title: "Triage", status: "needs_triage", tags: [] }, // unlisted status
  { id: "pm-5", title: "Review", status: "in-progress", tags: "review,ux", description: "copy polish" },
];

test("boardColumns groups items by the workspace statuses", () => {
  const cols = boardColumns(items, ["open", "in_progress", "closed"]);
  const byStatus = Object.fromEntries(cols.map((c) => [c.status, c.items.map((i) => i.id)]));
  assert.deepEqual(byStatus["open"], ["pm-1"]);
  assert.deepEqual(byStatus["in_progress"], ["pm-2", "pm-5"]);
  assert.deepEqual(byStatus["closed"], ["pm-3"]);
  // unlisted status falls into "(other)" — nothing dropped
  assert.deepEqual(byStatus["(other)"], ["pm-4"]);
});

test("boardColumns falls back to default statuses when none provided", () => {
  const cols = boardColumns(items, []);
  assert.ok(cols.some((c) => c.status === "open"));
  const total = cols.reduce((n, c) => n + c.items.length, 0);
  assert.equal(total, items.length);
});

test("filterItemsByQuery matches id, title, tags and body (case-insensitive)", () => {
  assert.deepEqual(filterItemsByQuery(items, "LOGIN").map((i) => i.id), ["pm-1"]);
  assert.deepEqual(filterItemsByQuery(items, "auth").map((i) => i.id), ["pm-1"]);   // tag
  assert.deepEqual(filterItemsByQuery(items, "ux").map((i) => i.id), ["pm-5"]);     // comma string tag
  assert.deepEqual(filterItemsByQuery(items, "token").map((i) => i.id), ["pm-1"]);  // body
  assert.deepEqual(filterItemsByQuery(items, "polish").map((i) => i.id), ["pm-5"]); // description
  assert.deepEqual(filterItemsByQuery(items, "pm-3").map((i) => i.id), ["pm-3"]);   // id
  assert.equal(filterItemsByQuery(items, "").length, items.length);                // empty → all
});
