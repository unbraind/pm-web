import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { pmRouter } from "./routes/pm.js";
import { groupsRouter } from "./routes/groups.js";
import { sharesRouter, sharedWithMeRouter } from "./routes/sharing.js";
import { githubRouter } from "./routes/github.js";
import { adminRouter } from "./routes/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

/** Legal pages served as standalone HTML (not part of the SPA bundle). */
export const LEGAL_PAGES = [
  "legal-notice",
  "privacy-policy",
  "terms",
  "cookie-settings",
] as const;

/** German short-path aliases that 308-redirect to the canonical legal pages. */
export const LEGAL_REDIRECTS: Record<string, string> = {
  "/impressum": "/legal-notice",
  "/datenschutz": "/privacy-policy",
  "/agb": "/terms",
  "/cookies": "/cookie-settings",
};

/**
 * Build the Express application with all middleware, static assets, legal
 * page routes, API routes and the SPA fallback — but WITHOUT touching the
 * database or binding a port. Splitting this out from server.ts keeps the
 * HTTP surface unit-testable without a running PostgreSQL instance.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/sw.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.join(PUBLIC_DIR, "sw.js"));
  });

  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
    })
  );

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
      const pkg = JSON.parse(
        readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
      ) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  })();
  app.get("/healthz", (_req, res) => res.json({ ok: true, version: PM_WEB_VERSION }));

  const legalPages = new Set<string>(LEGAL_PAGES);

  Object.entries(LEGAL_REDIRECTS).forEach(([from, to]) => {
    app.get(from, (_req, res) => {
      res.redirect(308, to);
    });
  });

  app.get(["/legal-notice", "/privacy-policy", "/terms", "/cookie-settings"], (req, res) => {
    const page = req.path.slice(1);
    if (!legalPages.has(page)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(PUBLIC_DIR, `${req.path.slice(1)}.html`));
  });

  // API routes
  app.use("/api/auth", authRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/projects/:projectId/pm", pmRouter);
  app.use("/api/groups", groupsRouter);
  app.use("/api/projects/:id/shares", sharesRouter);
  app.use("/api/shared", sharedWithMeRouter);
  app.use("/api/projects/:id/github", githubRouter);
  app.use("/api/admin", adminRouter);

  // SPA fallback — serve index.html for all non-API routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  return app;
}