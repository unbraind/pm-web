import jwt from "jsonwebtoken";
const JWT_SECRET = process.env.JWT_SECRET || "pm-web-dev-secret-change-in-prod";
const JWT_EXPIRES = "30d";
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
    return null;
}
//# sourceMappingURL=auth.js.map