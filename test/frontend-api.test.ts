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
    const button = nodes[0].children.find((child) => (child as { onclick?: unknown }).onclick) as { onclick(): void; textContent: string };
    assert.match(button.textContent, /adopt/i);
    assert.equal(messages.length, 1, "nothing is adopted until the user clicks");
    button.onclick();
    assert.deepEqual(messages[1], { type: "REBIND_RECORDS", ids: [1] });
    syncServiceWorkerSession(null);
    button.onclick();
    assert.equal(messages.filter((msg) => (msg as { type: string }).type === "REBIND_RECORDS").length, 1, "an old action cannot run after logout");
  } finally {
    globals.document = originalDocument;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
