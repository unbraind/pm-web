import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHealthHandler } from "./health.js";
import { authRouter } from "./routes/auth.js";
import { oidcRouter } from "./routes/oidc.js";
import { projectsRouter } from "./routes/projects.js";
import { pmRouter } from "./routes/pm.js";
import { extensionsRouter } from "./routes/extensions.js";
import { groupsRouter } from "./routes/groups.js";
import { sharesRouter, sharedWithMeRouter } from "./routes/sharing.js";
import { githubRouter } from "./routes/github.js";
import { adminRouter } from "./routes/admin.js";
import { createTierLimiters, resolveTrustProxy } from "./rate-limit.js";
import { csrfProtection } from "./csrf.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
/**
 * Legal pages served as standalone HTML (not part of the SPA bundle).
 *
 * LOCALIZATION NOTE (i18n): These pages are operator-overlay templates.
 * In production an operator supplies their own versions via PM_WEB_LEGAL_DIR
 * (which must provide all four files). The package templates in public/*.html
 * are English placeholders shown only when no overlay is configured. Localizing
 * the legal pages themselves is an OPERATOR concern, not handled by the SPA
 * i18n module (public/src/i18n.ts): the standalone legal HTML does not load the
 * SPA bundle, so the SPA t()/catalog plumbing cannot reach it. The SPA
 * language selector deliberately does NOT promise translated legal pages (see
 * settings.languageHint), and a German disclaimer string (legal.disclaimer) is
 * provided for any translated legal-adjacent UI. Operators wanting localized
 * legal pages should supply a localized overlay directory.
 */
export const LEGAL_PAGES = [
    "legal-notice",
    "privacy-policy",
    "terms",
    "cookie-settings",
];
/** German short-path aliases that 308-redirect to the canonical legal pages. */
export const LEGAL_REDIRECTS = {
    "/impressum": "/legal-notice",
    "/datenschutz": "/privacy-policy",
    "/agb": "/terms",
    "/cookies": "/cookie-settings",
};
/**
 * Resolve the directory that serves the standalone legal-page HTML.
 *
 * With no `PM_WEB_LEGAL_DIR` configured (or a blank value) the bundled
 * `public/` directory is returned, whose placeholder templates are English.
 * When an operator overlay is set it is validated strictly before use: the path
 * must be absolute, must `realpath`-resolve to a real directory, and every one
 * of the {@link LEGAL_PAGES} must exist there as a regular (non-symlink) file
 * whose real path stays inside the overlay root and is readable. Any failure
 * throws with a specific message, so a half-configured overlay never silently
 * falls back to the placeholders.
 *
 * @param env - Environment to read `PM_WEB_LEGAL_DIR` from; defaults to
 *   `process.env` so callers (and tests) can inject a controlled environment.
 * @returns The real, resolved directory path holding the legal HTML files.
 */
export function resolveLegalPagesDir(env = process.env) {
    const configured = env.PM_WEB_LEGAL_DIR?.trim();
    if (!configured)
        return PUBLIC_DIR;
    if (!path.isAbsolute(configured)) {
        throw new Error("PM_WEB_LEGAL_DIR must be an absolute path.");
    }
    const root = realpathSync(configured);
    if (!statSync(root).isDirectory()) {
        throw new Error("PM_WEB_LEGAL_DIR must resolve to a directory.");
    }
    for (const page of LEGAL_PAGES) {
        const candidate = path.join(root, `${page}.html`);
        try {
            if (lstatSync(candidate).isSymbolicLink()) {
                throw new Error(`PM_WEB_LEGAL_DIR file ${page}.html must not be a symbolic link.`);
            }
        }
        catch (error) {
            if (error.code === "ENOENT") {
                throw new Error(`PM_WEB_LEGAL_DIR is missing required file ${page}.html.`);
            }
            throw error;
        }
        const resolved = realpathSync(candidate);
        if (!resolved.startsWith(`${root}${path.sep}`) || !statSync(resolved).isFile()) {
            throw new Error(`PM_WEB_LEGAL_DIR file ${page}.html must be a regular file inside the overlay.`);
        }
        accessSync(resolved, constants.R_OK);
    }
    return root;
}
/**
 * Build the Express application with all middleware, static assets, legal
 * page routes, API routes and the SPA fallback — but WITHOUT touching the
 * database or binding a port. Splitting this out from server.ts keeps the
 * HTTP surface unit-testable without a running PostgreSQL instance.
 *
 * @param deps - Optional production wiring. Pass `health` to mount the real
 *   probing `/healthz` handler; omit it for tests that only need the HTTP
 *   surface (the route then answers 503 `ok:false`, never `ok:true`).
 * @returns The configured Express application, not yet listening on a port.
 */
