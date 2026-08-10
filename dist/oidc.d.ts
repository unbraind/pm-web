import type { PoolClient } from "pg";
/** Name of the browser cookie that carries the signed OIDC login state. */
export declare const OIDC_STATE_COOKIE = "pm_oidc_state";
/** Maximum age (ms) an OIDC login state cookie is considered valid: ten minutes. */
export declare const OIDC_STATE_MAX_AGE_MS: number;
/**
 * Fully validated, enabled OpenID Connect configuration resolved from the
 * environment: provider endpoints and credentials, requested scopes, the
 * cookie-signing secret, and whether a verified email is required. Only
 * present (as the `enabled: true` variant of {@link ResolvedOidcSettings})
 * when every required variable is set and valid.
 */
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
/**
 * The state held in the signed OIDC cookie across the authorization-code
 * redirect: the random `state`/`nonce`/`codeVerifier` (PKCE) generated at
 * login start, and the `createdAt` timestamp used to expire the request.
 */
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
/**
 * Error raised when OpenID Connect is misconfigured (missing or invalid
 * environment variables). In production {@link resolveOidcSettings} throws it
 * at startup; in development the bad config is instead reported as disabled.
 */
export declare class OidcConfigurationError extends Error {
    constructor(message: string);
}
/**
 * Error raised for a recoverable failure during an OpenID Connect login flow.
 * Carries a machine-readable `code` (surfaced to the client) and an HTTP
 * `status`, so the route layer can map it directly to a JSON error response.
 */
export declare class OidcFlowError extends Error {
    /** Machine-readable error code returned to the browser, e.g. `state_mismatch`. */
    readonly code: string;
    /** HTTP status code to use when rendering this error as a response. */
    readonly status: number;
    constructor(code: string, message: string, status?: number);
}
/** Resolve optional OIDC configuration without exposing any configured value. */
export declare function resolveOidcSettings(env?: NodeJS.ProcessEnv): ResolvedOidcSettings;
/** Production startup gate. OIDC remains disabled when none of its variables are set. */
export declare function assertOidcConfiguration(env?: NodeJS.ProcessEnv): void;
/**
 * Build the public, non-sensitive OIDC status object for the login UI.
 *
 * Reports only whether OIDC login is enabled (resolved from the environment)
 * and its display label; no credentials, issuer, or secret are exposed.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns Whether OIDC is enabled and its UI label.
 */
export declare function oidcPublicConfig(env?: NodeJS.ProcessEnv): {
    enabled: boolean;
    label: "OpenID Connect";
};
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
export declare function encodeOidcStateCookie(payload: OidcStatePayload, secret: string): string;
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
export declare function decodeOidcStateCookie(cookie: string | undefined, secret: string, now?: number): OidcStatePayload;
/**
 * Compute the RFC 7636 S256 PKCE code challenge for a verifier.
 *
 * @param codeVerifier - The random PKCE code verifier.
 * @returns The base64url-encoded SHA-256 challenge sent as `code_challenge`.
 */
export declare function pkceChallenge(codeVerifier: string): string;
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
export declare function createOidcState(now?: number): OidcStatePayload & {
    codeChallenge: string;
};
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
export declare function oidcGrantChecks(flow: OidcStatePayload): {
    pkceCodeVerifier: string;
    expectedState: string;
    expectedNonce: string;
    idTokenExpected: true;
};
/**
 * Defense-in-depth claim checks after openid-client has verified the ID token
 * signature through discovery/JWKS and applied its protocol validation.
 */
export declare function validateOidcClaims(claims: OidcClaims, settings: Pick<OidcSettings, "issuer" | "clientId" | "requireVerifiedEmail">, expectedNonce: string, nowSeconds?: number): ValidatedOidcIdentity;
/** Transactionally resolve, link, or provision the local user for an OIDC identity. */
export declare function resolveExternalIdentity(client: TransactionClient, identity: ValidatedOidcIdentity): Promise<PmUserRow>;
export {};
