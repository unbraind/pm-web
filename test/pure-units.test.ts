/**
 * Genuine unit coverage for pm-web's pure and near-pure modules.
 *
 * The real-Postgres route suites cover these modules indirectly, but several
 * branches live behind inputs the HTTP tests never send — a request with no
 * credentials at all, a path parameter repeated into an array, a token stored
 * before encryption existed, a server booted with discrete `POSTGRES_*` vars
 * instead of `DATABASE_URL`. Those branches describe real behaviour the app
 * promises (token precedence, legacy-token migration, fail-fast configuration),
 * so each test here asserts the documented outcome rather than merely touching
 * a line.
 *
 * The token, guard and middleware cases run against a real Express probe app
 * (no database, no mocks): Express builds the genuine `Request`/`Response`/
 * `next` triple, so the functions under test see exactly the shape production
 * gives them. The truly pure helpers (`routeParam`, `isUuid`, the crypto pair,
 * `assertDbConfigured`) are called directly. Environment-dependent cases set
 * and restore the real `process.env` entry around the assertion.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import cookieParser from "cookie-parser";
import express, { type Express } from "express";

import { decryptSecret, encryptSecret } from "../src/crypto.ts";
import { assertDbConfigured } from "../src/db.ts";
import { extractToken, signToken, verifyToken } from "../src/auth.ts";
import { requireAuth, type AuthRequest } from "../src/middleware/auth.ts";
import {
  isUuid,
  requireUuidParams,
  routeParam,
  uuidParamGuard,
} from "../src/routes/route-params.ts";

/** A valid UUID v4 shape, used both as a fixture and as a counter-example seed. */
const VALID_UUID = "11111111-1111-4111-8111-111111111111";
/** A value PostgreSQL cannot cast to `uuid`, rejected by the shape guard. */
const MALFORMED_ID = "not-a-uuid";

/**
 * Boots a database-free Express app that wires the functions under test behind
 * real middleware slots, returning the running server's base URL. Closing the
 * server is the caller's responsibility.
 *
 * Each probe route answers a tiny JSON echo of what the function resolved, so a
 * test asserts the function's output rather than a side effect. `cookieParser`
 * is mounted so `extractToken` sees the same `req.cookies.pm_token` shape the
 * production app gives it.
 */