export function createApp(deps) {
    const app = express();
    const legalPagesDir = resolveLegalPagesDir();
    // Trust the reverse proxy so `req.ip`, `req.hostname` and `req.protocol`
    // reflect the real client behind Caddy instead of the proxy itself. This is
    // what the rate limiter keys on: without it every client would share one
    // bucket (the proxy's address) and the limiter would be useless. The hop
    // count is configurable via PM_WEB_TRUST_PROXY; the default trusts a single
    // hop, matching the documented Caddy deployment, and never `true` (which
    // would let callers forge X-Forwarded-For and bypass per-client limits).
    app.set("trust proxy", resolveTrustProxy(process.env));
    // One set of tier limiters for this app instance; each owns an independent
    // in-memory store so the tiers never steal each other's quota. See
    // src/rate-limit.ts for the per-tier limits and the abuse each protects
    // against.
    const limiters = createTierLimiters(process.env);
    app.use(express.json({ limit: "1mb" }));
    app.use(cookieParser());
    app.get("/sw.js", limiters.staticAssets, (_req, res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.sendFile(path.join(PUBLIC_DIR, "sw.js"));
    });
    app.use(express.static(PUBLIC_DIR, {
        maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
    }));
    // Security headers
    app.use((_req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        next();
    });
    // Health check — includes the running pm-web version so `pm web status` can
    // report it. Version is resolved once at boot from package.json (best-effort).
    const PM_WEB_VERSION = (() => {
        try {
            const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
            return pkg.version ?? "unknown";
        }
        catch {
            return "unknown";
        }
    })();
    if (deps?.health) {
        // Production wiring: probe PostgreSQL and the projects volume before
        // answering. `server.ts` always supplies these dependencies, so the
        // deployed service reports healthy only when its hard dependencies are
        // actually reachable.
        app.get("/healthz", createHealthHandler(deps.health));
    }
    else {
        // No health-probe dependencies were supplied, so this route cannot probe
        // PostgreSQL or the projects volume. Answering `ok:true` here would
        // reproduce the original bug this handler exists to close: pm-web has
        // previously served frozen data for two days while `/healthz` reported
        // healthy. A route that cannot probe must not claim `ok:true`, so the
        // unconfigured default answers 503 with the version only. Production
        // (`server.ts`) always supplies the real dependencies; this branch is
        // reached only by tests that exercise the HTTP surface without a database
        // and by misconfigured deployments, which must fail loud rather than lie.
        app.get("/healthz", (_req, res) => res.status(503).json({ ok: false, version: PM_WEB_VERSION }));
    }
    const legalPages = new Set(LEGAL_PAGES);
    Object.entries(LEGAL_REDIRECTS).forEach(([from, to]) => {
        app.get(from, (_req, res) => {
            res.redirect(308, to);
        });
    });
    app.get(["/legal-notice", "/privacy-policy", "/terms", "/cookie-settings"], limiters.staticAssets, (req, res) => {
        // Non-strict routing also matches trailing-slash variants (/terms/), so
        // normalize before the whitelist lookup instead of 404ing on them.
        const page = req.path.replace(/\/+$/, "").slice(1);
        if (!legalPages.has(page)) {
            res.status(404).end();
            return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.sendFile(path.join(legalPagesDir, `${page}.html`));
    });
    // CSRF guard: issued after cookie-parser (it reads/sets the csrf cookie) and
    // before the API routers so every cookie-authenticated state-changing route
    // is guarded. See src/csrf.ts.
    app.use(csrfProtection());
    // API routes. Each mount sits behind the tier that matches its abuse profile:
    //   - /api/auth  → auth tier (tightest): credential brute-force / account abuse.
    //   - /api/admin → admin tier (tight): privileged operations, rare in normal use.
    //   - every other /api mount → read tier (GET/HEAD/OPTIONS) + write tier
    //     (POST/PATCH/PUT/DELETE), split by method via the limiters' `skip`
    //     predicates so reads and writes carry separate per-minute budgets.
    // Real-time collaborative editing generates many requests per user, but a
    // single human stays well under 300 writes/min and 600 reads/min; the limits
    // stop scripted floods without throttling normal collaboration.
    app.use("/api/auth", limiters.auth, oidcRouter);
    app.use("/api/auth", limiters.auth, authRouter);
    app.use("/api/projects", limiters.read, limiters.write, projectsRouter);
    app.use("/api/projects/:projectId/pm", limiters.read, limiters.write, pmRouter);
    app.use("/api/projects/:projectId/extensions", limiters.read, limiters.write, extensionsRouter);
    app.use("/api/groups", limiters.read, limiters.write, groupsRouter);
    app.use("/api/projects/:id/shares", limiters.read, limiters.write, sharesRouter);
    app.use("/api/shared", limiters.read, limiters.write, sharedWithMeRouter);
    app.use("/api/projects/:id/github", limiters.read, limiters.write, githubRouter);
    app.use("/api/admin", limiters.admin, adminRouter);
    // Unknown API routes get a JSON 404 instead of falling through to the SPA
    // shell, which would hand HTML to API clients expecting JSON.
    app.all("/api/{*splat}", (_req, res) => {
        res.status(404).json({ error: "Not found" });
    });
    // SPA fallback — serve index.html for all non-API routes
    app.get("/{*splat}", limiters.staticAssets, (_req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, "index.html"));
    });
    return app;
}
//# sourceMappingURL=app.js.map