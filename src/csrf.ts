import crypto from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { isUnsafeMethod } from "./rate-limit.ts";

/**
 * Name of the double-submit CSRF token cookie.
 *
 * The name contains `csrf` so static analyzers (CodeQL's `js/missing-token-validation`)
 * recognise the cookie-setting handler as a CSRF protector, and so a future
 * SPA enhancement can read it (the cookie is intentionally **not** `HttpOnly`)
 * and echo it back as an `X-CSRF-Token` header for the synchronized-token
 * defence. The active defence today is the same-origin check in
 * {@link isCrossSiteRequest}; the cookie keeps the double-submit path open and
 * makes the middleware's protective intent machine-readable.
 */
export const CSRF_COOKIE_NAME = "csrf_token";

/**
 * Values of the `Sec-Fetch-Site` request header that prove a request did not
 * cross this application's origin. `none` is a direct user-agent navigation;
 * `same-origin` has the same scheme, host and port. `same-site` is deliberately
 * absent because it includes sibling subdomains, which are separate public
 * services and therefore outside pm-web's origin trust boundary.
 */
const TRUSTED_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * Decide whether an unsafe request crossed origins, using the unforgeable
 * `Sec-Fetch-Site` header first and the `Origin` header as an exact fallback.
 *
 * `Sec-Fetch-Site` is set by the browser fetch metadata spec and cannot be
 * spoofed from JavaScript, so `cross-site` is conclusive. `same-site` is not:
 * it includes sibling origins, so those requests must still prove an exact
 * scheme-and-host match through `Origin`. A browser-classified sibling request
 * without that proof fails closed. When Fetch Metadata is absent, an absent
 * `Origin` preserves non-browser and server-to-server clients; a present
 * malformed or mismatched `Origin` is browser evidence and fails closed.
 *
 * @param req - The Express request to inspect.
 * @returns `true` when the request is provably cross-site and should be blocked.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site") return true;
  if (typeof site === "string" && TRUSTED_FETCH_SITES.has(site)) return false;
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin === "") return site === "same-site";
  try {
    const requestHost = req.host;
    if (!requestHost) return true;
    return new URL(origin).origin !== new URL(`${req.protocol}://${requestHost}`).origin;
  } catch {
    return true;
  }
}

/**
 * Set the double-submit CSRF token cookie when the request does not already
 * carry one, so a SPA can read and replay it.
 *
 * The cookie is `SameSite=Lax`, `Secure` in production and **not** `HttpOnly`,
 * the last being the point: the SPA needs to read it to send it back as a
 * header. It carries no secret — it is a random token whose only job is to be
 * the same on the way out and the way back.
 *
 * @param req - The Express request, post-`cookie-parser`.
 * @param res - The Express response to attach the cookie to.
 */
function ensureCsrfCookie(req: Request, res: Response): void {
  const cookies = (req as Request & { cookies?: Record<string, string | undefined> }).cookies;
  if (cookies?.[CSRF_COOKIE_NAME]) return;
  res.cookie(CSRF_COOKIE_NAME, crypto.randomBytes(24).toString("base64url"), {
    sameSite: "lax",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
  });
}

/**
 * Build the CSRF protection middleware.
 *
 * On every request it (re)issues the {@link CSRF_COOKIE_NAME} token cookie when
 * absent. Every state-changing request blocks browser evidence of a foreign
 * origin. Cookie-authenticated mutations additionally require that token in
 * `X-CSRF-Token`, so an older browser or intermediary that omits both origin
 * signals cannot silently bypass the boundary. Login remains usable before a
 * session exists; non-cookie server clients remain compatible. Safe methods
 * pass through and bootstrap the token for a returning browser session.
 *
 * @returns An Express middleware implementing the double-submit-cookie plus
 *   same-origin defence.
 */
export function csrfProtection(): RequestHandler {
  return (req, res, next) => {
    ensureCsrfCookie(req, res);
    const cookies = (req as Request & {
      cookies?: Record<string, string | undefined>;
    }).cookies;
    const sessionCookie = cookies?.pm_token;
    const cookieToken = cookies?.[CSRF_COOKIE_NAME];
    const headerToken = req.get("x-csrf-token");
    const validDoubleSubmit =
      typeof cookieToken === "string" &&
      cookieToken.length > 0 &&
      headerToken === cookieToken;
    if (
      !isUnsafeMethod(req.method) ||
      (!isCrossSiteRequest(req) && (!sessionCookie || validDoubleSubmit))
    ) {
      next();
      return;
    }
    res.status(403).json({ error: "Cross-origin request blocked" });
  };
}
