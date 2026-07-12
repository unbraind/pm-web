import crypto from "node:crypto";
import type { PoolClient } from "pg";

const OIDC_REQUIRED_ENV = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
  "OIDC_COOKIE_SECRET",
] as const;

export const OIDC_STATE_COOKIE = "pm_oidc_state";
export const OIDC_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export interface OidcSettings {
  enabled: true;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  cookieSecret: string;
  requireVerifiedEmail: boolean;
}

export interface OidcDisabledSettings {
  enabled: false;
  reason?: string;
}

export type ResolvedOidcSettings = OidcSettings | OidcDisabledSettings;

export interface OidcStatePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

export interface OidcClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
}

export interface ValidatedOidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface PmUserRow {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
}

type TransactionClient = Pick<PoolClient, "query">;

export class OidcConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigurationError";
  }
}

export class OidcFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "OidcFlowError";
  }
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (["1", "true", "yes"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.trim().toLowerCase())) return false;
  throw new OidcConfigurationError(`${name} must be true or false when set.`);
}

function validateHttpsUrl(raw: string, name: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcConfigurationError(`${name} must be an absolute URL.`);
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new OidcConfigurationError(`${name} must not include credentials, a query, or a fragment.`);
  }
  if (production && url.protocol !== "https:") {
    throw new OidcConfigurationError(`${name} must use HTTPS in production.`);
  }
  if (!production && !["http:", "https:"].includes(url.protocol)) {
    throw new OidcConfigurationError(`${name} must use HTTP or HTTPS.`);
  }
  return url.href;
}

/** Resolve optional OIDC configuration without exposing any configured value. */
export function resolveOidcSettings(env: NodeJS.ProcessEnv = process.env): ResolvedOidcSettings {
  const present = OIDC_REQUIRED_ENV.filter((name) => Boolean(env[name]?.trim()));
  if (present.length === 0) return { enabled: false };

  const missing = OIDC_REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    const message = `OIDC configuration is incomplete; missing ${missing.join(", ")}.`;
    if (env.NODE_ENV === "production") throw new OidcConfigurationError(message);
    return { enabled: false, reason: message };
  }

  try {
    const production = env.NODE_ENV === "production";
    const cookieSecret = env.OIDC_COOKIE_SECRET!.trim();
    if (Buffer.byteLength(cookieSecret, "utf8") < 32) {
      throw new OidcConfigurationError("OIDC_COOKIE_SECRET must be at least 32 bytes.");
    }
    if (
      cookieSecret === env.OIDC_CLIENT_SECRET!.trim() ||
      (env.JWT_SECRET && cookieSecret === env.JWT_SECRET)
    ) {
      throw new OidcConfigurationError(
        "OIDC_COOKIE_SECRET must be independent from OIDC_CLIENT_SECRET and JWT_SECRET.",
      );
    }

    const scopes = (env.OIDC_SCOPES || "openid profile email")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (!scopes.includes("openid")) {
      throw new OidcConfigurationError("OIDC_SCOPES must include openid.");
    }

    return {
      enabled: true,
      issuer: validateHttpsUrl(env.OIDC_ISSUER!, "OIDC_ISSUER", production),
      clientId: env.OIDC_CLIENT_ID!.trim(),
      clientSecret: env.OIDC_CLIENT_SECRET!.trim(),
      redirectUri: validateHttpsUrl(env.OIDC_REDIRECT_URI!, "OIDC_REDIRECT_URI", production),
      scopes: scopes.join(" "),
      cookieSecret,
      requireVerifiedEmail: parseBoolean(
        env.OIDC_REQUIRE_VERIFIED_EMAIL,
        "OIDC_REQUIRE_VERIFIED_EMAIL",
      ),
    };
  } catch (error) {
    if (env.NODE_ENV === "production") throw error;
    return {
      enabled: false,
      reason: error instanceof Error ? error.message : "OIDC configuration is invalid.",
    };
  }
}

/** Production startup gate. OIDC remains disabled when none of its variables are set. */
export function assertOidcConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  void resolveOidcSettings(env);
}

export function oidcPublicConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  label: "OpenID Connect";
} {
  return { enabled: resolveOidcSettings(env).enabled, label: "OpenID Connect" };
}

