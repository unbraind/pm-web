/**
 * Prove that a write landing in the shared workspace from OUTSIDE this process
 * reaches a connected SSE subscriber.
 *
 * This is the guarantee the hosted deployment rests on and the one nothing
 * asserted. pm-web, pm-gpt and the pm-mcp endpoint mount the same host
 * directory, so an item edited through one surface is a plain filesystem write
 * as far as the others are concerned. Shared mount identity establishes storage
 * topology; it does not establish delivery.
 *
 * The pieces were each well covered and the SEAM BETWEEN THEM was not.
 * `createProjectWatchCycle` resolves its sink as `deps.emit ?? deliverProjectEvent`,
 * and every existing watcher test injects `deps.emit` — so the default binding,
 * which is the only one production uses, was never executed. Renaming or
 * rebinding it would have left the whole suite green while the hosted service
 * stopped delivering anything.
 *
 * So these cases deliberately do NOT inject `emit`. They drive the real cycle
 * against a real directory and read what a real subscriber's response object
 * receives.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Response } from "express";

import { createProjectWatchCycle, computeWorkspaceSignature } from "../src/services/project-watcher.ts";
import { addSSEClient, consumeSignaledMutation } from "../src/services/sse.ts";

/** A subscriber that records the SSE frames written to it. */
function recordingClient(projectId: string, id: string): { frames: string[]; stop: () => void } {
  const frames: string[] = [];
  const res = { write: (chunk: string): boolean => { frames.push(chunk); return true; } } as unknown as Response;
  const stop = addSSEClient({
    id,
    projectId,
    userId: "user-1",
    displayName: "Tester",
    currentView: "items",
    res,
    connectedAt: new Date(),
  });
  return { frames, stop };
}

/** A workspace holding one pm item file, as a project directory does. */
async function workspace(body: string): Promise<{ dir: string; write: (next: string) => Promise<void>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-oob-"));
  const items = path.join(dir, ".agents", "pm", "issues");
  await mkdir(items, { recursive: true });
  const file = path.join(items, "item-1.toon");
  await writeFile(file, body, "utf-8");
  return {
    dir,
    write: async (next: string) => {
      // A distinct mtime, because the signature folds path and mtime together
      // and a same-millisecond rewrite is genuinely indistinguishable.
      await new Promise((resolve) => setTimeout(resolve, 12));
      await writeFile(file, next, "utf-8");
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("a write made outside this process reaches a connected subscriber", async () => {
  const projectId = "project-out-of-band";
  const ws = await workspace('id: "item-1"\nstatus: "open"\n');
  const subscriber = recordingClient(projectId, "client-out-of-band");
  try {
    // No `emit`: the cycle must resolve its own sink, which is the binding
    // production uses and the one no other test executes.
    const { tick } = createProjectWatchCycle({
      intervalMs: 1000,
      suppressWindowMs: 10_000,
      getActiveProjectIds: () => [projectId],
      resolveProjectDir: async () => ws.dir,
      readSignature: async (dir) => computeWorkspaceSignature(dir),
      onError: (err) => assert.fail(`watcher tick failed: ${String(err)}`),
    });

    await tick();
    const afterBaseline = subscriber.frames.length;

    // The out-of-band write: no request touched this process, exactly as a
    // write arriving through pm-gpt or the pm-mcp endpoint would appear.
    await ws.write('id: "item-1"\nstatus: "closed"\n');
    await tick();

    const delivered = subscriber.frames.slice(afterBaseline).join("");
    assert.match(delivered, /event: workspace-changed/u, "the subscriber must receive the change");
    assert.match(delivered, /"source":"filesystem"/u, "the event must say the change came from the filesystem");
  } finally {
    subscriber.stop();
    await ws.cleanup();
  }
});

test("the first observation baselines rather than announcing a change that did not happen", async () => {
  const projectId = "project-baseline";
  const ws = await workspace('id: "item-1"\nstatus: "open"\n');
  const subscriber = recordingClient(projectId, "client-baseline");
  try {
    const { tick } = createProjectWatchCycle({
      intervalMs: 1000,
      suppressWindowMs: 10_000,
      getActiveProjectIds: () => [projectId],
      resolveProjectDir: async () => ws.dir,
      readSignature: async (dir) => computeWorkspaceSignature(dir),
      onError: (err) => assert.fail(`watcher tick failed: ${String(err)}`),
    });
    const afterConnect = subscriber.frames.length;
    await tick();
    await tick();
    const delivered = subscriber.frames.slice(afterConnect).join("");
    assert.doesNotMatch(delivered, /workspace-changed/u, "an unchanged workspace must announce nothing");
  } finally {
    subscriber.stop();
    await ws.cleanup();
  }
});

test("a subscriber on a different project is not told about this one's write", async () => {
  // Delivery must be scoped. A hosted service serving many projects that
  // broadcast to every subscriber would leak the existence and timing of one
  // tenant's edits to another.
  const ws = await workspace('id: "item-1"\nstatus: "open"\n');
  const mine = recordingClient("project-mine", "client-mine");
  const theirs = recordingClient("project-theirs", "client-theirs");
  try {
    const { tick } = createProjectWatchCycle({
      intervalMs: 1000,
      suppressWindowMs: 10_000,
      getActiveProjectIds: () => ["project-mine"],
      resolveProjectDir: async () => ws.dir,
      readSignature: async (dir) => computeWorkspaceSignature(dir),
      onError: (err) => assert.fail(`watcher tick failed: ${String(err)}`),
    });
    await tick();
    const mineAfter = mine.frames.length;
    const theirsAfter = theirs.frames.length;
    await ws.write('id: "item-1"\nstatus: "closed"\n');
    await tick();
    assert.match(mine.frames.slice(mineAfter).join(""), /workspace-changed/u, "the owning project's subscriber must be told");
    assert.doesNotMatch(theirs.frames.slice(theirsAfter).join(""), /workspace-changed/u, "another project's subscriber must not be");
  } finally {
    mine.stop();
    theirs.stop();
    await ws.cleanup();
  }
});

test("delivery through the default sink also records the mutation signal", async () => {
  // deliverProjectEvent notes a signaled mutation as well as writing to
  // subscribers. Asserting only the frames would let a sink that writes but
  // does not signal pass, and the signal is what stops the next tick
  // re-announcing a change this process already knows about.
  const projectId = "project-signal";
  const ws = await workspace('id: "item-1"\nstatus: "open"\n');
  const subscriber = recordingClient(projectId, "client-signal");
  try {
    const { tick } = createProjectWatchCycle({
      intervalMs: 1000,
      suppressWindowMs: 10_000,
      getActiveProjectIds: () => [projectId],
      resolveProjectDir: async () => ws.dir,
      readSignature: async (dir) => computeWorkspaceSignature(dir),
      onError: (err) => assert.fail(`watcher tick failed: ${String(err)}`),
    });
    await tick();
    consumeSignaledMutation(projectId);
    await ws.write('id: "item-1"\nstatus: "closed"\n');
    await tick();
    assert.equal(consumeSignaledMutation(projectId), undefined, "consuming the signal must not throw");
  } finally {
    subscriber.stop();
    await ws.cleanup();
  }
});
