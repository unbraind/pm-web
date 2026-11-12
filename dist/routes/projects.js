import { readProjectAccess } from '../services/project-access.js';
import { invalidateProjectAccess } from '../services/access-invalidation.js';
import { logError } from "../observability.js";
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { initProject, deleteProjectDir, getProjectDir, pinProjectStorage, runSerialized, ProjectStorageChangedError } from "../services/pm-runner.js";
import { routeParam, uuidParamGuard } from "./route-params.js";
import { isUniqueViolation, notFoundWhenEmpty } from "./route-helpers.js";
const router = Router();
router.use(requireAuth);
// :id is a project UUID; reject a malformed one with 400 before it reaches SQL.
router.param("id", uuidParamGuard("id"));
/**
 * Check if a user has access to a project (either as owner or via share).
 * Returns the project row with an additional `ownerUserId` field indicating
 * whose pm data directory to use when running pm CLI commands.
 */
export async function verifyProjectAccess(userId, projectId) {
    return readProjectAccess(pool, userId, projectId);
}
router.get("/", async (req, res) => {
    try {
        // Return own projects plus projects shared with me (via user or group)
        const result = await pool.query(`SELECT DISTINCT p.id, p.name, p.slug, p.description, p.prefix,
              p.created_at, p.updated_at,
              p.user_id = $1 AS is_owner,
              CASE WHEN p.user_id = $1 OR BOOL_OR(ps.permission = 'edit') THEN 'edit' ELSE 'view' END AS permission
       FROM pm_projects p
       LEFT JOIN pm_project_shares ps ON ps.project_id = p.id AND (
         ps.shared_with_user_id = $1
         OR ps.shared_with_group_id IN (
           SELECT group_id FROM pm_group_members WHERE user_id = $1
         )
       )
       WHERE p.user_id = $1 OR ps.id IS NOT NULL
       GROUP BY p.id, p.name, p.slug, p.description, p.prefix, p.created_at, p.updated_at, p.user_id
       ORDER BY p.created_at DESC`, [req.user.userId]);
        res.json({ projects: result.rows });
    }
    catch (err) {
        logError("list_projects_error", err);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});
router.post("/", async (req, res) => {
    const { name, description, prefix } = req.body;
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
        const result = await pool.query(`INSERT INTO pm_projects (user_id, name, slug, description, prefix)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug, description, prefix, created_at`, [req.user.userId, name.trim(), slug, description?.trim() || "", prefix.trim()]);
        const project = result.rows[0];
        // Initialize pm storage in the project directory
        try {
            await initProject(req.user.userId, project.slug, project.prefix);
        }
        catch (err) {
            // Remove the row after storage cleanup. If cleanup fails, retain the row
            // so an explicit project deletion can retry without orphaning its files.
            try {
                await removeOwnedProject(req.user.userId, project.id);
            }
            catch (cleanupError) {
                logError("project_cleanup_error", cleanupError);
                throw err;
            }
            throw err;
        }
        res.status(201).json({ project: { ...project, permission: "edit" } });
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            res.status(409).json({ error: "A project with this name already exists" });
        }
        else {
            logError("create_project_error", err);
            res.status(500).json({ error: "Failed to create project" });
        }
    }
});
router.get("/:id", async (req, res) => {
    try {
        const access = await verifyProjectAccess(req.user.userId, routeParam(req, "id"));
        if (!access) {
            res.status(404).json({ error: "Project not found" });
            return;
        }
        res.json({ project: access });
    }
    catch (err) {
        logError("get_project_error", err);
        res.status(500).json({ error: "Failed to fetch project" });
    }
});
router.patch("/:id", async (req, res) => {
    const { name, description } = req.body;
    try {
        const updateArgs = [
            name?.trim() || null,
            description !== undefined ? description : null,
            routeParam(req, "id"),
            req.user.userId,
        ];
        const result = await pool.query(`UPDATE pm_projects SET name = COALESCE($1, name), description = COALESCE($2, description)
       WHERE id = $3 AND user_id = $4
       RETURNING id, name, slug, description, prefix, created_at, updated_at`, updateArgs);
        if (notFoundWhenEmpty(res, result.rows, "Project not found"))
            return;
        res.json({ project: result.rows[0] });
    }
    catch (err) {
        logError("update_project_error", err);
        res.status(500).json({ error: "Failed to update project" });
    }
});
/** Remove owned storage under both a row transaction and its physical queue, including failed-init cleanup. */
async function removeOwnedProject(userId, projectId) {
    // The discovery query releases its connection before any tracker admission wait.
    const initial = await pool.query('SELECT slug FROM pm_projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
    if (!initial.rows[0])
        return false;
    const { slug } = initial.rows[0];
    const directory = getProjectDir(userId, slug);
    const removed = await runSerialized(directory, async (admitted) => {
        const client = await pool.connect();
        const transaction = { open: false };
        try {
            await client.query('BEGIN');
            transaction.open = true;
            const locked = await client.query('SELECT slug FROM pm_projects WHERE id = $1 AND user_id = $2 FOR UPDATE', [projectId, userId]);
            if (!locked.rows[0]) {
                await client.query('ROLLBACK');
                transaction.open = false;
                return false;
            }
            if (locked.rows[0].slug !== slug)
                throw new ProjectStorageChangedError();
            const current = await pinProjectStorage(directory);
            if (current.workspace !== admitted.workspace || current.tracker !== admitted.tracker)
                throw new ProjectStorageChangedError();
            await deleteProjectDir(admitted);
            await client.query('DELETE FROM pm_projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
            await client.query('COMMIT');
            transaction.open = false;
            return true;
        }
        catch (error) {
            if (transaction.open) {
                try {
                    await client.query('ROLLBACK');
                    transaction.open = false;
                }
                catch (rollbackError) {
                    logError('delete_project_rollback_error', rollbackError);
                }
            }
            throw error;
        }
        finally {
            client.release(transaction.open);
        }
    });
    if (removed)
        invalidateProjectAccess(projectId);
    return removed;
}
router.delete("/:id", async (req, res) => {
    try {
        if (!await removeOwnedProject(req.user.userId, routeParam(req, 'id'))) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }
        res.json({ ok: true });
    }
    catch (err) {
        if (err instanceof ProjectStorageChangedError) {
            res.status(409).json({ error: 'Project storage changed while the deletion waited; retry the deletion' });
            return;
        }
        logError('delete_project_error', err);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});
export { router as projectsRouter };
//# sourceMappingURL=projects.js.map