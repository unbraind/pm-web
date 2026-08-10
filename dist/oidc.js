import crypto from "node:crypto";
const OIDC_REQUIRED_ENV = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
    "OIDC_COOKIE_SECRET",
];
/** Name of the browser cookie that carries the signed OIDC login state. */
export const OIDC_STATE_COOKIE = "pm_oidc_state";
/** Maximum age (ms) an OIDC login state cookie is considered valid: ten minutes. */
export const OIDC_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
/**
 * Error raised when OpenID Connect is misconfigured (missing or invalid
 * environment variables). In production {@link resolveOidcSettings} throws it
 * at startup; in development the bad config is instead reported as disabled.
 */
export class OidcConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = "OidcConfigurationError";
    }
}
/**
 * Error raised for a recoverable failure during an OpenID Connect login flow.
 * Carries a machine-readable `code` (surfaced to the client) and an HTTP
 * `status`, so the route layer can map it directly to a JSON error response.
 */
export class OidcFlowError extends Error {
    /** Machine-readable error code returned to the browser, e.g. `state_mismatch`. */
    code;
    /** HTTP status code to use when rendering this error as a response. */
    status;
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = "OidcFlowError";
    }
}
/**
 * Parse an environment variable as a boolean, used for OIDC toggle flags.
 *
 * An unset or blank value returns `false`; `1/true/yes` (case-insensitive)
 * returns `true` and `0/false/no` returns `false`. Any other value throws an
 * {@link OidcConfigurationError}, so a typo is caught at startup rather than
 * silently behaving as `false`.
 *
 * @param value - The raw environment string, or `undefined`.
 * @param name - Variable name, used in the thrown message.
 * @returns The parsed boolean.
 */
function parseBoolean(value, name) {
    if (value === undefined || value.trim() === "")
        return false;
    if (["1", "true", "yes"].includes(value.trim().toLowerCase()))
        return true;
    if (["0", "false", "no"].includes(value.trim().toLowerCase()))
        return false;
    throw new OidcConfigurationError(`${name} must be true or false when set.`);
}
/**
 * Validate and canonicalize an HTTPS (or, outside production, HTTP) URL.
 *
 * Throws an {@link OidcConfigurationError} when the value is not an absolute
 * URL, or carries credentials, a query, or a fragment. HTTPS is required in
 * production; HTTP is allowed only in development. A URL whose path is just
 * `/` is canonicalized to its origin (so issuer and verified `iss` agree even
 * for providers like Google that publish a slash-less issuer); any other path
 * is preserved verbatim.
 *
 * @param raw - The raw URL string from configuration.
 * @param name - Setting name, used in thrown messages.
 * @param production - Whether the HTTPS requirement is enforced.
 * @returns The canonicalized URL string.
 */
function validateHttpsUrl(raw, name, production) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
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
    // URL.href adds "/" to a bare origin, while several conforming providers
    // (including Google) publish an issuer without that slash. Preserve exact
    // path-based issuers, but canonicalize a root issuer to URL.origin so the
    // configured value and verified `iss` claim use the same representation.
    return url.pathname === "/" ? url.origin : url.href;
}
/** Resolve optional OIDC configuration without exposing any configured value. */
export function resolveOidcSettings(env = process.env) {
    const present = OIDC_REQUIRED_ENV.filter((name) => Boolean(env[name]?.trim()));
    if (present.length === 0)
        return { enabled: false };
    const missing = OIDC_REQUIRED_ENV.filter((name) => !env[name]?.trim());
    if (missing.length > 0) {
        const message = `OIDC configuration is incomplete; missing ${missing.join(", ")}.`;
        if (env.NODE_ENV === "production")
            throw new OidcConfigurationError(message);
        return { enabled: false, reason: message };
    }
    try {
        const production = env.NODE_ENV === "production";
        const cookieSecret = env.OIDC_COOKIE_SECRET.trim();
        if (Buffer.byteLength(cookieSecret, "utf8") < 32) {
            throw new OidcConfigurationError("OIDC_COOKIE_SECRET must be at least 32 bytes.");
        }
        if (cookieSecret === env.OIDC_CLIENT_SECRET.trim() ||
            (env.JWT_SECRET && cookieSecret === env.JWT_SECRET)) {
            throw new OidcConfigurationError("OIDC_COOKIE_SECRET must be independent from OIDC_CLIENT_SECRET and JWT_SECRET.");
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
            issuer: validateHttpsUrl(env.OIDC_ISSUER, "OIDC_ISSUER", production),
            clientId: env.OIDC_CLIENT_ID.trim(),
            clientSecret: env.OIDC_CLIENT_SECRET.trim(),
            redirectUri: validateHttpsUrl(env.OIDC_REDIRECT_URI, "OIDC_REDIRECT_URI", production),
            scopes: scopes.join(" "),
            cookieSecret,
            requireVerifiedEmail: parseBoolean(env.OIDC_REQUIRE_VERIFIED_EMAIL, "OIDC_REQUIRE_VERIFIED_EMAIL"),
        };
    }
    catch (error) {
        if (env.NODE_ENV === "production")
            throw error;
        return {
            enabled: false,
            reason: error instanceof Error ? error.message : "OIDC configuration is invalid.",
        };
    }
}
/** Production startup gate. OIDC remains disabled when none of its variables are set. */
export function assertOidcConfiguration(env = process.env) {
    void resolveOidcSettings(env);
}
/**
 * Build the public, non-sensitive OIDC status object for the login UI.
 *
 * Reports only whether OIDC login is enabled (resolved from the environment)
 * and its display label; no credentials, issuer, or secret are exposed.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns Whether OIDC is enabled and its UI label.
 */
