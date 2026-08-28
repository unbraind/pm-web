import { rateLimit } from "express-rate-limit";
/**
 * The default length of every rate-limit window, in milliseconds (one minute).
 *
 * All tiers share a one-minute window so a caller's quota is intuitive ("N
 * requests per minute") and so a burst that exhausts a bucket recovers in at
 * most a minute rather than the 15 minutes a longer window would lock in.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Production default limits (requests per minute per client) for each tier.
 *
 * These are the values a deployed pm-web uses when no `PM_WEB_RATE_LIMIT_*`
 * override is set. They are intentionally exported so the PR body and tests can
 * reference the exact numbers the limiter ships with, rather than restating a
 * second copy that would drift from the real configuration.
 */
/** Tightest tier: credential routes. 20/min lets a user retry a typo while making password brute-force impractical (bcrypt cost 12 ≈ 250 ms each). */
export const AUTH_LIMIT_PER_MINUTE = 20;
/** Admin tier: privileged operations are rare in normal use, so 30/min is ample and keeps scripted admin abuse bounded. */
export const ADMIN_LIMIT_PER_MINUTE = 30;
/** Read tier: 600 authenticated reads/min is far above a single human's dashboard/SSE rate and stops listing/polling floods. */
export const READ_LIMIT_PER_MINUTE = 600;
/** Write tier: 300 mutations/min sits between auth and reads; a collaborative editor stays well under it while scripted floods do not. */
export const WRITE_LIMIT_PER_MINUTE = 300;
/** Static tier: file-serving reads are cheap; 600/min bounds fs-flood attempts without throttling normal page loads. */
export const STATIC_LIMIT_PER_MINUTE = 600;
/**
 * HTTP methods that must not change server state and therefore sit in the
 * loose "read" tier rather than the tighter "write" tier.
 *
 * `OPTIONS` (CORS preflight) is included because it is a safe, side-effect-free
 * probe; `HEAD` is included because it is `GET` without a body. Everything
 * else (`POST`, `PATCH`, `PUT`, `DELETE`, …) is treated as a mutating write.
 */
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Report whether an HTTP method is "safe" (read-only) for tier assignment.
 *
 * Express delivers `req.method` upper-cased, so the lookup is direct; the
 * `toUpperCase` keeps the predicate correct for any caller that passes a
 * mixed-case value (tests, custom servers) without introducing a branch the
 * coverage gate would have to exercise.
 *
 * @param method - The HTTP method string to classify.
 * @returns `true` for `GET`, `HEAD` and `OPTIONS`; `false` for every mutating method.
 */
export function isSafeMethod(method) {
    return SAFE_HTTP_METHODS.has(method.toUpperCase());
}
/**
 * Report whether an HTTP method mutates state and therefore belongs in the
 * "write" tier (or, for the CSRF guard, is the kind of request a forged
 * cross-site request would target).
 *
 * @param method - The HTTP method string to classify.
 * @returns `true` for `POST`, `PATCH`, `PUT`, `DELETE`, …; `false` for safe methods.
 */
export function isUnsafeMethod(method) {
    return !isSafeMethod(method);
}
/**
 * Resolve the Express `trust proxy` setting from the environment.
 *
 * pm-web runs behind a reverse proxy (Caddy), so `req.ip` is the proxy's
 * address unless Express is told how many `X-Forwarded-For` hops to trust.
 * Getting this wrong collapses every client into one rate-limit bucket
 * (the proxy's IP), which both defeats the limiter and makes the CSRF
 * same-origin check unreliable. This function never returns the boolean
 * `true`: trusting every hop lets any caller spoof `X-Forwarded-For` and
 * bypass per-client limits, and `express-rate-limit` refuses that setting.
 *
 * The default trusts a single proxy hop, matching the documented Caddy
 * deployment. Operators behind a longer chain set `PM_WEB_TRUST_PROXY` to the
 * hop count, to a comma-separated IP/subnet allowlist, or to `false`/`0` for a
 * direct (no-proxy) deployment.
 *
 * @param env - Environment to read `PM_WEB_TRUST_PROXY` from; defaults to
 *   `process.env` so production reads the live configuration.
 * @returns A value Express accepts for `app.set("trust proxy", …)`: a
 *   non-negative hop count, a boolean `false`, or a comma-separated
 *   IP/subnet string.
 */
