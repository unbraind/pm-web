import type { Request, Response } from "express";
export interface JwtPayload {
    userId: string;
    email: string;
}
export declare function signToken(payload: JwtPayload): string;
export declare function setSessionCookie(res: Response, payload: JwtPayload): string;
export declare function verifyToken(token: string): JwtPayload;
export declare function extractToken(req: Request): string | null;
