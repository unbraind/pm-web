import type { Request, Response } from "express";
/**
 * Claims encoded into a pm-web session JWT: the authenticated user's stable id
 * and email, both set by the OIDC login flow and later restored by
 * `verifyToken`.
 */
export interface JwtPayload {
    userId: string;
    email: string;
}
export declare function signToken(payload: JwtPayload): string;
export declare function setSessionCookie(res: Response, payload: JwtPayload): string;
export declare function verifyToken(token: string): JwtPayload;
export declare function extractToken(req: Request): string | null;
