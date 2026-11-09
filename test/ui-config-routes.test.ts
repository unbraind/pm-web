/**
 * Real-HTTP tests for the unauthenticated UI configuration endpoint.
 *
 * `GET /api/ui-config` exposes the operator's `PM_WEB_STORAGE_NOTICE`
 * setting (src/routes/ui-config.ts) to the classic cookie-consent script.
 * Both values are exercised through a real TCP listener so the exact bytes,
 * status codes, and content type a browser fetch observes are asserted, not
 * the in-process Express handler contract alone. The route deliberately
 * needs no database: `createApp` does not touch PostgreSQL, so this suite
 * runs without one (the suite wrapper still provides a URL for the lazy
 * pool constructed at import time).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { storageNoticeEnabled } from "../src/routes/ui-config.ts";

/** A started application server bound to an ephemeral loopback port. */
interface TestServer {
  /** The listening HTTP server; closed in the suite's after hook. */
  readonly server: Server;
  /** Base URL (`http://127.0.0.1:<port>`) for real fetch requests. */
  readonly baseUrl: string;
}

let testServer: TestServer;

test.before(async () => {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => { resolve(); }); });
  const address = server.address();
  assert.ok(address && typeof address === "object", "server should be listening");
  testServer = { server, baseUrl: `http://127.0.0.1:${address.port}` };
});

test.after(async () => {
  testServer.server.closeAllConnections();
  await new Promise<void>((resolve) => { testServer.server.close(() => { resolve(); }); });
});

/**
 * Fetch `/api/ui-config` over real HTTP and return status, content type,
 * and the parsed JSON body.
 */
async function fetchUiConfig(): Promise<{ status: number; contentType: string | null; body: unknown }> {
  const response = await fetch(`${testServer.baseUrl}/api/ui-config`);
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* body assertions below fail loudly on non-JSON responses */
  }
  return { status: response.status, contentType, body };
}

/**
 * Run one request with `PM_WEB_STORAGE_NOTICE` temporarily set to the given
 * raw value (deleted when `undefined`), restoring the prior environment even
 * when an assertion throws.
 */
async function withStorageNotice(rawValue: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PM_WEB_STORAGE_NOTICE;
  if (rawValue === undefined) delete process.env.PM_WEB_STORAGE_NOTICE;
  else process.env.PM_WEB_STORAGE_NOTICE = rawValue;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PM_WEB_STORAGE_NOTICE;
    else process.env.PM_WEB_STORAGE_NOTICE = previous;
  }
}

test("unauthenticated GET /api/ui-config reports the storage notice on by default", async () => {
  await withStorageNotice(undefined, async () => {
    const res = await fetchUiConfig();
    assert.equal(res.status, 200);
    assert.equal(res.contentType, "application/json; charset=utf-8");
    assert.deepEqual(res.body, { storageNotice: true });
  });
});

test("PM_WEB_STORAGE_NOTICE=on keeps the storage notice on", async () => {
  await withStorageNotice("on", async () => {
    const res = await fetchUiConfig();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { storageNotice: true });
  });
});

test("PM_WEB_STORAGE_NOTICE=off disables the storage notice over real HTTP", async () => {
  await withStorageNotice("off", async () => {
    const res = await fetchUiConfig();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { storageNotice: false });
  });
});

test("only the exact value off disables; surrounding whitespace and case are tolerated", async () => {
  for (const rawValue of ["off", "OFF", " off "]) {
    await withStorageNotice(rawValue, async () => {
      const res = await fetchUiConfig();
      assert.deepEqual(res.body, { storageNotice: false }, `${JSON.stringify(rawValue)} should disable`);
    });
  }
});

test("unrecognized values never hide the storage notice", async () => {
  for (const rawValue of ["nope", "0", "false", "disabled", "yes, off"]) {
    await withStorageNotice(rawValue, async () => {
      const res = await fetchUiConfig();
      assert.deepEqual(res.body, { storageNotice: true }, `${JSON.stringify(rawValue)} must fall back to on`);
    });
  }
});

test("storageNoticeEnabled resolves an injected environment without touching process.env", () => {
  assert.equal(storageNoticeEnabled({}), true, "unset must default to on");
  assert.equal(storageNoticeEnabled({ PM_WEB_STORAGE_NOTICE: "" }), true, "blank must default to on");
  assert.equal(storageNoticeEnabled({ PM_WEB_STORAGE_NOTICE: "on" }), true);
  assert.equal(storageNoticeEnabled({ PM_WEB_STORAGE_NOTICE: "off" }), false);
  assert.equal(storageNoticeEnabled({ PM_WEB_STORAGE_NOTICE: " OFF " }), false);
  assert.equal(storageNoticeEnabled({ PM_WEB_STORAGE_NOTICE: "disable" }), true, "unknown values must stay on");
});

test("the config read requires no authentication: a cookieless fetch succeeds", async () => {
  await withStorageNotice(undefined, async () => {
    const response = await fetch(`${testServer.baseUrl}/api/ui-config`, {
      headers: { cookie: "" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { storageNotice: true });
  });
});

test("unknown API paths still answer JSON 404 (ui-config does not widen the API surface)", async () => {
  const response = await fetch(`${testServer.baseUrl}/api/definitely-not-a-route`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});