async function probeApp(): Promise<{ url: (path: string) => string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json());
  app.use(cookieParser());

  // Echoes the token `extractToken` resolved, exercising the full precedence
  // chain (header → cookie → query → none) against a genuine request.
  app.get("/token", (req, res) => {
    res.json({ token: extractToken(req) });
  });

  // `uuidParamGuard` mounted exactly as the route files mount it — via
  // `router.param`, the only slot Express invokes a 4-arg callback from — so
  // the 400/200 split is the production behaviour, not a hand-rolled approximation.
  const guardRouter = express.Router();
  guardRouter.param("id", uuidParamGuard("id"));
  guardRouter.get("/:id", (req, res) => {
    res.json({ ok: true, id: req.params.id });
  });
  app.use("/guard", guardRouter);

  // `requireUuidParams` mounted as router-level middleware, the form the sharing
  // router uses. The `/merge/:id` path validates the param; the `/merge` path
  // exercises the "skip a name absent from the matched route" arm.
  app.use("/merge/:id", requireUuidParams("id"));
  app.get("/merge/:id", (req, res) => {
    res.json({ ok: true, id: req.params.id });
  });
  app.get("/merge", requireUuidParams("id"), (req, res) => {
    res.json({ ok: true });
  });

  // `requireAuth` guarding a route that echoes the verified user, so a tampered
  // token exercises the middleware's `catch` (the 401 "Invalid or expired token"
  // path) and a valid token exercises the happy path.
  app.get("/me", requireAuth, (req: AuthRequest, res) => {
    res.json({ userId: req.user?.userId });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Reads an env var, used only to snapshot originals for guaranteed restoration.
 *
 * @param name Variable whose value (or absence) is being saved.
 * @returns The current string value, or `undefined` when unset.
 */
function env(name: string): string | undefined {
  return process.env[name];
}

// ─────────────────────────────────────────────────────────────────────────────
// routeParam: a repeated capture collapses to its first element; a missing
// param becomes "" rather than undefined. Both are documented contracts the
// call sites rely on to stay null-handling-free.
// ─────────────────────────────────────────────────────────────────────────────

test("routeParam: a repeated path parameter collapses to its first value", () => {
  // Express types a param as `string | string[]` because a repeated capture can
  // produce an array. Every caller wants one value, so the array collapses.
  assert.equal(routeParam({ params: { id: ["first", "second"] } }, "id"), "first");
});

test("routeParam: a missing parameter resolves to the empty string, not undefined", () => {
  assert.equal(routeParam({ params: {} }, "absent"), "");
});

test("routeParam: a present scalar parameter is returned unchanged", () => {
  assert.equal(routeParam({ params: { id: "scalar" } }, "id"), "scalar");
});

// ─────────────────────────────────────────────────────────────────────────────
// isUuid: shape-only validation that mirrors what PostgreSQL can cast. It must
// accept every version the DB accepts and reject everything the DB rejects, so
// the guard never lets a bad value through to SQL nor blocks a good one.
// ─────────────────────────────────────────────────────────────────────────────

test("isUuid: accepts canonical UUID shapes and rejects everything else", () => {
  assert.equal(isUuid(VALID_UUID), true);
  assert.equal(isUuid("00000000-0000-0000-0000-000000000000"), true);
  assert.equal(isUuid(MALFORMED_ID), false);
  assert.equal(isUuid("111111111111111111111111111111111"), false);
  assert.equal(isUuid(""), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// requireUuidParams / uuidParamGuard: a malformed identifier is answered 400
// before any SQL runs, a valid one passes through, and a name that is absent
// from the matched route is skipped (not every identifier in this API is a
// UUID, so the guard must not over-reach).
// ─────────────────────────────────────────────────────────────────────────────

test("uuidParamGuard: a malformed id is 400, a well-formed id passes through", async () => {
  const server = await probeApp();
  try {
    const bad = await fetch(server.url(`/guard/${MALFORMED_ID}`));
    assert.equal(bad.status, 400);

    const good = await fetch(server.url(`/guard/${VALID_UUID}`));
    assert.equal(good.status, 200);
    const body = (await good.json()) as { ok: boolean; id: string };
    assert.equal(body.ok, true);
    assert.equal(body.id, VALID_UUID);
  } finally {
    await server.close();
  }
});

test("requireUuidParams: rejects a malformed id and skips a name absent from the route", async () => {
  const server = await probeApp();
  try {
    // Malformed id on the validating route → 400.
    const bad = await fetch(server.url(`/merge/${MALFORMED_ID}`));
    assert.equal(bad.status, 400);

    // Valid id passes the guard and reaches the handler.
    const good = await fetch(server.url(`/merge/${VALID_UUID}`));
    assert.equal(good.status, 200);

    // The `/merge` route carries no `:id`, so the guard's `continue` on an
    // undefined param must let the request through rather than 400.
    const noParam = await fetch(server.url("/merge"));
    assert.equal(noParam.status, 200);
  } finally {
    await server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// extractToken: header beats cookie beats query beats nothing. The calendar
// feed relies on the query fallback (it cannot send a header or cookie), and
// the API relies on the header taking precedence over a stale cookie.
// ─────────────────────────────────────────────────────────────────────────────

test("extractToken: Authorization header takes precedence over cookie and query", async () => {
  const server = await probeApp();
  try {
    const res = await fetch(server.url("/token?token=tok-query"), {
      headers: {
        authorization: "Bearer tok-header",
        cookie: "pm_token=tok-cookie",
      },
    });
    const body = (await res.json()) as { token: string | null };
    assert.equal(body.token, "tok-header");
  } finally {
    await server.close();
  }
});

test("extractToken: the pm_token cookie takes precedence over the query fallback", async () => {
  const server = await probeApp();
  try {
    const res = await fetch(server.url("/token?token=tok-query"), {
      headers: { cookie: "pm_token=tok-cookie" },
    });
    const body = (await res.json()) as { token: string | null };
    assert.equal(body.token, "tok-cookie");
  } finally {
    await server.close();
  }
});

test("extractToken: a query token authenticates the iCal feed when no header or cookie is present", async () => {
  const server = await probeApp();
  try {
    const res = await fetch(server.url("/token?token=tok-query"));
    const body = (await res.json()) as { token: string | null };
    assert.equal(body.token, "tok-query");
  } finally {
    await server.close();
  }
});

test("extractToken: returns null when no token is supplied anywhere", async () => {
  const server = await probeApp();
  try {
    const res = await fetch(server.url("/token"));
    const body = (await res.json()) as { token: string | null };
    assert.equal(body.token, null);
  } finally {
    await server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// signToken / verifyToken: a token round-trips, and a tampered token is
// rejected. The middleware's 401 path depends on verifyToken throwing, so the
// tampered case is asserted directly.
// ─────────────────────────────────────────────────────────────────────────────

test("verifyToken: a signed token round-trips and a tampered token is rejected", () => {
  const token = signToken({ userId: "user-1", email: "one@e.test" });
  // `jsonwebtoken` injects `iat`/`exp`, so assert the carried identity rather
  // than the whole object.
  const decoded = verifyToken(token);
  assert.equal(decoded.userId, "user-1");
  assert.equal(decoded.email, "one@e.test");

  // Flip the last character of the signature so the HMAC no longer verifies.
  const last = token.slice(-1);
  const tampered = `${token.slice(0, -1)}${last === "a" ? "b" : "a"}`;
  assert.throws(() => verifyToken(tampered));
});

test("requireAuth: a tampered token is answered 401 with an invalid-token message", async () => {
  const server = await probeApp();
  try {
    const token = signToken({ userId: "user-1", email: "one@e.test" });
    const last = token.slice(-1);
    const tampered = `${token.slice(0, -1)}${last === "a" ? "b" : "a"}`;
    const res = await fetch(server.url("/me"), {
      headers: { cookie: `pm_token=${tampered}` },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /invalid or expired/i);
  } finally {
    await server.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// encryptSecret / decryptSecret: a secret round-trips through authenticated
// encryption; a null/empty store reads back null; a pre-encryption legacy value
// is returned verbatim (migration); a truncated envelope is rejected; and a
// missing key fails loudly rather than encrypting under a default.
// ─────────────────────────────────────────────────────────────────────────────

test("crypto: a secret round-trips through authenticated encryption", () => {
  const stored = encryptSecret("ghp_secret_token");
  // The envelope is prefixed so a stored value is self-describing.
  assert.ok(stored.startsWith("pmweb:v1:"));
  assert.equal(decryptSecret(stored), "ghp_secret_token");
  // Each encryption uses a fresh IV, so two stores of the same secret differ.
  assert.notEqual(encryptSecret("ghp_secret_token"), stored);
});

test("crypto: a null or empty store reads back null", () => {
  assert.equal(decryptSecret(null), null);
  assert.equal(decryptSecret(undefined), null);
  assert.equal(decryptSecret(""), null);
});

test("crypto: a pre-encryption legacy value is returned verbatim", () => {
  // A value stored before encryption existed has no prefix; decrypting it must
  // hand back the plaintext so an upgrade never locks users out of their token.
  assert.equal(decryptSecret("legacy-plaintext-token"), "legacy-plaintext-token");
});

test("crypto: a truncated envelope is rejected as malformed", () => {
  // A prefix-less number of fields cannot carry iv/tag/ciphertext.
  assert.throws(() => decryptSecret("pmweb:v1:only-two-parts"));
});

test("crypto: encrypting without a usable secret key fails loudly", () => {
  const savedKey = env("PM_WEB_SECRET_KEY");
  const savedJwt = env("JWT_SECRET");
  delete process.env.PM_WEB_SECRET_KEY;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => encryptSecret("x"), /at least 32 characters/i);
  } finally {
    if (savedKey !== undefined) process.env.PM_WEB_SECRET_KEY = savedKey;
    if (savedJwt !== undefined) process.env.JWT_SECRET = savedJwt;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// assertDbConfigured: the server fails fast with guidance when no database is
// configured. DATABASE_URL is the primary form; discrete POSTGRES_* vars are
// the documented alternative; and the absence of both throws rather than
// hanging on a DNS lookup seconds later.
// ─────────────────────────────────────────────────────────────────────────────

test("assertDbConfigured: accepts a configured DATABASE_URL", () => {
  const saved = env("DATABASE_URL");
  const savedHost = env("POSTGRES_HOST");
  const savedDb = env("POSTGRES_DB");
  process.env.DATABASE_URL = "postgres://u:p@db.example:5432/pmweb";
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_DB;
  try {
    assert.doesNotThrow(() => assertDbConfigured());
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    else delete process.env.DATABASE_URL;
    if (savedHost !== undefined) process.env.POSTGRES_HOST = savedHost;
    if (savedDb !== undefined) process.env.POSTGRES_DB = savedDb;
  }
});

test("assertDbConfigured: accepts discrete POSTGRES_HOST + POSTGRES_DB vars", () => {
  const savedUrl = env("DATABASE_URL");
  const savedHost = env("POSTGRES_HOST");
  const savedDb = env("POSTGRES_DB");
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_HOST = "db.example";
  process.env.POSTGRES_DB = "pmweb";
  try {
    assert.doesNotThrow(() => assertDbConfigured());
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    else delete process.env.DATABASE_URL;
    if (savedHost !== undefined) process.env.POSTGRES_HOST = savedHost;
    else delete process.env.POSTGRES_HOST;
    if (savedDb !== undefined) process.env.POSTGRES_DB = savedDb;
    else delete process.env.POSTGRES_DB;
  }
});

test("assertDbConfigured: throws with actionable guidance when no database is configured", () => {
  const savedUrl = env("DATABASE_URL");
  const savedHost = env("POSTGRES_HOST");
  const savedDb = env("POSTGRES_DB");
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_DB;
  try {
    assert.throws(() => assertDbConfigured(), /DATABASE_URL is not set/i);
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    else delete process.env.DATABASE_URL;
    if (savedHost !== undefined) process.env.POSTGRES_HOST = savedHost;
    else delete process.env.POSTGRES_HOST;
    if (savedDb !== undefined) process.env.POSTGRES_DB = savedDb;
    else delete process.env.POSTGRES_DB;
  }
});
