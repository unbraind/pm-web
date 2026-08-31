import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  certifyPmWebCompleteList,
  evictPmClient,
  EXIT_CODE,
  getPmClient,
  PmWebCompleteListReceiptError,
  readCompletePmItems,
  runPm,
  Semaphore,
  type PmWebCompleteListReceiptFinding,
} from "../src/services/pm-runner.ts";

test("semaphore hands a released slot directly to the oldest waiter", async () => {
  const semaphore = new Semaphore(1);
  const releaseFirst = await semaphore.acquire();
  let secondAcquired = false;
  let thirdAcquired = false;
  let releaseSecond: (() => void) | undefined;

  const second = semaphore.acquire().then((release) => {
    secondAcquired = true;
    releaseSecond = release;
  });
  releaseFirst();
  const third = semaphore.acquire().then((release) => {
    thirdAcquired = true;
    return release;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondAcquired, true);
  assert.equal(thirdAcquired, false, "a new acquire must not steal a slot handed to a waiter");

  releaseSecond!();
  await second;
  const releaseThird = await third;
  assert.equal(thirdAcquired, true);
  releaseThird();
});

test("spawn fallback stays non-blocking, serializes a workspace, and overlaps independent workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-runner-"));
  const fakePm = path.join(root, "fake-pm");
  const logPath = path.join(root, "commands.log");
  const previousRoot = process.env["PROJECTS_ROOT"];
  const previousBin = process.env["PM_CLI_BIN"];

  await writeFile(fakePm, `#!/usr/bin/env node
const fs = require("node:fs");
const delay = Number(process.argv[3]);
const label = process.argv[4];
const log = process.env.FAKE_PM_LOG;
fs.appendFileSync(log, "start " + label + "\\n");
setTimeout(() => {
  fs.appendFileSync(log, "end " + label + "\\n");
  process.stdout.write(label);
}, delay);
`);
  await chmod(fakePm, 0o755);
  process.env["PROJECTS_ROOT"] = root;
  process.env["PM_CLI_BIN"] = fakePm;
  process.env["FAKE_PM_LOG"] = logPath;

  try {
    await Promise.all([
      mkdir(path.join(root, "user", "same"), { recursive: true }),
      mkdir(path.join(root, "user", "other"), { recursive: true }),
    ]);

    let eventLoopTicks = 0;
    const ticker = setInterval(() => { eventLoopTicks += 1; }, 10);
    const [first, second, independent] = await Promise.all([
      runPm({ userId: "user", slug: "same", args: ["calendar", "120", "first"] }),
      runPm({ userId: "user", slug: "same", args: ["calendar", "120", "second"] }),
      runPm({ userId: "user", slug: "other", args: ["calendar", "120", "independent"] }),
    ]);
    clearInterval(ticker);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(independent.ok, true);
    assert.ok(eventLoopTicks >= 8, `expected the event loop to remain responsive, observed ${eventLoopTicks} ticks`);

    const entries = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.ok(entries.indexOf("end first") < entries.indexOf("start second"), entries.join(", "));
    assert.ok(entries.indexOf("start independent") < entries.indexOf("end first"), entries.join(", "));

    const timedOut = await runPm({
      userId: "user",
      slug: "other",
      args: ["calendar", "500", "timeout"],
      timeoutMs: 30,
    });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.stderr, /timed out after 30ms/);
  } finally {
    if (previousRoot === undefined) delete process.env["PROJECTS_ROOT"];
    else process.env["PROJECTS_ROOT"] = previousRoot;
    if (previousBin === undefined) delete process.env["PM_CLI_BIN"];
    else process.env["PM_CLI_BIN"] = previousBin;
    delete process.env["FAKE_PM_LOG"];
    await rm(root, { recursive: true, force: true });
  }
});

