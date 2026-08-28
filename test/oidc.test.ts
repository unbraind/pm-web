import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import bcrypt from "bcryptjs";
import {
  createOidcState,
  decodeOidcStateCookie,
  encodeOidcStateCookie,
  OIDC_STATE_MAX_AGE_MS,
  oidcGrantChecks,
  oidcPublicConfig,
  OidcConfigurationError,
  OidcFlowError,
  pkceChallenge,
  resolveExternalIdentity,
  resolveOidcSettings,
  validateOidcClaims,
  type ValidatedOidcIdentity,
} from "../src/oidc.ts";
import { providerAuthorizationError } from "../src/routes/oidc.ts";
import { pool } from "../src/db.ts";
import { ensureSchema, uniqueEmail, uniqueSlug } from "./helpers/pg-harness.ts";

const cookieSecret = "cookie-secret-that-is-at-least-thirty-two-bytes";

function fullEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    OIDC_ISSUER: "https://identity.example/",
    OIDC_CLIENT_ID: "pm-web-test",
    OIDC_CLIENT_SECRET: "client-secret-value",
    OIDC_REDIRECT_URI: "https://pm-web.example/api/auth/oidc/callback",
    OIDC_COOKIE_SECRET: cookieSecret,
    ...overrides,
  };
}

test("OIDC is disabled by default and partial production config fails closed", () => {
  assert.deepEqual(resolveOidcSettings({ NODE_ENV: "production" }), { enabled: false });
  assert.throws(
    () => resolveOidcSettings({ NODE_ENV: "production", OIDC_ISSUER: "https://identity.example/" }),
    (error: unknown) => error instanceof OidcConfigurationError && /OIDC_CLIENT_ID/.test(error.message),
  );

  const partialDevelopment = resolveOidcSettings({
    NODE_ENV: "development",
    OIDC_ISSUER: "http://127.0.0.1:9000/",
  });
  assert.equal(partialDevelopment.enabled, false);
});

test("OIDC full config uses generic defaults and public config leaks no secrets", () => {
  const settings = resolveOidcSettings(fullEnv());
  assert.equal(settings.enabled, true);
  if (!settings.enabled) return;
  assert.equal(settings.scopes, "openid profile email");
  assert.equal(settings.requireVerifiedEmail, false);

  const publicJson = JSON.stringify(oidcPublicConfig(fullEnv()));
  assert.equal(publicJson, '{"enabled":true,"label":"OpenID Connect"}');
  assert.equal(publicJson.includes("client-secret-value"), false);
  assert.equal(publicJson.includes(cookieSecret), false);
  assert.equal(publicJson.includes("identity.example"), false);
});

test("root OIDC issuer normalization matches providers that omit the trailing slash", () => {
  const settings = resolveOidcSettings(fullEnv({ OIDC_ISSUER: "https://accounts.example" }));
  assert.equal(settings.enabled, true);
  if (!settings.enabled) return;
  assert.equal(settings.issuer, "https://accounts.example");
  const now = 1_750_000_000;
  assert.doesNotThrow(() => validateOidcClaims({
    iss: "https://accounts.example",
    sub: "subject",
    aud: settings.clientId,
    exp: now + 300,
    iat: now,
    nonce: "nonce",
  }, settings, "nonce", now));
});

test("OIDC production config requires HTTPS, openid scope, and a dedicated-length cookie secret", () => {
  assert.throws(() => resolveOidcSettings(fullEnv({ OIDC_ISSUER: "http://identity.example/" })));
  assert.throws(() => resolveOidcSettings(fullEnv({ OIDC_SCOPES: "profile email" })));
  assert.throws(() => resolveOidcSettings(fullEnv({ OIDC_COOKIE_SECRET: "too-short" })));
  assert.throws(() => resolveOidcSettings(fullEnv({
    OIDC_COOKIE_SECRET: "same-secret-that-is-long-enough-for-both-values",
    OIDC_CLIENT_SECRET: "same-secret-that-is-long-enough-for-both-values",
  })));
});

test("signed OIDC state cookie detects tampering and expiry", () => {
  const now = 1_750_000_000_000;
  const flow = createOidcState(now);
  const cookie = encodeOidcStateCookie(flow, cookieSecret);
  const decoded = decodeOidcStateCookie(cookie, cookieSecret, now + 1_000);
  assert.equal(decoded.state, flow.state);
  assert.equal(decoded.nonce, flow.nonce);
  assert.equal(decoded.codeVerifier, flow.codeVerifier);

  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;
  assert.throws(
    () => decodeOidcStateCookie(tampered, cookieSecret, now + 1_000),
    (error: unknown) => error instanceof OidcFlowError && error.code === "invalid_state_cookie",
  );
  assert.throws(
    () => decodeOidcStateCookie(cookie, cookieSecret, now + OIDC_STATE_MAX_AGE_MS + 1),
    (error: unknown) => error instanceof OidcFlowError && error.code === "expired_state_cookie",
  );
});

