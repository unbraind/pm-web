/** Browser-client CSRF contract tests for the shared API wrapper. */
import assert from "node:assert/strict";
import test from "node:test";

import { api, csrfTokenFromCookie, syncServiceWorkerSession } from "../public/src/api.ts";

test("csrfTokenFromCookie decodes the named cookie and rejects malformed encoding", () => {
  assert.equal(
    csrfTokenFromCookie("other=1; csrf_token=token%2Bvalue; final=2"),
    "token+value",
  );
  assert.equal(csrfTokenFromCookie("csrf_token=%E0%A4%A"), undefined);
  assert.equal(csrfTokenFromCookie("other=1"), undefined);
});

test("api replays the readable CSRF cookie in the request header", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document;
  const originalFetch = globals.fetch;
  globals.document = { cookie: "csrf_token=browser-token" };
  globals.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-csrf-token"), "browser-token");
    assert.equal(init?.credentials, "include");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    assert.deepEqual(await api("POST", "/mutation", { value: 1 }), { ok: true });
  } finally {
    if (originalDocument === undefined) delete globals.document;
    else globals.document = originalDocument;
    globals.fetch = originalFetch;
  }
});


test("session is resent on controllerchange with the latest login or logout", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const messages: unknown[] = [];
  const workers = Object.assign(new EventTarget(), { controller: null as null | { postMessage(message: unknown): void } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: workers } });
  try {
    syncServiceWorkerSession({ id: "alice" });
    syncServiceWorkerSession({ id: "bob" });
    workers.controller = { postMessage: (message) => { messages.push(message); } };
    workers.dispatchEvent(new Event("controllerchange"));
    assert.deepEqual(messages, [{ type: "AUTH_SESSION", userId: "bob" }]);
    syncServiceWorkerSession(null);
    workers.dispatchEvent(new Event("controllerchange"));
    assert.deepEqual(messages.slice(1), [
      { type: "AUTH_SESSION", userId: null }, { type: "AUTH_SESSION", userId: null },
    ]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});


