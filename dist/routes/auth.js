import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { setSessionCookie } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { encryptSecret } from "../crypto.js";
const router = Router();
const bootstrapAdminEmail = (process.env.PM_WEB_BOOTSTRAP_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
/** RFC 5321 caps an email address at 254 characters; bound the input first so the
 * checks below run over a fixed, small string regardless of attacker input. */
const MAX_EMAIL_LENGTH = 254;
/**
 * Validate an email address without a backtracking regular expression.
 *
 * The previous check used `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, whose repeated
 * `[^\s@]+` groups force O(n) backtracking attempts on a long string with no
 * `@`, giving polynomial (quadratic) runtime — the ReDoS CodeQL flagged. This
 * helper splits on the single `@` first and then validates each side with
 * anchored single-class patterns (`[^\s]+`), which are linear and cannot
 * backtrack across a missing delimiter. The 254-character bound (RFC 5321)
 * is applied up front so even the linear checks run over a capped length.
 *
 * @param email - The candidate address to validate.
 * @returns `true` when the address has exactly one `@`, non-empty whitespace-free
 *   local and domain parts, and a dotted domain.
 */
export function isValidEmail(email) {
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH)
        return false;
    const at = email.indexOf("@");
    if (at < 1 || at === email.length - 1)
        return false;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    // A second `@` (in the domain) is rejected: split-on-first-`@` already
    // guarantees the local part is `@`-free, so only the domain needs the check.
    if (domain.includes("@"))
        return false;
    if (!/^[^\s]+$/.test(local) || !/^[^\s]+$/.test(domain))
        return false;
    // A dot somewhere in the domain gives the `host.tld` shape the old regex
    // required; the character-class checks above already excluded whitespace.
    return domain.includes(".");
}
router.post("/register", async (req, res) => {
    const { email, password, displayName } = req.body;
    if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
    }
    if (!isValidEmail(email)) {
        res.status(400).json({ error: "Invalid email address" });
        return;
    }
    try {
        const hash = await bcrypt.hash(password, 12);
        const normalizedEmail = email.toLowerCase().trim();
        const result = await pool.query(`INSERT INTO pm_users (email, password_hash, display_name, is_admin)
       VALUES ($1, $2, $3, lower($1) = lower($4)) RETURNING id, email, display_name, is_admin, created_at`, [normalizedEmail, hash, displayName?.trim() || null, bootstrapAdminEmail]);
        const user = result.rows[0];
        const token = setSessionCookie(res, { userId: user.id, email: user.email });
        res.status(201).json({ token, user: result.rows[0] });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unique") || msg.includes("duplicate")) {
            res.status(409).json({ error: "An account with this email already exists" });
        }
        else {
            console.error("Register error:", err);
            res.status(500).json({ error: "Registration failed" });
        }
    }
});
router.post("/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
    }
    try {
        const result = await pool.query(`SELECT id, email, password_hash, display_name, is_admin, created_at FROM pm_users WHERE email = $1`, [email.toLowerCase().trim()]);
        if (result.rows.length === 0) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        const token = setSessionCookie(res, { userId: user.id, email: user.email });
        res.json({
            token,
            user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin, created_at: user.created_at },
        });
    }
    catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Login failed" });
    }
});
router.post("/logout", (_req, res) => {
    res.clearCookie("pm_token");
    res.json({ ok: true });
});
router.get("/me", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, email, display_name, is_admin, created_at, github_token IS NOT NULL AS has_github_token FROM pm_users WHERE id = $1`, [req.user.userId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "User not found" });
            return;
        }
        res.json({ user: result.rows[0] });
    }
    catch (err) {
        console.error("Me error:", err);
        res.status(500).json({ error: "Failed to fetch user" });
    }
});
// PATCH /api/auth/profile — update display name
router.patch("/profile", requireAuth, async (req, res) => {
    const { displayName } = req.body;
    try {
        const result = await pool.query(`UPDATE pm_users SET display_name = $1 WHERE id = $2
       RETURNING id, email, display_name, is_admin, created_at, github_token IS NOT NULL AS has_github_token`, [displayName?.trim() || null, req.user.userId]);
        res.json({ user: result.rows[0] });
    }
    catch (err) {
        console.error("Update profile error:", err);
        res.status(500).json({ error: "Failed to update profile" });
    }
});
// POST /api/auth/change-password
router.post("/change-password", requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        res.status(400).json({ error: "Current and new passwords are required" });
        return;
    }
    if (newPassword.length < 8) {
        res.status(400).json({ error: "New password must be at least 8 characters" });
        return;
    }
    try {
        const result = await pool.query(`SELECT password_hash FROM pm_users WHERE id = $1`, [req.user.userId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "User not found" });
            return;
        }
        const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        if (!valid) {
            res.status(401).json({ error: "Current password is incorrect" });
            return;
        }
        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query(`UPDATE pm_users SET password_hash = $1 WHERE id = $2`, [hash, req.user.userId]);
        res.json({ ok: true });
    }
    catch (err) {
        console.error("Change password error:", err);
        res.status(500).json({ error: "Failed to change password" });
    }
});
// PATCH /api/auth/github-token — save or clear GitHub PAT
router.patch("/github-token", requireAuth, async (req, res) => {
    const { token } = req.body;
    try {
        const trimmedToken = token?.trim() || "";
        const encryptedToken = trimmedToken ? encryptSecret(trimmedToken) : null;
        await pool.query(`UPDATE pm_users SET github_token = $1 WHERE id = $2`, [encryptedToken, req.user.userId]);
        res.json({ ok: true, hasToken: Boolean(trimmedToken) });
    }
    catch (err) {
        console.error("GitHub token error:", err);
        res.status(500).json({ error: "Failed to save GitHub token" });
    }
});
export { router as authRouter };
//# sourceMappingURL=auth.js.map