import type { Request, Response, NextFunction } from "express";
import { verifyToken, extractToken } from "../auth.ts";

/**
 * Express request augmented with the authenticated principal, if any.
 *
 * `user` is populated by {@link requireAuth} (and the admin guard) after a
 * valid session JWT is verified; route handlers downstream read `req.user` to
 * identify the caller. It stays `undefined` on unauthenticated or
 * not-yet-verified requests.
 */
export interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
