/**
 * Real, isolated coverage for the rate-limit and CSRF middleware.
 *
 * The functional route suite mounts the limiters too, but with the limits
 * raised (via `with-test-db`) so it is never throttled; that proves the
 * middleware is *registered* but not that it *limits*. These tests build
 * minimal Express apps with small, controlled limits and drive routes past
 * them, asserting the 429 and the retry headers — and that the limiter keys on
 * the real client IP behind a proxy, that reads and writes carry separate
 * budgets, and that the CSRF guard blocks only provably cross-site
 * cookie-authenticated mutations. The pure helpers (`resolveTrustProxy`,
 * `isValidEmail`, `buildGitHubIssuesUrl`) are exercised directly.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express, { type Express } from "express";
import cookieParser from "cookie-parser";

import { createApp } from "../src/app.ts";
import {
  AUTH_LIMIT_PER_MINUTE,
  createRateLimiter,
  createTierLimiters,
  isSafeMethod,
  isUnsafeMethod,
  resolveTrustProxy,
} from "../src/rate-limit.ts";
import { csrfProtection, isCrossSiteRequest } from "../src/csrf.ts";
import { isValidEmail } from "../src/routes/auth.ts";
import { buildGitHubIssuesUrl } from "../src/routes/github.ts";

/** A running ephemeral server handle, mirroring the route-suite harness. */
interface ProbeServer {
  /** Absolute loopback URL for a relative path. */
  url(path: string): string;
  /** Stop the underlying listener. */
  close(): Promise<void>;
}

/** Start an Express app on an ephemeral loopback port. */
async function start(app: Express): Promise<ProbeServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: (p: string) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("createRateLimiter returns 429 with retry headers once the limit is exceeded", async (t) => {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, limit: 3, identifier: "test-limit" }));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  for (let i = 0; i < 3; i++) {
    const res = await fetch(server.url("/x"));
    assert.equal(res.status, 200, `request ${i + 1} should be allowed`);
  }
  const blocked = await fetch(server.url("/x"));
  assert.equal(blocked.status, 429, "the request past the limit must be rejected with 429");
  assert.equal(blocked.headers.get("ratelimit-limit"), "3", "RateLimit-Limit reports the tier limit");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0, "Retry-After must advise a positive wait");
  assert.ok(
    Number(blocked.headers.get("ratelimit-remaining")) >= 0,
    "RateLimit-Remaining is present",
  );
});

test("the limiter keys on the real client IP behind the proxy, not the proxy itself", async (t) => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createRateLimiter({ windowMs: 60_000, limit: 2, identifier: "proxy-test" }));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  // Exhaust the bucket for one forwarded client.
  for (let i = 0; i < 2; i++) {
    const res = await fetch(server.url("/x"), { headers: { "x-forwarded-for": "1.1.1.1" } });
    assert.equal(res.status, 200);
  }
  const sameClient = await fetch(server.url("/x"), { headers: { "x-forwarded-for": "1.1.1.1" } });
  assert.equal(sameClient.status, 429, "the original client's bucket is exhausted");

  // A different forwarded client must get its OWN bucket — not share the
  // proxy's. If the limiter keyed on the proxy address instead of the real
  // client, this request would also be 429.
  const otherClient = await fetch(server.url("/x"), { headers: { "x-forwarded-for": "2.2.2.2" } });
  assert.equal(otherClient.status, 200, "a different real client has a separate bucket");
});

test("under the default configuration a rotated X-Forwarded-For cannot draw a fresh bucket", async (t) => {
  // The complement of the test above. That one opts into one proxy hop and
  // asserts the limiter follows the real client. This one takes the default an
  // operator gets by running the documented `npm start` or `docker run` with no
  // proxy in front, and asserts the header buys nothing: were a hop trusted
  // there, every request could name a new client and the limiter would enforce
  // nothing at all.
  const app = express();
  app.set("trust proxy", resolveTrustProxy({}));
  app.use(createRateLimiter({ windowMs: 60_000, limit: 2, identifier: "default-trust-test" }));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  for (let i = 0; i < 2; i++) {
    const res = await fetch(server.url("/x"), { headers: { "x-forwarded-for": `9.9.9.${i}` } });
    assert.equal(res.status, 200);
  }
  const rotated = await fetch(server.url("/x"), { headers: { "x-forwarded-for": "9.9.9.99" } });
  assert.equal(rotated.status, 429, "a new forwarded address must not reset the budget");
});

