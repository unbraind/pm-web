import type { Request } from "express";
export interface JwtPayload {
    userId: string;
    email: string;
}
export declare function signToken(payload: JwtPayload): string;
export declare function verifyToken(token: string): JwtPayload;
export declare function extractToken(req: Request): string | null;
//# sourceMappingURL=auth.d.ts.map