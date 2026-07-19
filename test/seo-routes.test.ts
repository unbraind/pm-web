import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const app = createApp();

/**
 * Minimal in-process HTTP client (same shape as legal-routes.test.ts): invokes
 * the Express app against a fake request without binding a port or needing a
 * running PostgreSQL instance (createApp deliberately does not touch the DB).
 */
function request(method: string, url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req: any = { method, url, headers: {}, connection: { remoteAddress: "127.0.0.1" } };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      _headers: {} as Record<string, string>,
      _chunks: [] as Buffer[],
      setHeader(k: string, v: string) { this._headers[k.toLowerCase()] = v; },
      getHeader(k: string) { return this._headers[k.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      sendFile(file: string, _opts: unknown, done?: (err?: Error) => void) {
        void file;
        if (typeof _opts === "function") { done = _opts as (err?: Error) => void; }
        this.headersSent = true;
        this.end();
        if (done) done();
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({ status: this.statusCode, headers: this._headers, body: Buffer.concat(this._chunks).toString("utf8") });
      },
      json(body: unknown) {
        this.setHeader("Content-Type", "application/json");
        this.end(JSON.stringify(body));
      },
    };

    try {
      (app as unknown as (req: any, res: any, next: (err?: any) => void) => void)(req, res, (err?: any) => {
        if (err) { reject(err); return; }
        res.statusCode = 404;
        resolve({ status: res.statusCode, headers: res._headers, body: Buffer.concat(res._chunks).toString("utf8") });
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}

test("/robots.txt is text/plain and advertises the sitemap", async () => {
  const res = await request("GET", "/robots.txt");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/plain/);
  assert.match(res.body, /User-agent: \*/);
  assert.match(res.body, /Allow: \//);
  assert.match(res.body, /Sitemap: https:\/\/pm-web\.unbrained\.dev\/sitemap\.xml/);
});

test("/sitemap.xml is application/xml with a valid <urlset> for public pages only", async () => {
  const res = await request("GET", "/sitemap.xml");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /application\/xml/);
  assert.match(res.body, /<\?xml version="1.0"/);
  assert.match(res.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(res.body, /<loc>https:\/\/pm-web\.unbrained\.dev\/<\/loc>/);
  assert.match(res.body, /<priority>1\.0<\/priority>/);
  for (const page of ["/privacy-policy", "/terms", "/legal-notice", "/cookie-settings"]) {
    assert.match(res.body, new RegExp(`<loc>https://pm-web\\.unbrained\\.dev${page}</loc>`), `sitemap should list ${page}`);
  }
  // Authenticated/app/API routes must NOT appear in the public sitemap.
  assert.doesNotMatch(res.body, /\/api\//);
  assert.doesNotMatch(res.body, /\/projects\//);
  assert.doesNotMatch(res.body, /\/auth/);
  // lastmod is a YYYY-MM-DD date.
  assert.match(res.body, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test("SPA fallback still serves index.html (200) for unknown client routes", async () => {
  const res = await request("GET", "/some-unknown-spa-route");
  assert.equal(res.status, 200);
});