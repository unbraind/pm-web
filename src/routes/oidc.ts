import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretBasic,
  Configuration,
  discovery,
} from "openid-client";
import { pool } from "../db.js";
import { setSessionCookie } from "../auth.js";
import {
  createOidcState,
  decodeOidcStateCookie,
  encodeOidcStateCookie,
  OIDC_STATE_COOKIE,
  OIDC_STATE_MAX_AGE_MS,
  oidcGrantChecks,
  OidcFlowError,
  oidcPublicConfig,
  resolveExternalIdentity,
  resolveOidcSettings,
  validateOidcClaims,
  type OidcSettings,
} from "../oidc.js";

const router = Router();

const stateCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth/oidc",
};

let cachedDiscovery: { fingerprint: string; promise: Promise<Configuration> } | null = null;

function enabledSettings(): OidcSettings {
  const settings = resolveOidcSettings();
  if (!settings.enabled) {
    throw new OidcFlowError("oidc_disabled", "OpenID Connect login is not enabled.", 404);
  }
  return settings;
}

function discoveryConfiguration(settings: OidcSettings): Promise<Configuration> {
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${settings.issuer}\0${settings.clientId}\0${settings.clientSecret}`)
    .digest("base64url");
  if (!cachedDiscovery || cachedDiscovery.fingerprint !== fingerprint) {
    const promise = discoverProvider(settings).catch((error: unknown) => {
      if (cachedDiscovery?.fingerprint === fingerprint) cachedDiscovery = null;
      throw error;
    });
    cachedDiscovery = { fingerprint, promise };
  }
  return cachedDiscovery.promise;
}

async function discoverProvider(settings: OidcSettings): Promise<Configuration> {
  const issuer = new URL(settings.issuer);
  const initial = await discovery(issuer, settings.clientId, settings.clientSecret);
  const methods = initial.serverMetadata().token_endpoint_auth_methods_supported;
  if (
    Array.isArray(methods) &&
    !methods.includes("client_secret_post") &&
    methods.includes("client_secret_basic")
  ) {
    return new Configuration(
      initial.serverMetadata(),
      settings.clientId,
      { client_secret: settings.clientSecret },
      ClientSecretBasic(settings.clientSecret),
    );
  }
  return initial;
}

export function providerAuthorizationError(value: unknown): OidcFlowError | null {
  if (typeof value !== "string" || !value) return null;
  if (value === "access_denied") {
    return new OidcFlowError(
      "provider_access_denied",
      "OpenID Connect login was canceled or denied.",
      403,
    );
  }
  return new OidcFlowError(
    "provider_error",
    "The OpenID Connect provider could not complete login.",
  );
}

function callbackUrl(req: Request, configuredRedirectUri: string): URL {
  const url = new URL(configuredRedirectUri);
  const incoming = new URL(req.originalUrl, "http://localhost");
  url.search = incoming.search;
  return url;
}

function clearStateCookie(res: Response): void {
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
    res.cookie(
      OIDC_STATE_COOKIE,
      encodeOidcStateCookie(flow, settings.cookieSecret),
      { ...stateCookieOptions, maxAge: OIDC_STATE_MAX_AGE_MS },
    );
    res.redirect(302, authorizationUrl.href);
  } catch (error) {
    if (error instanceof OidcFlowError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    res.status(502).json({ error: "OpenID Connect provider discovery failed." });
  }
});

router.get("/oidc/callback", async (req, res) => {
  let client: PoolClient | undefined;
  try {
    const settings = enabledSettings();
    const stateCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      OIDC_STATE_COOKIE
    ];
    const flow = decodeOidcStateCookie(stateCookie, settings.cookieSecret);
    if (req.query.state !== flow.state) {
      throw new OidcFlowError("state_mismatch", "OIDC state does not match the login request.");
    }
    const providerError = providerAuthorizationError(req.query.error);
    if (providerError) throw providerError;
    if (typeof req.query.code !== "string" || !req.query.code) {
      throw new OidcFlowError("missing_code", "OIDC authorization code is missing.");
    }

    const configuration = await discoveryConfiguration(settings);
    const tokens = await authorizationCodeGrant(
      configuration,
      callbackUrl(req, settings.redirectUri),
      oidcGrantChecks(flow),
    );
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
  } catch (error) {
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
          ...((error as Error & { code?: unknown }).code &&
          /^[A-Z0-9_]{1,32}$/i.test(String((error as Error & { code?: unknown }).code))
            ? { code: String((error as Error & { code?: unknown }).code) }
            : {}),
        }
      : { name: typeof error };
    console.error("OIDC callback failed", diagnostic);
    res.status(400).json({ error: "OpenID Connect login failed." });
  } finally {
    client?.release();
  }
});

export { router as oidcRouter };
