import type { Request, Response, NextFunction } from "express";
/**
 * Express request augmented with the authenticated principal, if any.
 *
 * `user` is populated by {@link requireAuth} (and the admin guard) after a
 * valid session JWT is verified; route handlers downstream read `req.user` to
 * identify the caller. It stays `undefined` on unauthenticated or
 * not-yet-verified requests.
 */
export interface AuthRequest extends Request {
    user?: {
        userId: string;
        email: string;
    };
}
export declare function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void;
