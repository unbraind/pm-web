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
 * Decide whether an unsafe request crossed sites, using the unforgeable
 * `Sec-Fetch-Site` header first and the `Origin` header as a fallback.
 *
 * `Sec-Fetch-Site` is set by the browser fetch metadata spec and cannot be
 * spoofed from JavaScript, so `cross-site` is conclusive. When it is absent
 * (older browsers, non-browser clients) the `Origin` header is compared
 * against the request's own `Host`: a browser always sends `Origin` on
 * unsafe requests, so a present, mismatched `Origin` is also conclusive. A
 * missing `Origin` means the request is not browser-initiated and therefore
 * cannot be a CSRF attack, so it is allowed. A malformed `Origin` is treated
 * as not-cross-site rather than blocked, so the guard never produces a false
 * positive that would block a legitimate (if quirky) client.
 *
 * @param req - The Express request to inspect.
 * @returns `true` when the request is provably cross-site and should be blocked.
 */
export declare function isCrossSiteRequest(req: Request): boolean;
/**
 * Build the CSRF protection middleware.
 *
 * On every request it (re)issues the {@link CSRF_COOKIE_NAME} token cookie when
 * absent, and on every **cookie-authenticated, state-changing** request it
 * blocks provably cross-site callers with 403. Safe methods and unauthenticated
 * requests pass through, so login/register (no session cookie) and reads are
 * unaffected. The same-origin check relies on browser-fetch-metadata headers
 * that are absent from Node's `fetch`, so the real-Postgres route suite —
 * which drives the app with cookie-authenticated `fetch` calls and no `Origin`
 * — is never blocked, while a real browser CSRF attempt (which always sends
 * `Sec-Fetch-Site: cross-site` or a foreign `Origin`) is.
 *
 * @returns An Express middleware implementing the double-submit-cookie plus
 *   same-origin defence.
 */
export declare function csrfProtection(): RequestHandler;
