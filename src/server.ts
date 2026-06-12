import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSchema, assertDbConfigured } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { pmRouter } from "./routes/pm.js";
import { groupsRouter } from "./routes/groups.js";
import { sharesRouter, sharedWithMeRouter } from "./routes/sharing.js";
import { githubRouter } from "./routes/github.js";
import { adminRouter } from "./routes/admin.js";
import { cleanupStaleClients } from "./services/sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "4000", 10);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

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

// Validate configuration before doing anything that needs the database, so a
// missing DATABASE_URL fails fast with a clear message instead of hanging on a
// DNS/connection timeout.
try {
  assertDbConfigured();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Init DB schema, then start server
initSchema()
  .then(() => {
    // Express 5 invokes the listen callback WITH the error (it is installed
    // as the server's 'error' handler), so ignoring the argument turns
    // EADDRINUSE into a false "running" message and a process that idles
    // forever without owning the port.
    const server = app.listen(PORT, (err?: Error) => {
      if (err) {
        console.error(`Failed to bind :${PORT}:`, err.message);
        process.exit(1);
      }
      console.log(`pm-web running on :${PORT}`);
    });
    server.on("error", (err: Error) => {
      console.error(`Server error on :${PORT}:`, err.message);
      process.exit(1);
    });
    // Periodic cleanup of stale SSE clients
    setInterval(cleanupStaleClients, 5 * 60 * 1000);
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
