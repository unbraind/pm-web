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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "4000", 10);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
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
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  });
