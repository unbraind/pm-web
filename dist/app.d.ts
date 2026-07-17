import { type Express } from "express";
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
export declare function resolveLegalPagesDir(env?: NodeJS.ProcessEnv): string;
/**
 * Build the Express application with all middleware, static assets, legal
 * page routes, API routes and the SPA fallback — but WITHOUT touching the
 * database or binding a port. Splitting this out from server.ts keeps the
 * HTTP surface unit-testable without a running PostgreSQL instance.
 */
export declare function createApp(): Express;
