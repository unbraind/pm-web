import jwt from "jsonwebtoken";
import crypto from "node:crypto";
const DEV_JWT_SECRET = crypto.randomBytes(32).toString("base64url");
const JWT_SECRET = process.env.JWT_SECRET ?? (process.env.NODE_ENV === "production" ? "" : DEV_JWT_SECRET);
const JWT_EXPIRES = "30d";
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is required when running pm-web in production.");
}
export function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
export function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}
export function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice(7);
    }
    const cookie = req.cookies?.pm_token;
    if (cookie)
        return cookie;
    // Allow a `?token=` query param. Calendar clients subscribing to an .ics
    // feed cannot send cookies or an Authorization header, so the feed URL
    // carries the JWT directly. Additive — header/cookie still take precedence.
    const queryToken = req.query?.["token"];
    if (typeof queryToken === "string" && queryToken)
        return queryToken;
    return null;
}
//# sourceMappingURL=auth.js.map