test("OIDC login state uses a valid PKCE S256 challenge", () => {
  const flow = createOidcState();
  const expected = crypto.createHash("sha256").update(flow.codeVerifier).digest("base64url");
  assert.equal(flow.codeChallenge, expected);
  assert.equal(pkceChallenge(flow.codeVerifier), expected);
  assert.notEqual(flow.state, flow.nonce);
  assert.deepEqual(oidcGrantChecks(flow), {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });
});

test("OIDC provider callback errors are safe and distinguish user cancellation", () => {
  const denied = providerAuthorizationError("access_denied");
  assert.equal(denied?.code, "provider_access_denied");
  assert.equal(denied?.status, 403);
  assert.match(denied?.message ?? "", /canceled or denied/);

  const providerFailure = providerAuthorizationError("temporarily_unavailable");
  assert.equal(providerFailure?.code, "provider_error");
  assert.equal(providerFailure?.message.includes("temporarily_unavailable"), false);
  assert.equal(providerAuthorizationError(undefined), null);
});

test("general schema includes the idempotent external identity contract", () => {
  const schema = readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");
  const runtimeSchema = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const authView = readFileSync(new URL("../public/src/views/auth.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const oidcRoute = readFileSync(new URL("../src/routes/oidc.ts", import.meta.url), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pm_external_identities/);
  assert.match(schema, /PRIMARY KEY\(issuer, subject\)/);
  assert.match(schema, /UNIQUE\(issuer, user_id\)/);
  assert.match(schema, /user_id UUID NOT NULL REFERENCES pm_users\(id\) ON DELETE CASCADE/);
  assert.match(runtimeSchema, /CREATE TABLE IF NOT EXISTS pm_external_identities/);
  // The OIDC router must sit at /api/auth behind the auth limiter. Matching one
  // exact mount line asserted the arrangement rather than the property, and
  // broke on a refactor that preserved it: the limiter now mounts on the prefix
  // once and the routers mount behind it, because repeating it on the prefix
  // and again on a nested path charged one request twice.
  assert.match(app, /app\.use\("\/api\/auth", limiters\.auth\);/);
  assert.match(app, /app\.use\("\/api\/auth", oidcRouter\);/);
  // And the property that fix established: no path is given the same limiter
  // more than once, so every published budget is the enforced one.
  const mounts = [...app.matchAll(/app\.use\("([^"]+)",([^)]*)\)/g)]
    .map(([, path, rest]) => ({
      path,
      limiters: [...rest.matchAll(/limiters\.(\w+)/g)].map(([, tier]) => tier),
    }));
  for (const tier of ["auth", "read", "write", "admin"]) {
    const paths = mounts.filter((m) => m.limiters.includes(tier)).map((m) => m.path);
    assert.equal(
      new Set(paths).size,
      paths.length,
      `the ${tier} limiter is mounted more than once on the same path: ${paths.join(", ")}`,
    );
    for (const outer of paths) {
      for (const inner of paths) {
        assert.ok(
          outer === inner || !inner.startsWith(`${outer}/`),
          `the ${tier} limiter guards both ${outer} and the nested ${inner}, so a nested request is counted twice`,
        );
      }
    }
  }
  assert.match(server, /assertOidcConfiguration\(\)/);
  assert.match(authView, /\/auth\/oidc\/config/);
  assert.match(authView, /\/api\/auth\/oidc\/start/);
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.equal(oidcRoute.match(/\bdiscovery\(/g)?.length, 1, "provider metadata should be fetched once");
});

test("ID token claim validation enforces issuer, audience, nonce, and time", () => {
  const now = 1_750_000_000;
  const settings = {
    issuer: "https://identity.example/",
    clientId: "pm-web-test",
    requireVerifiedEmail: false,
  };
  const claims = {
    iss: settings.issuer,
    sub: "subject-1",
    aud: settings.clientId,
    exp: now + 300,
    iat: now,
    nonce: "expected-nonce",
    email: "User@Example.test",
    email_verified: true,
    name: "Example User",
  };
  const identity = validateOidcClaims(claims, settings, "expected-nonce", now);
  assert.equal(identity.email, "user@example.test");

  assert.throws(
    () => validateOidcClaims({ ...claims, iss: "https://other.example/" }, settings, "expected-nonce", now),
    (error: unknown) => error instanceof OidcFlowError && error.code === "invalid_issuer",
  );
  assert.throws(
    () => validateOidcClaims({ ...claims, aud: "another-client" }, settings, "expected-nonce", now),
    (error: unknown) => error instanceof OidcFlowError && error.code === "invalid_audience",
  );
  assert.throws(
    () => validateOidcClaims({ ...claims, nonce: "wrong" }, settings, "expected-nonce", now),
    (error: unknown) => error instanceof OidcFlowError && error.code === "invalid_nonce",
  );
  assert.throws(
    () => validateOidcClaims({ ...claims, exp: now - 61 }, settings, "expected-nonce", now),
    (error: unknown) => error instanceof OidcFlowError && error.code === "expired_id_token",
  );
});

test("verified email can be required for every OIDC identity", () => {
  const now = 1_750_000_000;
  assert.throws(
    () => validateOidcClaims(
      {
        iss: "https://identity.example/",
        sub: "subject-1",
        aud: "pm-web-test",
        exp: now + 300,
        iat: now,
        nonce: "nonce",
        email: "user@example.test",
        email_verified: false,
      },
      { issuer: "https://identity.example/", clientId: "pm-web-test", requireVerifiedEmail: true },
      "nonce",
      now,
    ),
    (error: unknown) => error instanceof OidcFlowError && error.code === "verified_email_required",
  );
});
/**
 * Real-Postgres coverage for `resolveExternalIdentity` in `src/oidc.ts`.
 *
 * These tests replace the former in-memory `FakeOidcDb` double with the live
 * `pg.Pool`: `resolveExternalIdentity` runs its own `BEGIN`/`COMMIT`/`ROLLBACK`
 * and `pg_advisory_xact_lock` against a real database, so a wrong JOIN or a
 * missing uniqueness guard fails the test instead of being masked by a
 * hand-rolled fake. Each test mints a globally-unique issuer/subject/email so
 * concurrent test files sharing the database never collide.
 */

function makeIdentity(): ValidatedOidcIdentity {
  return {
    issuer: "https://identity.example/",
    subject: uniqueSlug("subject"),
    email: uniqueEmail("oidcuser"),
    emailVerified: true,
    displayName: "OIDC User",
  };
}

test("external identity resolution auto-provisions once and is idempotent", async () => {
  await ensureSchema();
  const base = makeIdentity();
  const client = await pool.connect();
  try {
    const first = await resolveExternalIdentity(client, base);
    const second = await resolveExternalIdentity(client, { ...base, displayName: "Changed Claim" });
    assert.equal(second.id, first.id);

    const users = await pool.query(
      `SELECT COUNT(*)::int AS count FROM pm_users WHERE email = $1`,
      [base.email],
    );
    assert.equal((users.rows[0] as { count: number }).count, 1);

    const identities = await pool.query(
      `SELECT user_id FROM pm_external_identities WHERE issuer = $1 AND subject = $2`,
      [base.issuer, base.subject],
    );
    assert.equal(identities.rows.length, 1);
    assert.equal((identities.rows[0] as { user_id: string }).user_id, first.id);

    const stored = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM pm_users WHERE id = $1`,
      [first.id],
    );
    const marker = (stored.rows[0] as { password_hash: string }).password_hash;
    assert.match(marker, /^!oidc:/);
    assert.equal(marker.startsWith("$2"), false);
    assert.equal(await bcrypt.compare("any-password", marker), false);
  } finally {
    client.release();
  }
});

test("verified same-email identity links an existing account", async () => {
  await ensureSchema();
  const base = makeIdentity();
  // Pre-create a local account with the same (verified) email.
  const existing = await pool.query<{ id: string }>(
    `INSERT INTO pm_users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [base.email],
  );
  const existingId = (existing.rows[0] as { id: string }).id;

  const client = await pool.connect();
  try {
    const resolved = await resolveExternalIdentity(client, base);
    assert.equal(resolved.id, existingId);

    const identities = await pool.query(
      `SELECT user_id FROM pm_external_identities WHERE issuer = $1 AND subject = $2`,
      [base.issuer, base.subject],
    );
    assert.equal(identities.rows.length, 1);
    assert.equal((identities.rows[0] as { user_id: string }).user_id, existingId);
  } finally {
    client.release();
  }
});

test("unverified same-email collision is rejected", async () => {
  await ensureSchema();
  const base = makeIdentity();
  await pool.query(
    `INSERT INTO pm_users (email, password_hash) VALUES ($1, 'x')`,
    [base.email],
  );

  const client = await pool.connect();
  try {
    await assert.rejects(
      () => resolveExternalIdentity(client, { ...base, emailVerified: false }),
      (error: unknown) => error instanceof OidcFlowError && error.code === "unverified_email_collision",
    );
    const identities = await pool.query(
      `SELECT COUNT(*)::int AS count FROM pm_external_identities WHERE issuer = $1 AND subject = $2`,
      [base.issuer, base.subject],
    );
    assert.equal((identities.rows[0] as { count: number }).count, 0);
  } finally {
    client.release();
  }
});

test("OIDC identity without email receives a stable-domain synthetic local email", async () => {
  await ensureSchema();
  const base = makeIdentity();
  const client = await pool.connect();
  try {
    const user = await resolveExternalIdentity(client, { ...base, email: null, emailVerified: false });
    assert.match(user.email, /^oidc-[a-f0-9]{32}@users\.invalid$/);
    assert.equal(user.display_name, "OIDC User");
  } finally {
    client.release();
  }
});