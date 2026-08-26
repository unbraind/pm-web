import { type Express } from "express";
import { type HealthProbeDeps } from "./health.ts";
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
export declare const LEGAL_PAGES: readonly ["legal-notice", "privacy-policy", "terms", "cookie-settings"];
/** German short-path aliases that 308-redirect to the canonical legal pages. */
export declare const LEGAL_REDIRECTS: Record<string, string>;
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
export declare function resolveLegalPagesDir(env?: NodeJS.ProcessEnv): string;
/**
 * Optional dependencies `createApp` can wire into the application.
 *
 * Currently only the {@link HealthProbeDeps} for the real `/healthz` handler is
 * supported; the object is kept as a bag so further production-only wiring
 * (e.g. a logger) can be added later without another signature change.
 */
export interface CreateAppDeps {
    /**
     * Health-probe dependencies for the real `/healthz` handler. When supplied,
     * `createApp` mounts {@link createHealthHandler}, which probes PostgreSQL and
     * the projects volume and answers 200/503 accordingly. When omitted, the
     * route answers 503 `ok:false` (see the comment at the route) so a
     * misconfigured deployment can never report healthy while its dependencies
     * are down — the exact failure this handler was written to close.
     */
    readonly health?: HealthProbeDeps;
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
export declare function createApp(deps?: CreateAppDeps): Express;
