import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evictPmClient, EXIT_CODE, getPmClient, runPm, Semaphore } from "../src/services/pm-runner.ts";

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
    const firstId = (first.parsed as { item?: { id?: unknown } }).item?.id;
    assert.equal(typeof firstId, "string");

    const leadingFlagValue = await runPm({
      userId: "user",
      slug: "sdk",
      args: ["update", String(firstId), "--description", "--not-a-flag"],
      jsonOutput: true,
    });
    assert.equal(leadingFlagValue.ok, true, leadingFlagValue.stderr);
    assert.equal(
      (leadingFlagValue.parsed as { item?: { description?: string } }).item?.description,
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
      args: ["list-all", "--limit", "1", "--include-body"],
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
      args: ["list-all", "--limit", "1", "--after", String(firstPageResult.next_cursor)],
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
