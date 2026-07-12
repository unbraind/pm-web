import crypto from "node:crypto";
import { Router } from "express";
import { authorizationCodeGrant, buildAuthorizationUrl, ClientSecretBasic, discovery, } from "openid-client";
import { pool } from "../db.js";
import { setSessionCookie } from "../auth.js";
import { createOidcState, decodeOidcStateCookie, encodeOidcStateCookie, OIDC_STATE_COOKIE, OIDC_STATE_MAX_AGE_MS, oidcGrantChecks, OidcFlowError, oidcPublicConfig, resolveExternalIdentity, resolveOidcSettings, validateOidcClaims, } from "../oidc.js";
const router = Router();
const stateCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/oidc",
};
let cachedDiscovery = null;
function enabledSettings() {
    const settings = resolveOidcSettings();
    if (!settings.enabled) {
        throw new OidcFlowError("oidc_disabled", "OpenID Connect login is not enabled.", 404);
    }
    return settings;
}
function discoveryConfiguration(settings) {
    const fingerprint = crypto
        .createHash("sha256")
        .update(`${settings.issuer}\0${settings.clientId}\0${settings.clientSecret}`)
        .digest("base64url");
    if (!cachedDiscovery || cachedDiscovery.fingerprint !== fingerprint) {
        const promise = discoverProvider(settings).catch((error) => {
            if (cachedDiscovery?.fingerprint === fingerprint)
                cachedDiscovery = null;
            throw error;
        });
        cachedDiscovery = { fingerprint, promise };
    }
    return cachedDiscovery.promise;
}
async function discoverProvider(settings) {
    const issuer = new URL(settings.issuer);
    const initial = await discovery(issuer, settings.clientId, settings.clientSecret);
    const methods = initial.serverMetadata().token_endpoint_auth_methods_supported;
    if (Array.isArray(methods) &&
        !methods.includes("client_secret_post") &&
        methods.includes("client_secret_basic")) {
        return discovery(issuer, settings.clientId, { client_secret: settings.clientSecret }, ClientSecretBasic(settings.clientSecret));
    }
    return initial;
}
function callbackUrl(req, configuredRedirectUri) {
    const url = new URL(configuredRedirectUri);
    const incoming = new URL(req.originalUrl, "http://localhost");
    url.search = incoming.search;
    return url;
}
function clearStateCookie(res) {
    res.clearCookie(OIDC_STATE_COOKIE, stateCookieOptions);
}
router.get("/oidc/config", (_req, res) => {
    res.json(oidcPublicConfig());
});
router.get("/oidc/start", async (_req, res) => {
    try {
        const settings = enabledSettings();
        const configuration = await discoveryConfiguration(settings);
        const flow = createOidcState();
        const authorizationUrl = buildAuthorizationUrl(configuration, {
            redirect_uri: settings.redirectUri,
            scope: settings.scopes,
            response_type: "code",
            state: flow.state,
            nonce: flow.nonce,
            code_challenge: flow.codeChallenge,
            code_challenge_method: "S256",
        });
        res.cookie(OIDC_STATE_COOKIE, encodeOidcStateCookie(flow, settings.cookieSecret), { ...stateCookieOptions, maxAge: OIDC_STATE_MAX_AGE_MS });
        res.redirect(302, authorizationUrl.href);
    }
    catch (error) {
        if (error instanceof OidcFlowError) {
            res.status(error.status).json({ error: error.message, code: error.code });
            return;
        }
        res.status(502).json({ error: "OpenID Connect provider discovery failed." });
    }
});
router.get("/oidc/callback", async (req, res) => {
    let client;
    try {
        const settings = enabledSettings();
        const stateCookie = req.cookies?.[OIDC_STATE_COOKIE];
        const flow = decodeOidcStateCookie(stateCookie, settings.cookieSecret);
        if (req.query.state !== flow.state) {
            throw new OidcFlowError("state_mismatch", "OIDC state does not match the login request.");
        }
        if (typeof req.query.code !== "string" || !req.query.code) {
            throw new OidcFlowError("missing_code", "OIDC authorization code is missing.");
        }
        const configuration = await discoveryConfiguration(settings);
        const tokens = await authorizationCodeGrant(configuration, callbackUrl(req, settings.redirectUri), oidcGrantChecks(flow));
        const claims = tokens.claims();
        if (!claims) {
            throw new OidcFlowError("missing_id_token", "OIDC provider did not return an ID token.");
        }
        const identity = validateOidcClaims(claims, settings, flow.nonce);
        client = await pool.connect();
        const user = await resolveExternalIdentity(client, identity);
        setSessionCookie(res, { userId: user.id, email: user.email });
        clearStateCookie(res);
        res.redirect(303, "/");
    }
    catch (error) {
        clearStateCookie(res);
        if (error instanceof OidcFlowError) {
            res.status(error.status).json({ error: error.message, code: error.code });
            return;
        }
        // Never log the full exception: OAuth failures may contain authorization
        // codes or token data. A class + PostgreSQL-style code is sufficient to
        // distinguish infrastructure/schema faults without exposing the payload.
        const diagnostic = error instanceof Error
            ? {
                name: error.name,
                ...(error.code &&
                    /^[A-Z0-9_]{1,32}$/i.test(String(error.code))
                    ? { code: String(error.code) }
                    : {}),
            }
            : { name: typeof error };
        console.error("OIDC callback failed", diagnostic);
        res.status(400).json({ error: "OpenID Connect login failed." });
    }
    finally {
        client?.release();
    }
});
export { router as oidcRouter };
//# sourceMappingURL=oidc.js.map