// The per-workspace serialization guarantee, exercised through the IN-PROCESS
// path specifically.
//
// The sibling spawn-fallback test proves the guarantee only for actions that
// shell out: it drives a fake `pm` via PM_CLI_BIN and uses `calendar`, a
// spawn-fallback action, so it never reaches the SDK dispatch this fix changed.
// `runPmInProcess` used to be invoked OUTSIDE `runSerialized`, so an in-process
// action ignored the workspace queue entirely.
//
// Note on what does NOT work as a test here: asserting that N concurrent
// same-workspace creates all survive passes either way, because the SDK keeps
// its own process-wide queue that already prevents lost writes. Durability
// therefore cannot discriminate — only *mutual exclusion* can.
//
// Both paths share one queue per workspace (`workspaceTails`), so the
// discriminator is an interleave: a slow SPAWN action submitted first must hold
// the workspace, and an in-process action submitted second must not complete
// until the spawn has finished. If the in-process path bypasses the queue it
// returns almost immediately, inverting the order — a difference of the full
// spawn delay, not a timing tolerance.
test("in-process dispatch waits behind the same workspace queue as the spawn path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-sdk-concurrency-"));
  const fakePm = path.join(root, "fake-pm");
  const previousRoot = process.env["PROJECTS_ROOT"];
  const previousBin = process.env["PM_CLI_BIN"];
  process.env["PROJECTS_ROOT"] = root;

  const SPAWN_DELAY_MS = 400;

  try {
    await Promise.all([
      mkdir(path.join(root, "user", "busy"), { recursive: true }),
      mkdir(path.join(root, "user", "idle"), { recursive: true }),
    ]);
    // Initialize with the REAL pm before PM_CLI_BIN is redirected, so the
    // in-process SDK has a genuine workspace to write into.
    for (const slug of ["busy", "idle"]) {
      const init = await runPm({ userId: "user", slug, args: ["init", "web"], jsonOutput: true });
      assert.equal(init.ok, true, init.stderr);
    }

    await writeFile(fakePm, `#!/usr/bin/env node
setTimeout(() => process.stdout.write("done"), ${SPAWN_DELAY_MS});
`);
    await chmod(fakePm, 0o755);
    process.env["PM_CLI_BIN"] = fakePm;

    const order: string[] = [];
    const createIn = (slug: string, title: string) =>
      runPm({
        userId: "user",
        slug,
        args: ["create", "--type", "Task", "--title", title, "--status", "open"],
        jsonOutput: true,
      });

    // `calendar` is a spawn-fallback action, so this one shells out to the slow
    // fake binary and holds the `busy` workspace for SPAWN_DELAY_MS.
    const slowSpawn = runPm({ userId: "user", slug: "busy", args: ["calendar", "1", "slow"] })
      .then((r) => { order.push("spawn:busy"); return r; });
    const queuedInProcess = createIn("busy", "queued behind the spawn")
      .then((r) => { order.push("in-process:busy"); return r; });
    // A different workspace must NOT be blocked by the busy one.
    const independent = createIn("idle", "independent workspace")
      .then((r) => { order.push("in-process:idle"); return r; });

    const [spawnResult, queuedResult, independentResult] = await Promise.all([
      slowSpawn,
      queuedInProcess,
      independent,
    ]);

    assert.equal(spawnResult.ok, true, spawnResult.stderr);
    assert.equal(queuedResult.ok, true, queuedResult.stderr);
    assert.equal(independentResult.ok, true, independentResult.stderr);

    assert.ok(
      order.indexOf("spawn:busy") < order.indexOf("in-process:busy"),
      `an in-process action must wait behind the spawn holding its workspace, observed ${order.join(" -> ")}`,
    );
    assert.ok(
      order.indexOf("in-process:idle") < order.indexOf("spawn:busy"),
      `an independent workspace must not be blocked, observed ${order.join(" -> ")}`,
    );
  } finally {
    if (previousRoot === undefined) delete process.env["PROJECTS_ROOT"];
    else process.env["PROJECTS_ROOT"] = previousRoot;
    if (previousBin === undefined) delete process.env["PM_CLI_BIN"];
    else process.env["PM_CLI_BIN"] = previousBin;
    await rm(root, { recursive: true, force: true });
  }
});

