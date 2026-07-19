import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const app = createApp();

/**
 * Minimal in-process HTTP client (same shape as legal-routes.test.ts): invokes
 * the Express app against a fake request without binding a port or needing a
 * running PostgreSQL instance (createApp deliberately does not touch the DB).
 */
function request(method: string, url: string, targetApp: unknown = app): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
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
      (targetApp as unknown as (req: any, res: any, next: (err?: any) => void) => void)(req, res, (err?: any) => {
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

test("/ serves the SPA shell with the Bing verification tag and hosted canonical", async () => {
  const res = await request("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.body, /name="msvalidate\.01" content="A1A3EE3187D3953D97C9BE7C81961E53"/);
  assert.match(res.body, /<link rel="canonical" href="https:\/\/pm-web\.unbrained\.dev\/">/);
});

// Per sourcery review on PR #51: prove PM_WEB_PUBLIC_ORIGIN is honoured and that
// a trailing slash on the override does NOT produce a doubled slash (//sitemap.xml).
test("robots.txt/sitemap.xml honour PM_WEB_PUBLIC_ORIGIN and normalize a trailing slash", async () => {
  const prev = process.env.PM_WEB_PUBLIC_ORIGIN;
  process.env.PM_WEB_PUBLIC_ORIGIN = "https://mirror.example.com/"; // note trailing slash
  try {
    const overrideApp = createApp(); // origin is resolved at construction time
    const robots = await request("GET", "/robots.txt", overrideApp);
    assert.equal(robots.status, 200);
    assert.match(robots.body, /Sitemap: https:\/\/mirror\.example\.com\/sitemap\.xml/);
    assert.doesNotMatch(robots.body, /mirror\.example\.com\/\/sitemap\.xml/);

    const sitemap = await request("GET", "/sitemap.xml", overrideApp);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.body, /<loc>https:\/\/mirror\.example\.com\/<\/loc>/);
    assert.match(sitemap.body, /<loc>https:\/\/mirror\.example\.com\/terms<\/loc>/);
    // No doubled slash after the origin anywhere in the document.
    assert.doesNotMatch(sitemap.body, /mirror\.example\.com\/\/[a-z]/);
    // The hosted default origin must not leak into an overridden deployment.
    assert.doesNotMatch(sitemap.body, /pm-web\.unbrained\.dev/);

    // The served SPA shell must advertise the overridden origin in its canonical
    // and Open Graph URLs — not the baked-in hosted default.
    const shell = await request("GET", "/", overrideApp);
    assert.equal(shell.status, 200);
    assert.match(shell.body, /<link rel="canonical" href="https:\/\/mirror\.example\.com\/">/);
    assert.match(shell.body, /property="og:url" content="https:\/\/mirror\.example\.com\/"/);
    assert.doesNotMatch(shell.body, /pm-web\.unbrained\.dev/);
  } finally {
    if (prev === undefined) delete process.env.PM_WEB_PUBLIC_ORIGIN;
    else process.env.PM_WEB_PUBLIC_ORIGIN = prev;
  }
});