function sign(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function encodeOidcStateCookie(payload: OidcStatePayload, secret: string): string {
  const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${value}.${sign(value, secret)}`;
}

export function decodeOidcStateCookie(
  cookie: string | undefined,
  secret: string,
  now = Date.now(),
): OidcStatePayload {
  if (!cookie) throw new OidcFlowError("missing_state_cookie", "OIDC state cookie is missing.");
  const [value, signature, extra] = cookie.split(".");
  if (!value || !signature || extra) {
    throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
  }
  const expected = sign(value, secret);
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
  }
  if (!payload || typeof payload !== "object") {
    throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
  }
  const candidate = payload as Partial<OidcStatePayload>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.nonce !== "string" ||
    typeof candidate.codeVerifier !== "string" ||
    typeof candidate.createdAt !== "number"
  ) {
    throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
  }
  if (candidate.createdAt > now + 30_000 || now - candidate.createdAt > OIDC_STATE_MAX_AGE_MS) {
    throw new OidcFlowError("expired_state_cookie", "OIDC login request has expired.");
  }
  return candidate as OidcStatePayload;
}

export function pkceChallenge(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}

export function createOidcState(now = Date.now()): OidcStatePayload & { codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  return {
    state: crypto.randomBytes(32).toString("base64url"),
    nonce: crypto.randomBytes(32).toString("base64url"),
    codeVerifier,
    codeChallenge: pkceChallenge(codeVerifier),
    createdAt: now,
  };
}

export function oidcGrantChecks(flow: OidcStatePayload): {
  pkceCodeVerifier: string;
  expectedState: string;
  expectedNonce: string;
  idTokenExpected: true;
} {
  return {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  };
}

function requiredString(value: unknown, claim: string): string {
  if (typeof value !== "string" || !value) {
    throw new OidcFlowError("invalid_id_token", `ID token ${claim} claim is invalid.`);
  }
  return value;
}

/**
 * Defense-in-depth claim checks after openid-client has verified the ID token
 * signature through discovery/JWKS and applied its protocol validation.
 */
export function validateOidcClaims(
  claims: OidcClaims,
  settings: Pick<OidcSettings, "issuer" | "clientId" | "requireVerifiedEmail">,
  expectedNonce: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): ValidatedOidcIdentity {
  const issuer = requiredString(claims.iss, "iss");
  if (issuer !== settings.issuer) {
    throw new OidcFlowError("invalid_issuer", "ID token issuer does not match configuration.");
  }
  const subject = requiredString(claims.sub, "sub");
  const nonce = requiredString(claims.nonce, "nonce");
  if (nonce !== expectedNonce) {
    throw new OidcFlowError("invalid_nonce", "ID token nonce does not match the login request.");
  }

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(settings.clientId)) {
    throw new OidcFlowError("invalid_audience", "ID token audience does not include this client.");
  }
  if (audience.length > 1 && claims.azp !== settings.clientId) {
    throw new OidcFlowError("invalid_audience", "ID token authorized party is invalid.");
  }

  if (typeof claims.exp !== "number" || claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new OidcFlowError("expired_id_token", "ID token has expired.");
  }
  if (typeof claims.iat !== "number" || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new OidcFlowError("invalid_id_token_time", "ID token issue time is invalid.");
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new OidcFlowError("invalid_id_token_time", "ID token is not yet valid.");
  }

  const email = typeof claims.email === "string" && claims.email.trim()
    ? claims.email.trim().toLowerCase()
    : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OidcFlowError("invalid_email_claim", "ID token email claim is invalid.");
  }
  const emailVerified = claims.email_verified === true;
  if (settings.requireVerifiedEmail && (!email || !emailVerified)) {
    throw new OidcFlowError(
      "verified_email_required",
      "The identity provider must supply a verified email address.",
      403,
    );
  }

  const displayNameClaim = [claims.name, claims.preferred_username]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  return {
    issuer,
    subject,
    email,
    emailVerified,
    displayName: displayNameClaim?.trim() || null,
  };
}

function syntheticOidcEmail(issuer: string, subject: string): string {
  const digest = crypto.createHash("sha256").update(`${issuer}\0${subject}`).digest("hex");
  return `oidc-${digest.slice(0, 32)}@users.invalid`;
}

function nonLoginablePasswordMarker(): string {
  return `!oidc:${crypto.randomBytes(32).toString("base64url")}`;
}

async function queryUser(client: TransactionClient, sql: string, values: unknown[]): Promise<PmUserRow | null> {
  const result = await client.query<PmUserRow>(sql, values);
  return result.rows[0] ?? null;
}

/** Transactionally resolve, link, or provision the local user for an OIDC identity. */
export async function resolveExternalIdentity(
  client: TransactionClient,
  identity: ValidatedOidcIdentity,
): Promise<PmUserRow> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `oidc:${identity.issuer}:${identity.subject}`,
    ]);

    const mapped = await queryUser(
      client,
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at
         FROM pm_external_identities i
         JOIN pm_users u ON u.id = i.user_id
        WHERE i.issuer = $1 AND i.subject = $2
        FOR UPDATE`,
      [identity.issuer, identity.subject],
    );
    if (mapped) {
      await client.query(
        `UPDATE pm_external_identities
            SET email = $3, updated_at = NOW()
          WHERE issuer = $1 AND subject = $2`,
        [identity.issuer, identity.subject, identity.email],
      );
      await client.query("COMMIT");
      return mapped;
    }

    let user: PmUserRow | null = null;
    if (identity.email) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `oidc-email:${identity.email}`,
      ]);
      user = await queryUser(
        client,
        `SELECT id, email, display_name, is_admin, created_at
           FROM pm_users WHERE lower(email) = lower($1) FOR UPDATE`,
        [identity.email],
      );
      if (user && !identity.emailVerified) {
        throw new OidcFlowError(
          "unverified_email_collision",
          "An account with this email already exists and the provider did not verify it.",
          409,
        );
      }
    }

    if (!user) {
      const email = identity.email ?? syntheticOidcEmail(identity.issuer, identity.subject);
      const displayName = identity.displayName ?? identity.email?.split("@")[0] ?? "OIDC user";
      user = await queryUser(
        client,
        `INSERT INTO pm_users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, is_admin, created_at`,
        [email, nonLoginablePasswordMarker(), displayName],
      );
      if (!user) throw new Error("OIDC user provisioning returned no user.");
    }

    await client.query(
      `INSERT INTO pm_external_identities (issuer, subject, user_id, email)
       VALUES ($1, $2, $3, $4)`,
      [identity.issuer, identity.subject, user.id, identity.email],
    );
    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      throw new OidcFlowError(
        "identity_collision",
        "This external identity conflicts with an existing account mapping.",
        409,
      );
    }
    throw error;
  }
}