test("in-process SDK dispatch preserves positionals, camel-case flags, pagination, and expected errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-sdk-runner-"));
  const previousRoot = process.env["PROJECTS_ROOT"];
  process.env["PROJECTS_ROOT"] = root;
  const projectDir = path.join(root, "user", "sdk");
  const pmRoot = path.join(projectDir, ".agents", "pm");

  try {
    await mkdir(projectDir, { recursive: true });

    const initialized = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["init", "web"],
      jsonOutput: true,
    });
    assert.equal(initialized.ok, true, initialized.stderr);
    assert.equal(getPmClient(pmRoot), getPmClient(pmRoot), "workspace clients should be reused");

    const first = await runPm({
      userId: "user",
      slug: "sdk",
      args: [
        "create",
        "--type",
        "Task",
        "--title",
        "First SDK item",
        "--description",
        "created in process",
        "--status",
        "open",
        "--priority",
        "2",
        "--body",
        "body one",
      ],
      jsonOutput: true,
    });
    assert.equal(first.ok, true, first.stderr);
    // `pm create --json` and the in-process SDK dispatcher both return the
    // flat CLI envelope { id, status, changed_field_count } — no `item` wrapper.
    const firstId = (first.parsed as { id?: unknown }).id;
    assert.equal(typeof firstId, "string");

    const leadingFlagValue = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["update", String(firstId), "--description", "--not-a-flag"],
      jsonOutput: true,
    });
    assert.equal(leadingFlagValue.ok, true, leadingFlagValue.stderr);
    // The `pm update` JSON envelope is the flat { id, status,
    // changed_field_count } contract — it does not echo the full item — so verify
    // the description landed by reading the item back. `pm get --json` returns
    // { item: { ... } }, the wrapper shape that read commands keep.
    const afterUpdate = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["get", String(firstId)],
      jsonOutput: true,
    });
    assert.equal(afterUpdate.ok, true, afterUpdate.stderr);
    assert.equal(
      (afterUpdate.parsed as { item?: { description?: string } }).item?.description,
      "--not-a-flag",
    );

    const negatedBooleanBeforePositional = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["get", "--no-extensions", String(firstId)],
      jsonOutput: true,
    });
    assert.equal(negatedBooleanBeforePositional.ok, true, negatedBooleanBeforePositional.stderr);

    const second = await runPm({
      userId: "user",
      slug: "sdk",
      args: [
        "create",
        "--type",
        "Task",
        "--title",
        "Second SDK item",
        "--description",
        "created in process",
        "--status",
        "open",
        "--priority",
        "2",
      ],
      jsonOutput: true,
    });
    assert.equal(second.ok, true, second.stderr);

    const complete = await readCompletePmItems("user", "sdk", true);
    if (!complete.ok) assert.fail(complete.stderr);
    assert.equal(complete.result.items.length, 2);
    assert.equal(complete.result.complete_list.item_count, 2);
    assert.ok(complete.result.items.every((item) => typeof item.body === "string"));

    // The SDK certificate owns these invariants as of pm CLI 2026.8.31
    // (unbraind/pm-cli#1078). Asserting the SDK — not pm-web — rejects them keeps
    // pm-web from re-adding guards whose branches the SDK makes unreachable, and
    // turns an upstream regression into a failure here rather than a silent gap.
    const sdkOwnedFailures: ReadonlyArray<(candidate: Record<string, unknown>) => void> = [
      (c) => { (c["completeness"] as Record<string, unknown>)["unreadable_item_count"] = 1; },
      (c) => { (c["completeness"] as Record<string, unknown>)["unreadable_directory_count"] = 1; },
      (c) => { (c["completeness"] as Record<string, unknown>)["unreadable_item_count"] = 1.5; },
      (c) => { delete c["omission_receipt"]; },
      (c) => { (c["omission_receipt"] as Record<string, unknown>)["has_omissions"] = true; },
      (c) => { delete c["read_output"]; },
      (c) => { (c["read_output"] as Record<string, unknown>)["contract_version"] = 2; },
      (c) => { (c["read_output"] as Record<string, unknown>)["within_budget"] = false; },
      (c) => { (c["read_output"] as Record<string, unknown>)["requested_dimensions"] = ["include"]; },
      (c) => { c["output_budget_truncation"] = {}; },
    ];
    for (const mutate of sdkOwnedFailures) {
      const candidate = structuredClone(complete.result) as unknown as Record<string, unknown>;
      mutate(candidate);
      assert.throws(
        () => certifyPmWebCompleteList(candidate),
        (error: unknown) =>
          error instanceof Error && !(error instanceof PmWebCompleteListReceiptError),
        "the SDK certificate must reject this shape before pm-web's supplemental checks",
      );
    }

    // The one shape the SDK still accepts: an `output_budget_exceeded` disclosure
    // means the rows may be short of the whole corpus, so pm-web refuses it.
    const budgetFinding: PmWebCompleteListReceiptFinding = "budget_disclosure_present";
    const exceeded = structuredClone(complete.result) as unknown as Record<string, unknown>;
    exceeded["output_budget_exceeded"] = {};
    assert.throws(
      () => certifyPmWebCompleteList(exceeded),
      (error: unknown) =>
        error instanceof PmWebCompleteListReceiptError && error.findings.includes(budgetFinding),
      "supplemental certification must reject budget_disclosure_present",
    );

    const comment = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["comments", String(firstId), "positionally preserved"],
      jsonOutput: true,
    });
    assert.equal(comment.ok, true, comment.stderr);

    const comments = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["comments", String(firstId)],
      jsonOutput: true,
    });
    assert.equal(comments.ok, true, comments.stderr);
    assert.equal(
      (comments.parsed as { comments?: Array<{ text?: string }> }).comments?.[0]?.text,
      "positionally preserved",
    );

    const linkedTest = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["test", String(firstId), "npm test"],
      jsonOutput: true,
    });
    assert.equal(linkedTest.ok, true, linkedTest.stderr);
    assert.equal(
      (linkedTest.parsed as { tests?: Array<{ command?: string }> }).tests?.[0]?.command,
      "npm test",
    );

    const firstPage = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["list", "--all", "--limit", "1", "--include-body"],
      jsonOutput: true,
    });
    assert.equal(firstPage.ok, true, firstPage.stderr);
    const firstPageResult = firstPage.parsed as {
      items?: Array<{ body?: string }>;
      next_cursor?: string | null;
      has_more?: boolean;
    };
    assert.equal(firstPageResult.items?.length, 1);
    assert.equal(firstPageResult.has_more, true);
    assert.equal(typeof firstPageResult.next_cursor, "string");
    assert.equal(typeof firstPageResult.items?.[0]?.body, "string");

    const nextPage = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["list", "--all", "--limit", "1", "--after", String(firstPageResult.next_cursor)],
      jsonOutput: true,
    });
    assert.equal(nextPage.ok, true, nextPage.stderr);
    assert.equal((nextPage.parsed as { items?: unknown[] }).items?.length, 1);

    const closed = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["close", String(firstId), "positionally preserved reason"],
      jsonOutput: true,
    });
    assert.equal(closed.ok, true, closed.stderr);

    const missing = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["get", "web-missing"],
      jsonOutput: true,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, EXIT_CODE.NOT_FOUND);
    assert.match(missing.stderr, /not found/i);
  } finally {
    evictPmClient(pmRoot);
    if (previousRoot === undefined) delete process.env["PROJECTS_ROOT"];
    else process.env["PROJECTS_ROOT"] = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("an SDK-unsupported action falls back once to the original CLI argv", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-unsupported-runner-"));
  const fakePm = path.join(root, "fake-pm");
  const previousRoot = process.env["PROJECTS_ROOT"];
  const previousBin = process.env["PM_CLI_BIN"];

  await writeFile(fakePm, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
`);
  await chmod(fakePm, 0o755);
  process.env["PROJECTS_ROOT"] = root;
  process.env["PM_CLI_BIN"] = fakePm;

  try {
    const projectDir = path.join(root, "user", "future");
    await mkdir(projectDir, { recursive: true });
    const result = await runPm({
      userId: "user",
      slug: "future",
      args: ["future-command", "--future-value", "--still-a-value"],
      jsonOutput: true,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(
      (result.parsed as { argv?: string[] }).argv,
      ["--json", "future-command", "--future-value", "--still-a-value"],
    );
  } finally {
    evictPmClient(path.join(root, "user", "future", ".agents", "pm"));
    if (previousRoot === undefined) delete process.env["PROJECTS_ROOT"];
    else process.env["PROJECTS_ROOT"] = previousRoot;
    if (previousBin === undefined) delete process.env["PM_CLI_BIN"];
    else process.env["PM_CLI_BIN"] = previousBin;
    await rm(root, { recursive: true, force: true });
  }
});
