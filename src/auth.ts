import jwt from "jsonwebtoken";
import type { Request } from "express";
import crypto from "node:crypto";

const DEV_JWT_SECRET = crypto.randomBytes(32).toString("base64url");
const JWT_SECRET = process.env.JWT_SECRET ?? (process.env.NODE_ENV === "production" ? "" : DEV_JWT_SECRET);
const JWT_EXPIRES = "30d";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required when running pm-web in production.");
}

export interface JwtPayload {
  userId: string;
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.pm_token;
  if (cookie) return cookie;
  // Allow a `?token=` query param. Calendar clients subscribing to an .ics
  // feed cannot send cookies or an Authorization header, so the feed URL
  // carries the JWT directly. Additive — header/cookie still take precedence.
  const queryToken = (req.query as Record<string, unknown> | undefined)?.["token"];
  if (typeof queryToken === "string" && queryToken) return queryToken;
  return null;
}