export function oidcPublicConfig(env = process.env) {
    return { enabled: resolveOidcSettings(env).enabled, label: "OpenID Connect" };
}
function sign(value, secret) {
    return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}
/**
 * Serialize and HMAC-sign an OIDC state payload into a cookie value.
 *
 * Base64url-encodes the JSON payload and appends a `.`-separated HMAC-SHA256
 * signature over it, so {@link decodeOidcStateCookie} can both authenticate
 * and expiry-check the cookie on the callback.
 *
 * @param payload - The state to carry across the redirect.
 * @param secret - The cookie-signing secret (`OIDC_COOKIE_SECRET`).
 * @returns The `value.signature` cookie string.
 */
export function encodeOidcStateCookie(payload, secret) {
    const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${value}.${sign(value, secret)}`;
}
/**
 * Authenticate, decode, and expiry-check a signed OIDC state cookie.
 *
 * Rejects (with {@link OidcFlowError}) a missing, malformed, bad-signature,
 * structurally invalid, or expired cookie — the signature is compared with
 * {@link crypto.timingSafeEqual} and `createdAt` must be within
 * {@link OIDC_STATE_MAX_AGE_MS} of `now` (with a small future skew allowance).
 * Returns the recovered payload on success.
 *
 * @param cookie - The raw cookie value, or `undefined`.
 * @param secret - The cookie-signing secret.
 * @param now - Current time in ms; defaults to `Date.now()` (injectable for tests).
 * @returns The verified state payload.
 */
export function decodeOidcStateCookie(cookie, secret, now = Date.now()) {
    if (!cookie)
        throw new OidcFlowError("missing_state_cookie", "OIDC state cookie is missing.");
    const [value, signature, extra] = cookie.split(".");
    if (!value || !signature || extra) {
        throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
    }
    const expected = sign(value, secret);
    const suppliedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length !== expectedBytes.length ||
        !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
        throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    }
    catch {
        throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
    }
    if (!payload || typeof payload !== "object") {
        throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
    }
    const candidate = payload;
    if (typeof candidate.state !== "string" ||
        typeof candidate.nonce !== "string" ||
        typeof candidate.codeVerifier !== "string" ||
        typeof candidate.createdAt !== "number") {
        throw new OidcFlowError("invalid_state_cookie", "OIDC state cookie is invalid.");
    }
    if (candidate.createdAt > now + 30_000 || now - candidate.createdAt > OIDC_STATE_MAX_AGE_MS) {
        throw new OidcFlowError("expired_state_cookie", "OIDC login request has expired.");
    }
    return candidate;
}
/**
 * Compute the RFC 7636 S256 PKCE code challenge for a verifier.
 *
 * @param codeVerifier - The random PKCE code verifier.
 * @returns The base64url-encoded SHA-256 challenge sent as `code_challenge`.
 */
export function pkceChallenge(codeVerifier) {
    return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}
/**
 * Generate a fresh, single-use OIDC login state.
 *
 * Produces cryptographically random `state`, `nonce`, and PKCE `codeVerifier`
 * (each 32 random bytes, base64url), the matching S256 `codeChallenge`, and a
 * `createdAt` timestamp. The caller sends the challenge/nonce to the provider
 * and stores the verifier in the signed cookie.
 *
 * @param now - Creation time in ms; defaults to `Date.now()` (injectable for tests).
 * @returns The state payload plus the derived code challenge.
 */
export function createOidcState(now = Date.now()) {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    return {
        state: crypto.randomBytes(32).toString("base64url"),
        nonce: crypto.randomBytes(32).toString("base64url"),
        codeVerifier,
        codeChallenge: pkceChallenge(codeVerifier),
        createdAt: now,
    };
}
/**
 * Derive the openid-client grant checks for a stored login state.
 *
 * Bundles the PKCE code verifier, the expected `state` and `nonce`, and the
 * flag requiring an ID token, in the shape `authorizationCodeGrant` consumes
 * on the callback.
 *
 * @param flow - The verified state payload from the cookie.
 * @returns The grant-check inputs for the authorization-code exchange.
 */
export function oidcGrantChecks(flow) {
    return {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
    };
}
/**
 * Require a non-empty string claim from an ID token.
 *
 * Returns the value unchanged when it is a non-empty string; otherwise throws
 * an {@link OidcFlowError} naming the claim, so a missing or wrong-typed
 * `iss`/`sub`/`nonce` fails the login with a precise error.
 *
 * @param value - The raw claim value from the token.
 * @param claim - The claim name, used in the thrown message.
 * @returns The claim value, guaranteed to be a non-empty string.
 */
function requiredString(value, claim) {
    if (typeof value !== "string" || !value) {
        throw new OidcFlowError("invalid_id_token", `ID token ${claim} claim is invalid.`);
    }
    return value;
}
/**
 * Defense-in-depth claim checks after openid-client has verified the ID token
 * signature through discovery/JWKS and applied its protocol validation.
 */
export function validateOidcClaims(claims, settings, expectedNonce, nowSeconds = Math.floor(Date.now() / 1000)) {
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
        throw new OidcFlowError("verified_email_required", "The identity provider must supply a verified email address.", 403);
    }
    const displayNameClaim = [claims.name, claims.preferred_username]
        .find((value) => typeof value === "string" && value.trim());
    return {
        issuer,
        subject,
        email,
        emailVerified,
        displayName: displayNameClaim?.trim() || null,
    };
}
function syntheticOidcEmail(issuer, subject) {
    const digest = crypto.createHash("sha256").update(`${issuer}\0${subject}`).digest("hex");
    return `oidc-${digest.slice(0, 32)}@users.invalid`;
}
function nonLoginablePasswordMarker() {
    return `!oidc:${crypto.randomBytes(32).toString("base64url")}`;
}
async function queryUser(client, sql, values) {
    const result = await client.query(sql, values);
    return result.rows[0] ?? null;
}
/** Transactionally resolve, link, or provision the local user for an OIDC identity. */
export async function resolveExternalIdentity(client, identity) {
    await client.query("BEGIN");
    try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `oidc:${identity.issuer}:${identity.subject}`,
        ]);
        if (identity.email) {
            // Serialize all identity resolution for a shared email before either the
            // existing-mapping or email-link path reads state. This keeps concurrent
            // identities deterministic and makes an unverified collision a protocol
            // error rather than a late uniqueness failure.
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
                `oidc-email:${identity.email}`,
            ]);
        }
        const mapped = await queryUser(client, `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at
         FROM pm_external_identities i
         JOIN pm_users u ON u.id = i.user_id
        WHERE i.issuer = $1 AND i.subject = $2
        FOR UPDATE`, [identity.issuer, identity.subject]);
        if (mapped) {
            await client.query(`UPDATE pm_external_identities
            SET email = $3, updated_at = NOW()
          WHERE issuer = $1 AND subject = $2`, [identity.issuer, identity.subject, identity.email]);
            await client.query("COMMIT");
            return mapped;
        }
        let user = null;
        if (identity.email) {
            user = await queryUser(client, `SELECT id, email, display_name, is_admin, created_at
           FROM pm_users WHERE email = $1 FOR UPDATE`, [identity.email]);
            if (user && !identity.emailVerified) {
                throw new OidcFlowError("unverified_email_collision", "An account with this email already exists and the provider did not verify it.", 409);
            }
        }
        if (!user) {
            const email = identity.email ?? syntheticOidcEmail(identity.issuer, identity.subject);
            const displayName = identity.displayName ?? identity.email?.split("@")[0] ?? "OIDC user";
            user = await queryUser(client, `INSERT INTO pm_users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, is_admin, created_at`, [email, nonLoginablePasswordMarker(), displayName]);
            if (!user)
                throw new Error("OIDC user provisioning returned no user.");
        }
        await client.query(`INSERT INTO pm_external_identities (issuer, subject, user_id, email)
       VALUES ($1, $2, $3, $4)`, [identity.issuer, identity.subject, user.id, identity.email]);
        await client.query("COMMIT");
        return user;
    }
    catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505") {
            throw new OidcFlowError("identity_collision", "This external identity conflicts with an existing account mapping.", 409);
        }
        throw error;
    }
}
//# sourceMappingURL=oidc.js.map