import type { Request, RequestHandler } from "express";
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
export declare const CSRF_COOKIE_NAME = "csrf_token";
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
export declare function isCrossSiteRequest(req: Request): boolean;
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
export declare function csrfProtection(): RequestHandler;
