/** Interleave immutable baseline and candidate artifacts through the existing mixed-writer harness. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCapacity } from "./capacity.ts";

const baseline = process.argv[2];
const output = process.argv[3];
if (!baseline || !output) throw new Error("Expected baseline artifact directory and new output file");
const sourceFiles = ["dist/services/sse.js", "dist/services/sse-fanout.js", "dist/services/sse-access.js", "dist/routes/pm.js", "scripts/capacity-fanout-probe.ts", "scripts/capacity-probe.ts", "scripts/capacity-fixture.ts", "scripts/capacity-metrics.ts", "scripts/capacity.ts", "scripts/capacity-fanout.ts"];
const artifactHashes: Record<string, string> = {};
for (const file of sourceFiles) artifactHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
for (const file of ["sse.js", "pm.js"]) artifactHashes[`baseline/${file}`] = createHash("sha256").update(await readFile(path.join(baseline, file))).digest("hex");
const runs: { variant: string; repeat: number; report: Awaited<ReturnType<typeof runCapacity>> }[] = [];
const started = new Date().toISOString();
const startedClock = performance.now();
await writeFile(output, "", { flag: "wx" });
for (const rung of [100, 1000, 3000]) {
  for (const [index, variant] of ["before", "after", "before", "after"].entries()) {
    if (variant === "before") process.env.PM_WEB_CAPACITY_BASELINE_DIR = baseline;
    else delete process.env.PM_WEB_CAPACITY_BASELINE_DIR;
    const report = await runCapacity({ rungs: [rung], writers: 10, writesPerWriter: 5, sloMs: 1000, drainMs: 10_000 });
    for (const file of sourceFiles) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), artifactHashes[file], "Candidate artifact changed during comparison");
    for (const file of ["sse.js", "pm.js"]) assert.equal(createHash("sha256").update(await readFile(path.join(baseline, file))).digest("hex"), artifactHashes[`baseline/${file}`], "Baseline artifact changed during comparison");
    assert.ok(performance.now() - startedClock < 60 * 60_000, "Comparison must complete within one hour");
    runs.push({ variant, repeat: Math.floor(index / 2) + 1, report });
    await writeFile(output, JSON.stringify({ schema_version: 1, started, completed: new Date().toISOString(), elapsed_ms: performance.now() - startedClock, artifactHashes, runs }, null, 2) + "\n");
    const run = report.runs[0];
    process.stdout.write(JSON.stringify({ rung, variant, repeat: Math.floor(index / 2) + 1, failure: report.failure,
      ...(run ? { p99_ms: run.to_every_subscriber_ms.p99, lost: run.lost, duplicates: run.duplicates,
        fanout: run.resources.fanout, load: run.resources.host_load_average_before } : {}) }) + "\n");
    // A failed baseline setup is an observed limit, never a fabricated zero-delivery sample.
    if (variant === "before" && report.failure?.phase === "setup") continue;
    assert.equal(report.failure, null, "Each candidate rung and every measured baseline must finish completely");
    assert.equal(run.failed_writes, 0);
    assert.equal(run.committed_writes, 50);
    assert.equal(run.lost, 0);
    assert.equal(run.duplicates, 0);
    assert.equal(run.disconnected_subscribers, 0);
    assert.equal(run.resources.fanout.mutation_events, 50);
    assert.equal(run.resources.fanout.delivered_mutations, 50 * rung);
    assert.equal(run.to_every_subscriber_ms.samples, 50);
  }
}
