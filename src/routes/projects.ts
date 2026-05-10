import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { initProject, projectExists, deleteProjectDir } from "../services/pm-runner.js";

const router = Router();
router.use(requireAuth);

/**
 * Check if a user has access to a project (either as owner or via share).
 * Returns the project row with an additional `ownerUserId` field indicating
 * whose pm data directory to use when running pm CLI commands.
 */
export async function verifyProjectAccess(
  userId: string,
  projectId: string
): Promise<{ id: string; name: string; slug: string; description: string; prefix: string; ownerUserId: string; permission: string } | null> {
  // Check direct ownership first
  const ownResult = await pool.query(
    `SELECT id, name, slug, description, prefix, user_id AS owner_user_id
     FROM pm_projects WHERE id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  if (ownResult.rows.length > 0) {
    const row = ownResult.rows[0] as { id: string; name: string; slug: string; description: string; prefix: string; owner_user_id: string };
    return { ...row, ownerUserId: row.owner_user_id, permission: "edit" };
  }

  // Check shared access (user share or group share)
  const shareResult = await pool.query(
    `SELECT p.id, p.name, p.slug, p.description, p.prefix, p.user_id AS owner_user_id,
            MAX(ps.permission) AS permission
     FROM pm_projects p
     JOIN pm_project_shares ps ON ps.project_id = p.id
     WHERE p.id = $1 AND (
       ps.shared_with_user_id = $2
       OR ps.shared_with_group_id IN (
         SELECT group_id FROM pm_group_members WHERE user_id = $2
       )
     )
     GROUP BY p.id, p.name, p.slug, p.description, p.prefix, p.user_id`,
    [projectId, userId]
  );
  if (shareResult.rows.length > 0) {
    const row = shareResult.rows[0] as { id: string; name: string; slug: string; description: string; prefix: string; owner_user_id: string; permission: string };
    return { ...row, ownerUserId: row.owner_user_id };
  }

  return null;
}

router.get("/", async (req: AuthRequest, res) => {
  try {
    // Return own projects plus projects shared with me (via user or group)
    const result = await pool.query(
      `SELECT DISTINCT p.id, p.name, p.slug, p.description, p.prefix,
              p.created_at, p.updated_at,
              p.user_id = $1 AS is_owner,
              CASE WHEN p.user_id = $1 THEN 'edit' ELSE MAX(ps.permission) END AS permission
       FROM pm_projects p
       LEFT JOIN pm_project_shares ps ON ps.project_id = p.id AND (
         ps.shared_with_user_id = $1
         OR ps.shared_with_group_id IN (
           SELECT group_id FROM pm_group_members WHERE user_id = $1
         )
       )
       WHERE p.user_id = $1 OR ps.id IS NOT NULL
       GROUP BY p.id, p.name, p.slug, p.description, p.prefix, p.created_at, p.updated_at, p.user_id
       ORDER BY p.created_at DESC`,
      [req.user!.userId]
    );
    res.json({ projects: result.rows });
  } catch (err) {
    console.error("List projects error:", err);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

router.post("/", async (req: AuthRequest, res) => {
  const { name, description, prefix } = req.body as {
    name?: string;
    description?: string;
    prefix?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "Project name is required" });
    return;
  }
  if (!prefix?.trim()) {
    res.status(400).json({ error: "ID prefix is required" });
    return;
  }
  if (!/^[a-z0-9-]+$/.test(prefix.trim())) {
    res.status(400).json({ error: "Prefix must be lowercase letters, numbers, and hyphens only" });
    return;
  }

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  try {
    const result = await pool.query(
      `INSERT INTO pm_projects (user_id, name, slug, description, prefix)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug, description, prefix, created_at`,
      [req.user!.userId, name.trim(), slug, description?.trim() || "", prefix.trim()]
    );
    const project = result.rows[0] as { id: string; name: string; slug: string; prefix: string };

    // Initialize pm storage in the project directory
    try {
      initProject(req.user!.userId, project.slug, project.prefix);
    } catch (err) {
      // Rollback DB entry if pm init fails
      await pool.query("DELETE FROM pm_projects WHERE id = $1", [project.id]);
      throw err;
    }

    res.status(201).json({ project });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "A project with this name already exists" });
    } else {
      console.error("Create project error:", err);
      res.status(500).json({ error: "Failed to create project" });
    }
  }
});

router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const access = await verifyProjectAccess(req.user!.userId, req.params["id"]!);
    if (!access) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ project: access });
  } catch (err) {
    console.error("Get project error:", err);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

router.patch("/:id", async (req: AuthRequest, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  try {
    const result = await pool.query(
      `UPDATE pm_projects SET name = COALESCE($1, name), description = COALESCE($2, description)
       WHERE id = $3 AND user_id = $4
       RETURNING id, name, slug, description, prefix, created_at, updated_at`,
      [name?.trim() || null, description !== undefined ? description : null, req.params["id"], req.user!.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ project: result.rows[0] });
  } catch (err) {
    console.error("Update project error:", err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM pm_projects WHERE id = $1 AND user_id = $2 RETURNING slug`,
      [req.params["id"], req.user!.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const { slug } = result.rows[0] as { slug: string };
    deleteProjectDir(req.user!.userId, slug);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete project error:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

export { router as projectsRouter };
