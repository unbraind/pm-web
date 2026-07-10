import { type Express } from "express";
/** Legal pages served as standalone HTML (not part of the SPA bundle). */
export declare const LEGAL_PAGES: readonly ["legal-notice", "privacy-policy", "terms", "cookie-settings"];
/** German short-path aliases that 308-redirect to the canonical legal pages. */
export declare const LEGAL_REDIRECTS: Record<string, string>;
/**
 * Build the Express application with all middleware, static assets, legal
 * page routes, API routes and the SPA fallback — but WITHOUT touching the
 * database or binding a port. Splitting this out from server.ts keeps the
 * HTTP surface unit-testable without a running PostgreSQL instance.
 */
export declare function createApp(): Express;
