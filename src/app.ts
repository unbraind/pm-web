import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.ts";
import { oidcRouter } from "./routes/oidc.ts";
import { projectsRouter } from "./routes/projects.ts";
import { pmRouter } from "./routes/pm.ts";
import { extensionsRouter } from "./routes/extensions.ts";
import { groupsRouter } from "./routes/groups.ts";
import { sharesRouter, sharedWithMeRouter } from "./routes/sharing.ts";
import { githubRouter } from "./routes/github.ts";
import { adminRouter } from "./routes/admin.ts";

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
] as const;

/** German short-path aliases that 308-redirect to the canonical legal pages. */
export const LEGAL_REDIRECTS: Record<string, string> = {
  "/impressum": "/legal-notice",
  "/datenschutz": "/privacy-policy",
  "/agb": "/terms",
  "/cookies": "/cookie-settings",
};

export function resolveLegalPagesDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PM_WEB_LEGAL_DIR?.trim();
  if (!configured) return PUBLIC_DIR;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
 */
export function createApp(): Express {
  const app = express();
  const legalPagesDir = resolveLegalPagesDir();

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

  // API routes
  app.use("/api/auth", oidcRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/projects/:projectId/pm", pmRouter);
  app.use("/api/projects/:projectId/extensions", extensionsRouter);
  app.use("/api/groups", groupsRouter);
  app.use("/api/projects/:id/shares", sharesRouter);
  app.use("/api/shared", sharedWithMeRouter);
  app.use("/api/projects/:id/github", githubRouter);
  app.use("/api/admin", adminRouter);

  // Unknown API routes get a JSON 404 instead of falling through to the SPA
  // shell, which would hand HTML to API clients expecting JSON.
  app.all("/api/{*splat}", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // SPA fallback — serve index.html for all non-API routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  return app;
}