test("blocked legacy mutations have a visible explicit recovery action for the current account", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document;
  const workers = Object.assign(new EventTarget(), { controller: { postMessage: (message: unknown) => { messages.push(message); } } });
  const messages: unknown[] = [];
  // DOM surface exercised by the session bridge: actual event dispatch and nodes retained in the body.
  const nodes: Array<{ textContent: string; children: unknown[]; onclick?: () => void; remove(): void }> = [];
  globals.document = {
    getElementById: () => null,
    createElement: () => {
      const element = { textContent: "", style: { cssText: "" }, children: [] as unknown[], onclick: undefined as (() => void) | undefined,
        append: (...children: unknown[]) => { element.children.push(...children); },
        setAttribute: () => {},
        remove: () => { const index = nodes.indexOf(element); if (index >= 0) nodes.splice(index, 1); },
      };
      return element;
    },
    body: { append: (node: typeof nodes[number]) => { nodes.push(node); } },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: workers } });
  try {
    syncServiceWorkerSession({ id: "alice" });
    workers.dispatchEvent(new MessageEvent("message", { data: { type: "MUTATIONS_BLOCKED", blocked: [
      { id: 1, method: "POST", path: "/groups", reason: "unknown-owner" },
      { id: 2, method: "PATCH", path: "/items/foreign", reason: "owner-mismatch" },
    ] } }));
    assert.equal(nodes.length, 1, "the SPA displays blocked work");
    const button = nodes[0].children.find((child) => (child as { onclick?: unknown }).onclick
      && /adopt/i.test((child as { textContent: string }).textContent)) as { onclick(): void; textContent: string };
    assert.match(button.textContent, /adopt/i);
    assert.equal(messages.length, 1, "nothing is adopted until the user clicks");
    button.onclick();
    assert.deepEqual(messages[1], { type: "REBIND_RECORDS", ids: [1], ownerId: "alice" });
    syncServiceWorkerSession(null);
    button.onclick();
    assert.equal(messages.filter((msg) => (msg as { type: string }).type === "REBIND_RECORDS").length, 1, "an old action cannot run after logout");
  } finally {
    globals.document = originalDocument;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

/** Browser nodes retain attributes, children and native button properties for recovery assertions. */
interface RecoveryNode {
  tagName: string;
  textContent: string;
  type: string;
  tabIndex: number;
  attributes: Record<string, string>;
  children: RecoveryNode[];
  onclick?: () => void;
  remove(): void;
}

/** Install a browser event/DOM boundary while executing the real session bridge and notice code. */
function recoveryPage(t: test.TestContext): {
  nodes: RecoveryNode[]; messages: unknown[]; report: (blocked: unknown[]) => void; confirm: (answer: boolean) => void;
} {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document;
  const originalConfirm = globals.confirm;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const nodes: RecoveryNode[] = [];
  const messages: unknown[] = [];
  const workers = Object.assign(new EventTarget(), { controller: { postMessage: (message: unknown) => { messages.push(message); } } });
  globals.document = {
    /** Model native buttons as keyboard focusable without changing application behavior. */
    createElement: (tagName: string): RecoveryNode => {
      const node = { tagName, textContent: "", type: "", tabIndex: tagName === "button" ? 0 : -1,
        style: { cssText: "" }, attributes: {} as Record<string, string>, children: [] as RecoveryNode[],
        /** Retain the rendered child tree for accessible control assertions. */
        append: (...children: RecoveryNode[]) => { node.children.push(...children); },
        /** Retain ARIA and native attributes as a browser would. */
        setAttribute: (name: string, value: string) => { node.attributes[name] = value; },
        /** Remove the notice from the rendered body. */
        remove: () => { const index = nodes.indexOf(node); if (index >= 0) nodes.splice(index, 1); },
      };
      return node;
    },
    body: { append: (node: RecoveryNode) => { nodes.push(node); } },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: workers } });
  t.after(() => {
    globals.document = originalDocument;
    if (originalConfirm === undefined) delete globals.confirm;
    else globals.confirm = originalConfirm;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  syncServiceWorkerSession({ id: "account-a" });
  return { nodes, messages,
    /** Dispatch worker reports through the real browser listener. */
    report: (blocked) => { workers.dispatchEvent(new MessageEvent("message", { data: { type: "MUTATIONS_BLOCKED", blocked } })); },
    /** Supply the user's answer to the browser confirmation dialog. */
    confirm: (answer) => { globals.confirm = () => answer; },
  };
}

test("recovery dismissal is accessible and lasts until the blocked set changes", (t) => {
  const page = recoveryPage(t);
  const blocked = [{ id: 1, method: "POST", path: "/groups", reason: "owner-mismatch" }];
  page.report(blocked);
  const dismiss = page.nodes[0].children.find((node) => node.textContent === "Dismiss");
  assert.ok(dismiss, "the recovery overlay has a dismiss button");
  assert.equal(dismiss.tagName, "button");
  assert.equal(dismiss.attributes["aria-label"], "Dismiss offline recovery notice");
  assert.equal(dismiss.tabIndex, 0, "native button is keyboard reachable");
  dismiss.onclick?.();
  assert.equal(page.nodes.length, 0);
  page.report(structuredClone(blocked));
  syncServiceWorkerSession({ id: "account-a" });
  page.report(blocked);
  assert.equal(page.nodes.length, 0, "repeated flushes and session sync do not reopen a dismissed notice");
  page.report([...blocked, { id: 2, method: "PATCH", path: "/projects/a/pm/update", reason: "outcome-unknown" }]);
  assert.equal(page.nodes.length, 1, "changed blocked work reopens the notice");
  page.report([]);
  assert.equal(page.nodes.length, 0, "resolved work removes the notice");
  page.report(blocked);
  assert.equal(page.nodes.length, 1, "a cleared set resets dismissal for later blocked work");
});

test("needs-attention recovery offers confirmed retry-as-new and discard only to its owner", (t) => {
  const page = recoveryPage(t);
  page.report([{ id: 4, method: "POST", path: "/projects/a/pm/create", ownerId: "account-a", reason: "outcome-unknown" }]);
  const row = page.nodes[0].children.find((node) => node.tagName === "ul")?.children[0];
  const retry = row?.children.find((node) => node.textContent === "Retry as a new request");
  const discard = row?.children.find((node) => node.textContent === "Discard");
  assert.ok(retry);
  assert.ok(discard);
  page.confirm(false);
  retry.onclick?.();
  assert.equal(page.messages.length, 1, "cancelling confirmation sends no recovery request");
  page.confirm(true);
  retry.onclick?.();
  assert.deepEqual(page.messages[1], { type: "RECOVER_RECORD", action: "retry-new", id: 4, ownerId: "account-a" });
  discard.onclick?.();
  assert.deepEqual(page.messages[2], { type: "RECOVER_RECORD", action: "discard", id: 4, ownerId: "account-a" });
  syncServiceWorkerSession({ id: "account-b" });
  retry.onclick?.();
  discard.onclick?.();
  assert.equal(page.messages.length, 4, "stale controls cannot approve another account's recovery");
});

test("the originating tab attaches its expected account before a worker reads shared session state", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document;
  const originalFetch = globalThis.fetch;
  const workers = Object.assign(new EventTarget(), { controller: { postMessage: (_message: unknown): void => {} } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: workers } });
  globals.document = { cookie: "csrf_token=browser-token" };
  const expected: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    expected.push(new Headers(init?.headers).get("x-pm-expected-account"));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  try {
    syncServiceWorkerSession({ id: "account-a" });
    await api("POST", "/groups", { name: "from-tab-a" });
    await api("POST", "/auth/logout");
    await api("GET", "/groups");
    assert.deepEqual(expected, ["account-a", null, null]);
  } finally {
    Object.assign(globalThis, { fetch: originalFetch });
    globals.document = originalDocument;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
