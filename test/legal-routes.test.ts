import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, LEGAL_PAGES, resolveLegalPagesDir } from "../src/app.ts";

const app = createApp();

/** The request fields this in-process client supplies to Express. */
interface LegalRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  connection: { remoteAddress: string };
}

/** The response methods the legal routes actually call. */
interface LegalResponse {
  statusCode: number;
  headersSent: boolean;
  _headers: Record<string, string>;
  _chunks: Buffer[];
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  status(code: number): this;
  redirect(code: number, location: string): void;
  sendFile(file: string, options: unknown, done?: (err?: Error) => void): void;
  end(chunk?: unknown): void;
  json(body: unknown): void;
}

/** Express apps are request handlers. This names the subset the suite calls. */
type LegalHandler = (req: LegalRequest, res: LegalResponse, next: (err?: unknown) => void) => void;

/**
 * Narrow the Express app to the handler shape this in-process client invokes.
 *
 * @param value - The value returned by `createApp`.
 * @returns The same function, checked to be callable.
 */
function asLegalHandler(value: unknown): LegalHandler {
  if (typeof value !== "function") throw new Error("express app is not a function");
  return value as LegalHandler;
}

/**
 * Minimal in-process HTTP client: invokes the Express app against a fake
 * request without binding a port. Avoids the need for a running PostgreSQL
 * instance (createApp deliberately does not touch the DB).
 */
function request(method: string, url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req: LegalRequest = { method, url, headers: {}, connection: { remoteAddress: "127.0.0.1" } };
    const res: LegalResponse = {
      statusCode: 200,
      headersSent: false,
      _headers: {},
      _chunks: [],
      setHeader(name: string, value: string) { this._headers[name.toLowerCase()] = value; },
      getHeader(name: string) { return this._headers[name.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      redirect(code: number, location: string) {
        this.statusCode = code;
        this.setHeader("Location", location);
        this.headersSent = true;
        this.end();
      },
      sendFile(file: string, options: unknown, done?: (err?: Error) => void) {
        // Express' sendFile is file-system based; we don't need the bytes for
        // these assertions, only to know it was dispatched. resolve() is enough.
        void file;
        if (typeof options === "function") { done = options as (err?: Error) => void; }
        this.headersSent = true;
        this.end();
        if (done) done();
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({
          status: this.statusCode,
          headers: this._headers,
          body: Buffer.concat(this._chunks).toString("utf8"),
          location: this._headers.location,
        });
      },
      json(body: unknown) {
        this.setHeader("Content-Type", "application/json");
        this.end(JSON.stringify(body));
      },
    };

    // Dispatch through Express' handler. Express 5 apps are functions of
    // (req, res, next).
    try {
      asLegalHandler(app)(req, res, (err?: unknown) => {
        if (err) {
          reject(err);
          return;
        }
        // next() at the end of the chain means NO route matched. Simulate
        // Express's default 404 instead of leaking the initial 200, so a
        // broken route pattern cannot produce false-positive passes.
        res.statusCode = 404;
        resolve({ status: res.statusCode, headers: res._headers, body: Buffer.concat(res._chunks).toString("utf8"), location: res._headers.location as string | undefined });
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}

test("legal pages are served with 200 from their canonical routes", async () => {
  for (const page of ["legal-notice", "privacy-policy", "terms", "cookie-settings"]) {
    const res = await request("GET", `/${page}`);
    assert.equal(res.status, 200, `GET /${page} should return 200`);
    assert.equal(res.headers["cache-control"], "no-store");
  }
});

test("private legal overlays must be absolute, complete, regular, and non-symlinked", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-legal-"));
  try {
    assert.throws(() => resolveLegalPagesDir({ PM_WEB_LEGAL_DIR: "relative" }), /absolute path/);
    assert.throws(() => resolveLegalPagesDir({ PM_WEB_LEGAL_DIR: root }));

    for (const page of LEGAL_PAGES) writeFileSync(path.join(root, `${page}.html`), page);
    assert.equal(resolveLegalPagesDir({ PM_WEB_LEGAL_DIR: root }), realpathSync(root));

    rmSync(path.join(root, "terms.html"));
    symlinkSync(path.join(root, "privacy-policy.html"), path.join(root, "terms.html"));
    assert.throws(
      () => resolveLegalPagesDir({ PM_WEB_LEGAL_DIR: root }),
      /must not be a symbolic link/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("German legal aliases redirect (308) to the canonical pages", async () => {
  const cases: Array<[string, string]> = [
    ["/impressum", "/legal-notice"],
    ["/datenschutz", "/privacy-policy"],
    ["/agb", "/terms"],
    ["/cookies", "/cookie-settings"],
  ];
  for (const [from, to] of cases) {
    const res = await request("GET", from);
    assert.equal(res.status, 308, `${from} should 308-redirect`);
    assert.equal(res.location, to, `${from} should redirect to ${to}`);
  }
});

test("healthz without probe deps reports degraded (ok:false, 503) and a version", async () => {
  // createApp() with no health deps cannot probe its dependencies. Per the
  // contract documented in app.ts, it must NOT claim ok:true (that is the bug
  // this change closes), so the no-deps route answers 503 ok:false while still
  // reporting the version.
  const res = await request("GET", "/healthz");
  assert.equal(res.status, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(typeof body.version === "string" && body.version.length > 0, "version should be a non-empty string");
});

test("OIDC discovery route is mounted and safely reports disabled by default", async () => {
  const res = await request("GET", "/api/auth/oidc/config");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { enabled: false, label: "OpenID Connect" });
});

test("unknown legal-ish path falls through to the SPA fallback (200)", async () => {
  const res = await request("GET", "/some-unknown-spa-route");
  assert.equal(res.status, 200, "SPA fallback should serve index.html");
});

test("legal pages tolerate trailing slashes (non-strict routing)", async () => {
  for (const page of ["legal-notice", "privacy-policy", "terms", "cookie-settings"]) {
    const res = await request("GET", `/${page}/`);
    assert.equal(res.status, 200, `GET /${page}/ should return 200`);
  }
});

test("unknown API routes return JSON 404 instead of the SPA shell", async () => {
  const res = await request("GET", "/api/definitely-not-a-route");
  assert.equal(res.status, 404, "unknown /api path should 404");
  const body = JSON.parse(res.body);
  assert.equal(body.error, "Not found");
});
