import { Router, type NextFunction, type Response } from "express";
import { pool } from "../db.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await pool.query(`SELECT is_admin FROM pm_users WHERE id = $1`, [req.user!.userId]);
    if (result.rows[0]?.is_admin === true) {
      next();
      return;
    }
    res.status(403).json({ error: "Admin access is required" });
  } catch (err) {
    console.error("Admin auth check failed:", err);
    res.status(500).json({ error: "Failed to verify admin access" });
  }
}

router.use(requireAdmin);

router.get("/overview", async (_req, res) => {
  try {
    const [users, projects, shares, groups] = await Promise.all([
      pool.query(`
        SELECT id, email, display_name, is_admin, github_token IS NOT NULL AS has_github_token, created_at, updated_at
        FROM pm_users
        ORDER BY is_admin DESC, created_at DESC
      `),
      pool.query(`
        SELECT p.id, p.name, p.slug, p.prefix, p.description, p.github_owner, p.github_repo,
               p.github_sync_enabled, p.created_at, p.updated_at,
               u.email AS owner_email, u.display_name AS owner_display_name
        FROM pm_projects p
        JOIN pm_users u ON u.id = p.user_id
        ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC
      `),
      pool.query(`SELECT COUNT(*)::int AS count FROM pm_project_shares`),
      pool.query(`
        SELECT g.id, g.name, g.description, owner.email AS owner_email, COUNT(m.id)::int AS member_count, g.created_at
        FROM pm_groups g
        JOIN pm_users owner ON owner.id = g.owner_id
        LEFT JOIN pm_group_members m ON m.group_id = g.id
        GROUP BY g.id, owner.email
        ORDER BY g.created_at DESC
      `),
    ]);

    res.json({
      users: users.rows,
      projects: projects.rows,
      groups: groups.rows,
      stats: {
        users: users.rowCount,
        admins: users.rows.filter((user) => user.is_admin === true).length,
        projects: projects.rowCount,
        sharedProjects: shares.rows[0]?.count ?? 0,
        groups: groups.rowCount,
      },
    });
  } catch (err) {
    console.error("Admin overview failed:", err);
    res.status(500).json({ error: "Failed to load admin overview" });
  }
});

router.patch("/users/:id", async (req, res) => {
  const { isAdmin } = req.body as { isAdmin?: boolean };
  if (typeof isAdmin !== "boolean") {
    res.status(400).json({ error: "isAdmin boolean is required" });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE pm_users SET is_admin = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, display_name, is_admin, github_token IS NOT NULL AS has_github_token, created_at, updated_at`,
      [isAdmin, req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("Admin user update failed:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

export { router as adminRouter };
