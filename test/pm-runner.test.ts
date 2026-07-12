import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runPm, Semaphore } from "../dist/services/pm-runner.js";

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

test("pm runner stays non-blocking, serializes a workspace, and overlaps independent workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-runner-"));
  const fakePm = path.join(root, "fake-pm");
  const logPath = path.join(root, "commands.log");
  const previousRoot = process.env["PROJECTS_ROOT"];
  const previousBin = process.env["PM_CLI_BIN"];

  await writeFile(fakePm, `#!/usr/bin/env node
const fs = require("node:fs");
const delay = Number(process.argv[2]);
const label = process.argv[3];
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
      runPm({ userId: "user", slug: "same", args: ["120", "first"] }),
      runPm({ userId: "user", slug: "same", args: ["120", "second"] }),
      runPm({ userId: "user", slug: "other", args: ["120", "independent"] }),
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
      args: ["500", "timeout"],
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
