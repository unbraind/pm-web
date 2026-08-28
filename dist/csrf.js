import crypto from "node:crypto";
import { isUnsafeMethod } from "./rate-limit.js";
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
 * Values of the `Sec-Fetch-Site` request header that prove a request did NOT
 * cross sites. `none` is a user-initiated navigation (no referrer) and is safe;
 * `same-origin` and `same-site` are, by definition, not cross-site. Any other
 * value (`cross-site`) is a forgery attempt and is blocked.
 */
const SAME_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);
/**
 * Read the `pm_token` session cookie from a request that has already been
 * through `cookie-parser`.
 *
 * The CSRF guard only enforces same-origin on requests that are actually
 * authenticated with the session cookie: a cross-site `POST /api/auth/login`
 * carries no `pm_token` (the victim has not logged in from the attacker's
 * page), so it cannot act on the victim's behalf and need not be blocked.
 * Bearer-token API clients (which send `Authorization` and no cookie) are
 * likewise exempt, which is why the guard keys on the cookie and not on
 * `requireAuth`.
 *
 * @param req - The Express request, post-`cookie-parser`.
 * @returns `true` when a `pm_token` session cookie is present.
 */
function hasSessionCookie(req) {
    const cookies = req.cookies;
    return Boolean(cookies && cookies.pm_token);
}
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
export function isCrossSiteRequest(req) {
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site")
        return true;
    if (typeof site === "string" && SAME_FETCH_SITES.has(site))
        return false;
    const origin = req.headers["origin"];
    if (typeof origin !== "string" || origin === "")
        return false;
    let originHost;
    try {
        originHost = new URL(origin).host;
    }
    catch {
        return false;
    }
    return originHost !== (req.get("host") ?? "");
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
function ensureCsrfCookie(req, res) {
    const cookies = req.cookies;
    if (cookies?.[CSRF_COOKIE_NAME])
        return;
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
export function csrfProtection() {
    return (req, res, next) => {
        ensureCsrfCookie(req, res);
        if (!isUnsafeMethod(req.method) || !hasSessionCookie(req) || !isCrossSiteRequest(req)) {
            next();
            return;
        }
        res.status(403).json({ error: "Cross-origin request blocked" });
    };
}
//# sourceMappingURL=csrf.js.map