test("read and write tiers carry separate per-minute budgets", async (t) => {
  const tiers = createTierLimiters({
    PM_WEB_RATE_LIMIT_READ: "2",
    PM_WEB_RATE_LIMIT_WRITE: "2",
    PM_WEB_RATE_LIMIT_AUTH: "2",
    PM_WEB_RATE_LIMIT_ADMIN: "2",
    PM_WEB_RATE_LIMIT_STATIC: "2",
  });
  const app = express();
  app.use(tiers.read, tiers.write);
  app.get("/r", (_req, res) => res.json({ ok: true }));
  app.post("/w", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  // Exhaust the READ bucket with GETs.
  assert.equal((await fetch(server.url("/r"))).status, 200);
  assert.equal((await fetch(server.url("/r"))).status, 200);
  assert.equal((await fetch(server.url("/r"))).status, 429, "read bucket is exhausted");

  // Writes use a separate WRITE bucket, so they still succeed even though reads
  // are throttled — proving the tiers are not one shared bucket.
  assert.equal((await fetch(server.url("/w"), { method: "POST" })).status, 200);
  assert.equal((await fetch(server.url("/w"), { method: "POST" })).status, 200);
  assert.equal(
    (await fetch(server.url("/w"), { method: "POST" })).status,
    429,
    "write bucket is exhausted independently of reads",
  );
});

test("createTierLimiters reads its limits from the environment with production defaults", async (t) => {
  const overridden = createTierLimiters({ PM_WEB_RATE_LIMIT_AUTH: "7" });
  const app = express();
  app.use("/api/auth", overridden.auth);
  app.get("/api/auth/me", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  const res = await fetch(server.url("/api/auth/me"));
  assert.equal(res.headers.get("ratelimit-limit"), "7", "the override is applied");

  // The invalid value falls back to the production default, not zero.
  const fallback = createTierLimiters({ PM_WEB_RATE_LIMIT_AUTH: "not-a-number" });
  const app2 = express();
  app2.use("/api/auth", fallback.auth);
  app2.get("/api/auth/me", (_req, res) => res.json({ ok: true }));
  const server2 = await start(app2);
  t.after(() => server2.close());
  const res2 = await fetch(server2.url("/api/auth/me"));
  assert.equal(
    res2.headers.get("ratelimit-limit"),
    String(AUTH_LIMIT_PER_MINUTE),
    "an invalid override falls back to the production default",
  );
});

test("isSafeMethod / isUnsafeMethod classify GET, POST and mixed-case methods", () => {
  assert.ok(isSafeMethod("GET"));
  assert.ok(isSafeMethod("HEAD"));
  assert.ok(isSafeMethod("OPTIONS"));
  assert.ok(isSafeMethod("get"), "classification is case-insensitive");
  assert.ok(!isSafeMethod("POST"));
  assert.ok(isUnsafeMethod("POST"));
  assert.ok(isUnsafeMethod("DELETE"));
  assert.ok(!isUnsafeMethod("GET"));
});

test("resolveTrustProxy honours hops, booleans and IP allowlists", () => {
  // The default must trust nothing. Every documented launch path exposes
  // Express directly, where trusting a hop would make req.ip the caller's own
  // X-Forwarded-For and hand an attacker a fresh bucket per request.
  assert.equal(resolveTrustProxy({}), false, "the default trusts no proxy hop");
  assert.equal(resolveTrustProxy({ PM_WEB_TRUST_PROXY: "" }), false);
  assert.equal(resolveTrustProxy({ PM_WEB_TRUST_PROXY: "1" }), 1, "a proxied deployment opts in");
  assert.equal(resolveTrustProxy({ PM_WEB_TRUST_PROXY: "2" }), 2);
  assert.equal(resolveTrustProxy({ PM_WEB_TRUST_PROXY: "false" }), false);
  assert.equal(resolveTrustProxy({ PM_WEB_TRUST_PROXY: "0" }), false);
  assert.equal(
    resolveTrustProxy({ PM_WEB_TRUST_PROXY: "10.0.0.1,10.0.0.2" }),
    "10.0.0.1,10.0.0.2",
    "an IP allowlist is passed through to Express",
  );
  assert.equal(
    resolveTrustProxy({ PM_WEB_TRUST_PROXY: "loopback" }),
    "loopback",
    "a proxy-addr special name is passed through",
  );
});

test("csrfProtection sets the csrf cookie and lets same-origin/authenticated reads pass", async (t) => {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection());
  app.get("/me", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  const res = await fetch(server.url("/me"));
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /csrf_token=/, "the double-submit token cookie is issued");
  assert.doesNotMatch(setCookie, /HttpOnly/i, "the csrf cookie is readable by the SPA");
  const responseToken = res.headers.get("x-csrf-token");
  assert.ok(responseToken, "safe responses expose the current token to same-origin workers");
  assert.match(
    setCookie,
    new RegExp(`csrf_token=${responseToken}`),
    "the bootstrap header and cookie carry the same token",
  );
});

test("csrfProtection blocks a cross-site, cookie-authenticated mutation with 403", async (t) => {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection());
  app.post("/change", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  // A same-origin mutation (matching Host) is allowed.
  const ok = await fetch(server.url("/change"), {
    method: "POST",
    headers: {
      cookie: "pm_token=abc; csrf_token=same-origin-token",
      origin: server.url(""),
      "x-csrf-token": "same-origin-token",
    },
  });
  assert.equal(ok.status, 200, "a same-origin cookie mutation is allowed");

  // A cross-origin mutation (foreign Origin with a session cookie) is blocked.
  const blocked = await fetch(server.url("/change"), {
    method: "POST",
    headers: { cookie: "pm_token=abc", origin: "https://evil.example" },
  });
  assert.equal(blocked.status, 403, "a cross-site cookie mutation is blocked");

  // A sibling origin is same-site but not same-origin. Public sibling services
  // are outside this app's trust boundary, so Fetch Metadata must not bypass
  // the exact Origin comparison.
  const siblingBlocked = await fetch(server.url("/change"), {
    method: "POST",
    headers: {
      cookie: "pm_token=abc",
      host: "pm-web.unbrained.dev",
      origin: "https://evil.unbrained.dev",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(siblingBlocked.status, 403, "a same-site sibling mutation is blocked");
});

test("csrfProtection requires a double-submit token for headerless cookie clients", async (t) => {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection());
  app.post("/change", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  const bearerLike = await fetch(server.url("/change"), {
    method: "POST",
  });
  assert.equal(bearerLike.status, 200, "non-cookie server clients remain compatible");

  const matched = await fetch(server.url("/change"), {
    method: "POST",
    headers: {
      cookie: "pm_token=abc; csrf_token=headerless-token",
      "x-csrf-token": "headerless-token",
    },
  });
  assert.equal(matched.status, 200, "a matching cookie/header token authorizes the request");

  const missing = await fetch(server.url("/change"), {
    method: "POST",
    headers: { cookie: "pm_token=abc; csrf_token=headerless-token" },
  });
  assert.equal(missing.status, 403, "a session cookie without the replayed token is blocked");

  const mismatched = await fetch(server.url("/change"), {
    method: "POST",
    headers: {
      cookie: "pm_token=abc; csrf_token=headerless-token",
      "x-csrf-token": "different-token",
    },
  });
  assert.equal(mismatched.status, 403, "a mismatched double-submit token is blocked");
});

test("csrfProtection compares Origin with the trust-aware forwarded host", async (t) => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(csrfProtection());
  app.post("/change", (_req, res) => res.status(204).end());
  const server = await start(app);
  t.after(() => server.close());

  const res = await fetch(server.url("/change"), {
    method: "POST",
    headers: {
      cookie: "pm_token=abc; csrf_token=proxy-token",
      origin: "https://pm-web.unbrained.dev",
      "sec-fetch-site": "same-site",
      "x-csrf-token": "proxy-token",
      "x-forwarded-host": "pm-web.unbrained.dev",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(res.status, 204, "a trusted proxy's public origin is accepted");
});

test("csrfProtection blocks browser-originated mutations without relying on a session cookie", async (t) => {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection());
  app.post("/login", (_req, res) => res.json({ ok: true }));
  const server = await start(app);
  t.after(() => server.close());

  const res = await fetch(server.url("/login"), {
    method: "POST",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(
    res.status,
    403,
    "login and logout endpoints stay protected even when a Lax session cookie is omitted",
  );
});

test("isCrossSiteRequest trusts Sec-Fetch-Site and falls back to the Origin header", () => {
  const base = {
    get: () => "127.0.0.1:1",
    host: "127.0.0.1:1",
    protocol: "http",
  } as unknown as import("express").Request;
  const req = (headers: Record<string, string>) =>
    ({ ...base, headers } as unknown as import("express").Request);

  assert.equal(isCrossSiteRequest(req({ "sec-fetch-site": "cross-site" })), true);
  assert.equal(isCrossSiteRequest(req({ "sec-fetch-site": "same-origin" })), false);
  assert.equal(isCrossSiteRequest(req({ "sec-fetch-site": "none" })), false);
  assert.equal(
    isCrossSiteRequest(req({ "sec-fetch-site": "same-site", origin: "https://evil.example" })),
    true,
    "same-site is not trusted without an exact origin match",
  );
  assert.equal(
    isCrossSiteRequest(req({ "sec-fetch-site": "same-site" })),
    true,
    "a browser-classified sibling request without Origin fails closed",
  );
  // An unknown Sec-Fetch-Site string is neither conclusive cross-site nor a
  // known same-site value, so it falls through to the Origin header check.
  assert.equal(
    isCrossSiteRequest(req({ "sec-fetch-site": "weird", origin: "http://127.0.0.1:1" })),
    false,
    "an unknown fetch-site with a matching Origin is same-origin",
  );
  // No fetch-metadata header: compare Origin against Host.
  assert.equal(
    isCrossSiteRequest(req({ origin: "http://127.0.0.1:1" })),
    false,
    "matching Origin is same-origin",
  );
  assert.equal(
    isCrossSiteRequest(req({ origin: "https://evil.example" })),
    true,
    "mismatched Origin is cross-site",
  );
  assert.equal(
    isCrossSiteRequest(req({ origin: "https://127.0.0.1:1" })),
    true,
    "a scheme mismatch is cross-origin even when Host matches",
  );
  assert.equal(isCrossSiteRequest(req({})), false, "no Origin means non-browser, allowed");
  assert.equal(
    isCrossSiteRequest(req({ origin: "not-a-url" })),
    true,
    "a malformed browser Origin fails closed",
  );
});

test("isValidEmail rejects adversarial input without backtracking and accepts real addresses", () => {
  assert.ok(isValidEmail("user@example.com"));
  assert.ok(isValidEmail("a.b+c@sub.example.co"));
  // A long string with no `@` is rejected up front; with the old backtracking
  // regex this was the quadratic case.
  assert.ok(!isValidEmail("a".repeat(10_000) + "!"));
  assert.ok(!isValidEmail("no-at-sign.example"));
  assert.ok(!isValidEmail("@nodomain.com"));
  assert.ok(!isValidEmail("user@"));
  assert.ok(!isValidEmail("user@no-tld"));
  assert.ok(!isValidEmail("user@second@at.com"));
  assert.ok(!isValidEmail("has space@example.com"));
  assert.ok(!isValidEmail("a".repeat(255) + "@x.com"), "over the 254-char bound is rejected");
});

test("buildGitHubIssuesUrl encodes query parameters and whitelists state", () => {
  const url = buildGitHubIssuesUrl("o wner", "re/po", { state: "closed", per_page: "5", page: "2" });
  assert.equal(
    url,
    "https://api.github.com/repos/o%20wner/re%2Fpo/issues?state=closed&per_page=5&page=2&pulls=false",
    "owner/repo are encoded and query params are URL-encoded",
  );
  assert.equal(
    buildGitHubIssuesUrl("o", "r", { state: "evil&pulls=true" }).split("state=")[1].split("&")[0],
    "open",
    "an unknown state falls back to open instead of being injected",
  );
  assert.equal(
    buildGitHubIssuesUrl("o", "r", { per_page: "NaN", page: "not-a-number" }),
    "https://api.github.com/repos/o/r/issues?state=open&per_page=30&page=1&pulls=false",
    "non-numeric bounds fall back to the defaults",
  );
  assert.equal(
    buildGitHubIssuesUrl("o", "r", { per_page: "9999", page: "-3" }),
    "https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1&pulls=false",
    "per_page is clamped to [1,100] and page to [1,1000]",
  );
  assert.equal(
    buildGitHubIssuesUrl("o", "r", { per_page: 7 }),
    "https://api.github.com/repos/o/r/issues?state=open&per_page=7&page=1&pulls=false",
    "a numeric per_page is accepted",
  );
});

test("the production app exposes rate-limit headers on an API route (wiring check)", async (t) => {
  const server = await start(createApp());
  t.after(() => server.close());

  // /api/auth/me is unauthenticated (401) but still passes the auth limiter,
  // which emits the RateLimit-* headers — proving the tier is wired into the
  // real app, not just the isolated tests above.
  const res = await fetch(server.url("/api/auth/me"));
  assert.equal(res.status, 401);
  assert.ok(res.headers.get("ratelimit-limit"), "the auth tier emits RateLimit-Limit");
  assert.ok(res.headers.get("ratelimit-policy"), "the auth tier emits RateLimit-Policy");
});
