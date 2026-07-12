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
  type PmUserRow,
  type ValidatedOidcIdentity,
} from "../dist/oidc.js";
import { providerAuthorizationError } from "../dist/routes/oidc.js";

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
  assert.match(app, /app\.use\("\/api\/auth", oidcRouter\)/);
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

interface FakeIdentityRow {
  issuer: string;
  subject: string;
  userId: string;
  email: string | null;
}

class FakeOidcDb {
  users: PmUserRow[] = [];
  identities: FakeIdentityRow[] = [];
  passwordMarkers: string[] = [];
  private nextId = 1;

  seedUser(email: string): PmUserRow {
    const user: PmUserRow = {
      id: `00000000-0000-0000-0000-${String(this.nextId++).padStart(12, "0")}`,
      email,
      display_name: "Existing User",
      is_admin: false,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    this.users.push(user);
    return user;
  }

  async query(sql: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
    if (normalized.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };

    if (normalized.includes("FROM pm_external_identities i")) {
      const mapping = this.identities.find(
        (row) => row.issuer === values[0] && row.subject === values[1],
      );
      return { rows: mapping ? [this.users.find((user) => user.id === mapping.userId)!] : [] };
    }
    if (normalized.startsWith("UPDATE pm_external_identities")) {
      const mapping = this.identities.find(
        (row) => row.issuer === values[0] && row.subject === values[1],
      );
      if (mapping) mapping.email = values[2] as string | null;
      return { rows: [] };
    }
    if (normalized.includes("FROM pm_users WHERE email = $1")) {
      const email = String(values[0]);
      const user = this.users.find((candidate) => candidate.email === email);
      return { rows: user ? [user] : [] };
    }
    if (normalized.startsWith("INSERT INTO pm_users")) {
      const email = String(values[0]);
      if (this.users.some((candidate) => candidate.email.toLowerCase() === email.toLowerCase())) {
        throw Object.assign(new Error("duplicate email"), { code: "23505" });
      }
      this.passwordMarkers.push(String(values[1]));
      const user = this.seedUser(email);
      user.display_name = values[2] as string;
      return { rows: [user] };
    }
    if (normalized.startsWith("INSERT INTO pm_external_identities")) {
      if (this.identities.some((row) =>
        (row.issuer === values[0] && row.subject === values[1]) ||
        (row.issuer === values[0] && row.userId === values[2])
      )) {
        throw Object.assign(new Error("duplicate identity"), { code: "23505" });
      }
      this.identities.push({
        issuer: values[0] as string,
        subject: values[1] as string,
        userId: values[2] as string,
        email: values[3] as string | null,
      });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in OIDC test double: ${normalized}`);
  }
}

function identity(overrides: Partial<ValidatedOidcIdentity> = {}): ValidatedOidcIdentity {
  return {
    issuer: "https://identity.example/",
    subject: "subject-1",
    email: "user@example.test",
    emailVerified: true,
    displayName: "OIDC User",
    ...overrides,
  };
}

test("external identity resolution auto-provisions once and is idempotent", async () => {
  const db = new FakeOidcDb();
  const first = await resolveExternalIdentity(db as any, identity());
  const second = await resolveExternalIdentity(db as any, identity({ displayName: "Changed Claim" }));
  assert.equal(second.id, first.id);
  assert.equal(db.users.length, 1);
  assert.equal(db.identities.length, 1);
  assert.equal(db.passwordMarkers.length, 1);
  assert.match(db.passwordMarkers[0], /^!oidc:/);
  assert.equal(db.passwordMarkers[0].startsWith("$2"), false);
  assert.equal(await bcrypt.compare("any-password", db.passwordMarkers[0]), false);
});

test("verified same-email identity links an existing account", async () => {
  const db = new FakeOidcDb();
  const existing = db.seedUser("user@example.test");
  const resolved = await resolveExternalIdentity(db as any, identity());
  assert.equal(resolved.id, existing.id);
  assert.equal(db.users.length, 1);
  assert.equal(db.identities[0].userId, existing.id);
});

test("unverified same-email collision is rejected", async () => {
  const db = new FakeOidcDb();
  db.seedUser("user@example.test");
  await assert.rejects(
    () => resolveExternalIdentity(db as any, identity({ emailVerified: false })),
    (error: unknown) => error instanceof OidcFlowError && error.code === "unverified_email_collision",
  );
  assert.equal(db.identities.length, 0);
});

test("OIDC identity without email receives a stable-domain synthetic local email", async () => {
  const db = new FakeOidcDb();
  const user = await resolveExternalIdentity(db as any, identity({ email: null, emailVerified: false }));
  assert.match(user.email, /^oidc-[a-f0-9]{32}@users\.invalid$/);
  assert.equal(user.display_name, "OIDC User");
});
