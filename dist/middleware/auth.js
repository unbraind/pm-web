import { verifyToken, extractToken } from "../auth.js";
export function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
    }
    try {
        req.user = verifyToken(token);
        next();
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
    }
}
//# sourceMappingURL=auth.js.map