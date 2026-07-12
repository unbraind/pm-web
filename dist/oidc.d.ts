import type { PoolClient } from "pg";
export declare const OIDC_STATE_COOKIE = "pm_oidc_state";
export declare const OIDC_STATE_MAX_AGE_MS: number;
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
export declare class OidcConfigurationError extends Error {
    constructor(message: string);
}
export declare class OidcFlowError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status?: number);
}
/** Resolve optional OIDC configuration without exposing any configured value. */
export declare function resolveOidcSettings(env?: NodeJS.ProcessEnv): ResolvedOidcSettings;
/** Production startup gate. OIDC remains disabled when none of its variables are set. */
export declare function assertOidcConfiguration(env?: NodeJS.ProcessEnv): void;
export declare function oidcPublicConfig(env?: NodeJS.ProcessEnv): {
    enabled: boolean;
    label: "OpenID Connect";
};
export declare function encodeOidcStateCookie(payload: OidcStatePayload, secret: string): string;
export declare function decodeOidcStateCookie(cookie: string | undefined, secret: string, now?: number): OidcStatePayload;
export declare function pkceChallenge(codeVerifier: string): string;
export declare function createOidcState(now?: number): OidcStatePayload & {
    codeChallenge: string;
};
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
