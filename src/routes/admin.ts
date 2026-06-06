import { Router, type NextFunction, type Response } from "express";
import { pool } from "../db.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { routeParam } from "./route-params.js";

const router = Router();

router.use(requireAuth);

async function getAdminCount(): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM pm_users WHERE is_admin = TRUE`);
  return result.rows[0]?.count ?? 0;
}

async function isUserAdmin(userId: string): Promise<boolean> {
  const result = await pool.query(`SELECT is_admin FROM pm_users WHERE id = $1`, [userId]);
  return result.rows[0]?.is_admin === true;
}

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
      serverVersion: process.env.npm_package_version || '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch (err) {
    console.error("Admin overview failed:", err);
    res.status(500).json({ error: "Failed to load admin overview" });
  }
});

router.patch("/users/:id", async (req: AuthRequest, res) => {
  const { isAdmin } = req.body as { isAdmin?: boolean };
  if (typeof isAdmin !== "boolean") {
    res.status(400).json({ error: "isAdmin boolean is required" });
    return;
  }

  try {
    const currentAdmin = await isUserAdmin(routeParam(req, "id"));
    if (currentAdmin && !isAdmin) {
      const adminCount = await getAdminCount();
      if (adminCount <= 1) {
        res.status(409).json({ error: "Cannot remove the last admin user." });
        return;
      }
    }

    const result = await pool.query(
      `UPDATE pm_users SET is_admin = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, display_name, is_admin, github_token IS NOT NULL AS has_github_token, created_at, updated_at`,
      [isAdmin, routeParam(req, "id")]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await logAudit(req.user!.userId, "user.update", `Set is_admin=${isAdmin} for user ${routeParam(req, "id")}`);
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("Admin user update failed:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// DELETE /admin/users/:id — Delete a user and all their data
router.delete("/users/:id", async (req: AuthRequest, res) => {
  try {
    if (await isUserAdmin(routeParam(req, "id"))) {
      const adminCount = await getAdminCount();
      if (adminCount <= 1) {
        res.status(409).json({ error: "Cannot delete the last admin user." });
        return;
      }
    }

    const result = await pool.query(`DELETE FROM pm_users WHERE id = $1 RETURNING id, email`, [routeParam(req, "id")]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await logAudit(req.user!.userId, "user.delete", `Deleted user ${result.rows[0].email} (${routeParam(req, "id")})`);
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error("Admin user delete failed:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// DELETE /admin/projects/:id — Delete a project
router.delete("/projects/:id", async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(`DELETE FROM pm_projects WHERE id = $1 RETURNING id, name, slug`, [routeParam(req, "id")]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await logAudit(req.user!.userId, "project.delete", `Deleted project ${result.rows[0].name} (${routeParam(req, "id")})`);
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error("Admin project delete failed:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// POST /admin/groups — Create a new group
router.post("/groups", async (req: AuthRequest, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "Group name is required" });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO pm_groups (owner_id, name, description) VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at`,
      [req.user!.userId, name.trim(), description?.trim() || ""]
    );
    await logAudit(req.user!.userId, "group.create", `Created group "${name.trim()}"`);
    res.status(201).json({ group: result.rows[0] });
  } catch (err) {
    console.error("Admin group create failed:", err);
    res.status(500).json({ error: "Failed to create group" });
  }
});

// DELETE /admin/groups/:id — Delete a group
router.delete("/groups/:id", async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(`DELETE FROM pm_groups WHERE id = $1 RETURNING id, name`, [routeParam(req, "id")]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    await logAudit(req.user!.userId, "group.delete", `Deleted group "${result.rows[0].name}" (${routeParam(req, "id")})`);
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error("Admin group delete failed:", err);
    res.status(500).json({ error: "Failed to delete group" });
  }
});

// GET /admin/audit — Retrieve audit log entries
router.get("/audit", async (req: AuthRequest, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = parseInt(req.query.offset as string) || 0;
  try {
    const [entries, countResult] = await Promise.all([
      pool.query(
        `SELECT a.id, a.action, a.description, a.created_at, u.email AS actor_email, u.display_name AS actor_name
         FROM pm_admin_audit a
         JOIN pm_users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM pm_admin_audit`),
    ]);
    res.json({ entries: entries.rows, total: countResult.rows[0]?.count ?? 0, limit, offset });
  } catch (err) {
    console.error("Admin audit log failed:", err);
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

async function logAudit(actorId: string, action: string, description: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO pm_admin_audit (actor_id, action, description) VALUES ($1, $2, $3)`,
      [actorId, action, description]
    );
  } catch (err) {
    console.error("Audit log write failed:", err);
  }
}

export { router as adminRouter };
