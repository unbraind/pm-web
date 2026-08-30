/** Browser-client CSRF contract tests for the shared API wrapper. */
import assert from "node:assert/strict";
import test from "node:test";

import { api, csrfTokenFromCookie } from "../public/src/api.ts";

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