export function resolveTrustProxy(env = process.env) {
    const raw = (env.PM_WEB_TRUST_PROXY ?? "").trim();
    if (raw === "false" || raw === "0")
        return false;
    if (raw === "")
        return 1;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0)
        return Math.trunc(numeric);
    // Anything else is a comma-separated IP/subnet list (or a proxy-addr special
    // name such as "loopback"/"uniquelocal"); pass it through to Express verbatim
    // rather than guessing what the operator meant.
    return raw;
}
/**
 * Resolve a positive integer limit from the environment, falling back to a
 * production default when the variable is absent or not a usable number.
 *
 * @param env - Environment to read the variable from.
 * @param key - The `PM_WEB_RATE_LIMIT_*` environment variable name.
 * @param fallback - The production default used when the variable is unset or invalid.
 * @returns A positive integer request limit for the window.
 */
function resolveLimit(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw === "")
        return fallback;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0)
        return Math.trunc(parsed);
    return fallback;
}
/**
 * Build a rate-limiting middleware from pm-web's shared configuration.
 *
 * Wraps `express-rate-limit` so every tier emits the same standard
 * `RateLimit-*` headers (draft-6) and disables the legacy `X-RateLimit-*`
 * headers, giving clients one consistent retry contract. The factory is
 * exported so the integration test can build a limiter with a tiny limit and
 * drive a route past it, proving the middleware actually returns 429 rather
 * than merely being registered.
 *
 * @param options - Window, limit, identifier and optional `skip` predicate.
 * @returns An Express middleware that rate-limits its mount.
 */
export function createRateLimiter(options) {
    return rateLimit({
        windowMs: options.windowMs,
        limit: options.limit,
        identifier: options.identifier,
        standardHeaders: "draft-6",
        legacyHeaders: false,
        skip: options.skip,
    });
}
/**
 * Build the five tier limiters from the environment, with production defaults.
 *
 * Each limit is overridable with a `PM_WEB_RATE_LIMIT_*` variable so an
 * operator can tune a tier for their deployment without a code change, and so
 * the test harness can raise the limits high enough that the functional
 * (real-Postgres) suite — which issues many requests per file — is never
 * throttled while the dedicated limiter test exercises an isolated limiter.
 *
 * @param env - Environment to read the overrides from; defaults to `process.env`.
 * @returns The five tier middlewares, each with its own hit-count store.
 */
export function createTierLimiters(env = process.env) {
    const windowMs = resolveLimit(env, "PM_WEB_RATE_LIMIT_WINDOW_MS", RATE_LIMIT_WINDOW_MS);
    return {
        auth: createRateLimiter({
            windowMs,
            limit: resolveLimit(env, "PM_WEB_RATE_LIMIT_AUTH", AUTH_LIMIT_PER_MINUTE),
            identifier: "api-auth",
        }),
        admin: createRateLimiter({
            windowMs,
            limit: resolveLimit(env, "PM_WEB_RATE_LIMIT_ADMIN", ADMIN_LIMIT_PER_MINUTE),
            identifier: "api-admin",
        }),
        read: createRateLimiter({
            windowMs,
            limit: resolveLimit(env, "PM_WEB_RATE_LIMIT_READ", READ_LIMIT_PER_MINUTE),
            identifier: "api-read",
            // The read tier only counts safe methods; writes are counted by `write`.
            skip: (req) => !isSafeMethod(req.method),
        }),
        write: createRateLimiter({
            windowMs,
            limit: resolveLimit(env, "PM_WEB_RATE_LIMIT_WRITE", WRITE_LIMIT_PER_MINUTE),
            identifier: "api-write",
            skip: (req) => isSafeMethod(req.method),
        }),
        staticAssets: createRateLimiter({
            windowMs,
            limit: resolveLimit(env, "PM_WEB_RATE_LIMIT_STATIC", STATIC_LIMIT_PER_MINUTE),
            identifier: "static",
            skip: (req) => !isSafeMethod(req.method),
        }),
    };
}
//# sourceMappingURL=rate-limit.js.map