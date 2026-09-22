/**
 * Shared helper for tests that need a real ephemeral HTTP server backed by an
 * Express app — used by healthz, pm-schema-history-routes and extensions-routes
 * test suites to avoid duplicating the listen/address/close boilerplate.
 */
import http from "node:http";
import type { Express } from "express";
import { signToken } from "../../src/auth.ts";

/** Start an ephemeral HTTP server on a random port and return the port, a url
 * helper, and a close function that must be called for cleanup. */
export async function startEphemeralServer(
  app: Express,
): Promise<{ port: number; url: (path: string) => string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    url: (p: string) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

/** Issue an authenticated request through a real ephemeral server backed by
 * the given Express app. Returns the HTTP status and the raw response body
 * text so callers can parse it in whichever shape they need. */
export async function authedRequest(
  app: Express,
  method: string,
  urlPath: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const { port, close } = await startEphemeralServer(app);
  try {
    const token = signToken({ userId, email: `${userId}@example.com` });
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    await close();
  }
}