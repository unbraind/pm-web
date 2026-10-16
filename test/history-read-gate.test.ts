/** Real tracker reads and exact metadata exercise idle admission and page sharing. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, utimes, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryReadGate, HISTORY_READ_SAFETY_MS, historyFingerprint, singleFlightMutationPage } from "../src/services/history-read-gate.ts";
import { capacityPm } from "../scripts/capacity-fixture.ts";

test("idle reads skip until change, signal or bounded full check, preserving invalidations during a read", () => {
  const gate = new HistoryReadGate();
  const first = gate.begin("same", 0)!;
  assert.ok(first);
  first.complete(100_000);
  assert.equal(gate.completedScanAt, 100_000);
  assert.equal(gate.begin("same", 1), null);
  assert.equal(gate.begin("same", HISTORY_READ_SAFETY_MS - 1), null);
  gate.begin("changed", 2)!.complete(100_002);
  gate.invalidate();
  const signaled = gate.begin("changed", 3)!;
  assert.ok(signaled);
  gate.invalidate();
  signaled.complete(100_003);
  gate.begin("changed", 4)!.complete(100_004);
  assert.equal(gate.begin("changed", 5), null);
  // Exact metadata collisions still cause a full SDK check before aging the replay window.
  assert.ok(gate.begin("changed", HISTORY_READ_SAFETY_MS + 4));
  // An incomplete/failed scan never updates the certified fingerprint or scan time.
  assert.equal(gate.completedScanAt, 100_004);
  assert.ok(gate.begin("changed", HISTORY_READ_SAFETY_MS + 5));
});

test("history metadata detects equal-size same-mtime writes, replacements, authoritative streams and index WAL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-history-stamp-"));
  try {
    const empty = await historyFingerprint(root);
    await mkdir(path.join(root, "history"));
    const file = path.join(root, "history", "synthetic.jsonl");
    await writeFile(file, "aaa");
    const tick = new Date(1_700_000_000_000);
    await utimes(file, tick, tick);
    const before = await stat(file, { bigint: true });
    const initial = await historyFingerprint(root);
    assert.notEqual(initial, empty);
    await writeFile(file, "bbb");
    await utimes(file, tick, tick);
    const sameTick = await stat(file, { bigint: true });
    assert.equal(sameTick.size, before.size);
    assert.equal(sameTick.mtimeNs, before.mtimeNs, "both writes have exactly the same nanosecond mtime token");
    assert.notEqual(await historyFingerprint(root), initial, "ctimeNs covers a same-size write with restored mtime");
    const replaced = await historyFingerprint(root);
    await writeFile(file + ".replacement", "ccc");
    await utimes(file + ".replacement", tick, tick);
    await rename(file + ".replacement", file);
    assert.notEqual((await stat(file, { bigint: true })).ino, before.ino);
    assert.notEqual(await historyFingerprint(root), replaced, "inode identifies same-size same-mtime replacements");
    await mkdir(path.join(root, "runtime"));
    const withoutIndex = await historyFingerprint(root);
    const index = path.join(root, "runtime", "history-event-index.sqlite");
    await writeFile(index, "index");
    const withIndex = await historyFingerprint(root);
    assert.notEqual(withIndex, withoutIndex);
    await writeFile(index + "-wal", "wal");
    const withWal = await historyFingerprint(root);
    assert.notEqual(withWal, withIndex);
    await rm(file);
    assert.notEqual(await historyFingerprint(root), withWal);
    await rm(path.join(root, "history"), { recursive: true });
    await writeFile(path.join(root, "history"), "not a directory");
    await assert.rejects(historyFingerprint(root), { code: "ENOTDIR" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent identical real SDK queries share one page without caching later reads or conflating filters", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-history-flight-"));
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "flight", "--defaults", "--agent-guidance", "skip"]);
    await capacityPm(dir, ["create", "Task", "Synthetic flight", "--id", "flight-one", "--description", "Synthetic"]);
    const options = { pmRoot: path.join(dir, ".agents/pm"), item: "flight-one", type: "create" };
    const pair = await Promise.all([singleFlightMutationPage(options), singleFlightMutationPage(options)]);
    assert.equal(pair[0], pair[1], "even two concurrent readers share the SDK result");
    const pages = await Promise.all(Array.from({ length: 100 }, () => singleFlightMutationPage(options)));
    assert.equal(pages[0].count, 1);
    for (const page of pages) assert.equal(page, pages[0], "one SDK result is shared by all concurrent readers");
    assert.notEqual(await singleFlightMutationPage(options), pages[0], "settled results are never cached");
    const filtered = await Promise.all([singleFlightMutationPage(options), singleFlightMutationPage({ ...options, type: "update" })]);
    assert.equal(filtered[0].count, 1);
    assert.equal(filtered[1].count, 0);
    const other = path.join(dir, "other");
    await mkdir(other);
    await capacityPm(other, ["workspace", "init", "--workspace", other, "--prefix", "other", "--defaults", "--agent-guidance", "skip"]);
    const isolated = await Promise.all([dir, other].map((cwd) => singleFlightMutationPage({ ...options, cwd, pmRoot: ".agents/pm" })));
    assert.equal(isolated[0].count, 1);
    assert.equal(isolated[1].count, 0, "relative roots in distinct working directories cannot share a result");
    await assert.rejects(singleFlightMutationPage({ ...options, limit: -1 }));
    await assert.rejects(singleFlightMutationPage({ ...options, limit: -1 }), "failed flights are released");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
