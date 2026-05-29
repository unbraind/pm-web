import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema } from "./db.js";
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

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Init DB schema, then start server
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`pm-web running on :${PORT}`);
    });
    // Periodic cleanup of stale SSE clients
    setInterval(cleanupStaleClients, 5 * 60 * 1000);
  })
  .catch((err: NodeJS.ErrnoException & { code?: string }) => {
    const connectionCodes = new Set([
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ETIMEDOUT",
      "28P01", // invalid_password
      "28000", // invalid_authorization_specification
      "3D000", // invalid_catalog_name (database does not exist)
    ]);
    if (err?.code && connectionCodes.has(err.code)) {
      console.error(
        [
          "",
          "pm-web could not connect to PostgreSQL.",
          "",
          "pm-web requires a PostgreSQL database. Configure one of the following and retry:",
          "  • DATABASE_URL   — full connection string, e.g. postgres://user:pass@localhost:5432/pmweb",
          "  • POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB",
          "",
          "The quickest local setup is Docker:",
          "  docker run -d --name pmweb-db -p 5432:5432 -e POSTGRES_PASSWORD=pmweb -e POSTGRES_DB=pmweb postgres:16",
          "  export DATABASE_URL=postgres://postgres:pmweb@localhost:5432/pmweb",
          "",
          "See the README (Configuration) for all environment variables.",
          `  (underlying error: ${err.code})`,
          "",
        ].join("\n")
      );
      process.exit(1);
    }
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  });
