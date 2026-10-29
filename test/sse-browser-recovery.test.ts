/** Exercise the actual SPA callbacks without booting unrelated view and login code. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "@babel/parser";
import { transformSync } from "esbuild";

/** Minimal AST shape for locating callbacks; no production function is restated in the test. */
interface SyntaxNode { type?: string; start?: number | null; end?: number | null; [key: string]: unknown }
const sourceText = readFileSync(new URL("../public/src/app.ts", import.meta.url), "utf8");
const syntax = parse(sourceText, { sourceType: "module", plugins: ["typescript"] });

/** Extract the real error/connected callback and erase its TypeScript annotation for a browser-like realm. */
function callback(kind: "error" | "connected"): string {
  const matches: SyntaxNode[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as SyntaxNode;
    const left = node.left as SyntaxNode | undefined;
    const property = left?.property as SyntaxNode | undefined;
    if (kind === "error" && node.type === "AssignmentExpression" && property?.name === "onerror") matches.push(node.right as SyntaxNode);
    const callee = node.callee as SyntaxNode | undefined;
    const member = callee?.property as SyntaxNode | undefined;
    const args = node.arguments as SyntaxNode[] | undefined;
    if (kind === "connected" && node.type === "CallExpression" && member?.name === "addEventListener" && args?.[0]?.value === "connected") matches.push(args[1]);
    Object.values(node).forEach(visit);
  };
  visit(syntax);
  assert.equal(matches.length, 1, "one production callback must be selected");
  const selected = matches[0];
  return transformSync(`globalThis.callback = ${sourceText.slice(selected.start!, selected.end!)};`, { loader: "ts", target: "es2022" }).code;
}

/** Retain source identity and native cursor, and observe scheduled replacement and view recovery. */
function browser(readyState: number, attempt = 0) {
  const scheduled: (() => void)[] = [], reconnects: unknown[][] = [], refreshes: string[] = [], statuses: string[] = [], invalidations: string[] = [];
  let closed = 0;
  const source = { readyState, nativeCursor: "synthetic-cursor-7", close: () => { closed++; source.nativeCursor = ""; } };
  const realm: Record<string, unknown> = { source, sseSource: source, sseCurrentProjectId: "project", projectId: "project", attempt,
    EventSource: { CLOSED: 2 }, state: { currentProject: { id: "project" } }, sseClientId: null, sseReconnectTimer: null,
    setSseStatus: (value: string) => statuses.push(value),
    invalidateAgentContext: (project: string) => invalidations.push(project),
    invalidateDecisionInbox: (project: string) => invalidations.push(`decisions:${project}`),
    invalidateContractExplorer: (project: string) => invalidations.push(`operations:${project}`),
    invalidateEvidenceInspection: () => invalidations.push("evidence"),
    setTimeout: (next: () => void) => { scheduled.push(next); return 1; },
    connectSSE: (...args: unknown[]) => reconnects.push(args),
    refreshView: () => refreshes.push("view"), refreshGraph: () => refreshes.push("graph"), refreshPackagesOnSSE: () => refreshes.push("packages") };
  return { realm, source, scheduled, reconnects, refreshes, statuses, invalidations, closed: () => closed };
}

for (const readyState of [0, 1]) {
  test(`transient EventSource state ${readyState} retains the same native cursor and connection`, () => {
    const client = browser(readyState);
    runInNewContext(callback("error"), client.realm);
    (client.realm.callback as () => void)();
    assert.equal(client.closed(), 0);
    assert.strictEqual(client.realm.sseSource, client.source);
    assert.equal(client.source.nativeCursor, "synthetic-cursor-7");
    assert.equal(client.scheduled.length, 0);
    assert.deepEqual(client.statuses, ["reconnecting"]);
    assert.deepEqual(client.invalidations, ['project', 'decisions:project', 'operations:project', 'evidence']);
  });
}

test("a terminal stream schedules a fresh connection while a stale source cannot replace another project", () => {
  const client = browser(2, 3);
  runInNewContext(callback("error"), client.realm);
  (client.realm.callback as () => void)();
  assert.equal(client.closed(), 1);
  assert.deepEqual(client.invalidations, ['project', 'decisions:project', 'operations:project', 'evidence']);
  assert.equal(client.realm.sseSource, null);
  assert.equal(client.scheduled.length, 1);
  client.scheduled[0]();
  assert.deepEqual(client.reconnects, [["project", 4]]);
  const stale = browser(2);
  stale.realm.sseSource = {};
  runInNewContext(callback("error"), stale.realm);
  (stale.realm.callback as () => void)();
  assert.equal(stale.closed(), 0);
  assert.equal(stale.scheduled.length, 0);
  assert.deepEqual(stale.invalidations, []);
});

for (const attempt of [0, 1]) {
  test(`connected recovery refreshes the active snapshot only for a fresh replacement (attempt ${attempt})`, () => {
    const client = browser(1, attempt);
    runInNewContext(callback("connected"), client.realm);
    (client.realm.callback as (event: { data: string }) => void)({ data: '{"clientId":"new-session"}' });
    assert.equal(client.realm.sseClientId, "new-session");
    assert.deepEqual(client.invalidations, ["project"]);
    (client.realm.callback as (event: { data: string }) => void)({ data: '{"clientId":"native-reconnect"}' });
    assert.deepEqual(client.invalidations, ["project", "project"], "every connection revalidates, including native reconnects");
    assert.deepEqual(client.refreshes, attempt ? ["view", "graph", "packages", "view", "graph", "packages"] : []);
    client.realm.sseCurrentProjectId = "other-project";
    client.realm.sseClientId = "other-session";
    (client.realm.callback as (event: { data: string }) => void)({ data: '{"clientId":"stale"}' });
    assert.equal(client.realm.sseClientId, "other-session");
    assert.equal(client.invalidations.length, 2, "a stale connection cannot invalidate another project");
  });
}
