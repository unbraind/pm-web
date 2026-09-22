import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { routeParam, requireUuidParams, uuidParamGuard } from "./route-params.js";
import { findUserByEmail } from "./route-helpers.js";
const sharesRouter = Router({ mergeParams: true });
sharesRouter.use(requireAuth);
// The project id arrives from the mount path (/api/projects/:id/shares) and is
// visible to router-level middleware because this router sets mergeParams;
// :shareId is this router's own parameter, so it needs the param hook instead.
sharesRouter.use(requireUuidParams("id", "projectId"));
sharesRouter.param("shareId", uuidParamGuard("shareId"));
// Helper: verify project ownership for sharing operations
/**
 * Report whether the given user owns the given project.
 *
 * Sharing and share-management operations are owner-only, so this checks that
 * a `pm_projects` row exists with both the project id and the user id. Returns
 * a boolean (callers turn a `false` into a 404 rather than revealing that the
 * project exists but is not theirs).
 */
async function verifyProjectOwner(userId, projectId) {
    const result = await pool.query(`SELECT id FROM pm_projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
    return result.rows.length > 0;
}
/**
 * Resolve the project id from the merged route params and verify the current
 * user owns it, sending a 404 and returning `null` when they do not.
 *
 * Every share-management handler (GET, POST, DELETE) needs the same
 * project-id resolution followed by the same owner check and 404 response;
 * centralising it here removes the triplicated block that the duplication
 * gate flagged.
 *
 * @returns The validated project id, or `null` when ownership failed (the
 *   404 response has already been sent).
 */
async function requireShareOwner(req, res) {
    const projectId = routeParam(req, "id") || routeParam(req, "projectId");
    const isOwner = await verifyProjectOwner(req.user.userId, projectId);
    if (!isOwner) {
        res.status(404).json({ error: "Project not found" });
        return null;
    }
    return projectId;
}
// GET /api/projects/:id/shares - list who the project is shared with
sharesRouter.get("/", async (req, res) => {
    try {
        const projectId = await requireShareOwner(req, res);
        if (!projectId)
            return;
        const result = await pool.query(`SELECT ps.id, ps.permission, ps.shared_at,
              u.id AS user_id, u.email AS user_email, u.display_name AS user_display_name,
              g.id AS group_id, g.name AS group_name
       FROM pm_project_shares ps
       LEFT JOIN pm_users u ON u.id = ps.shared_with_user_id
       LEFT JOIN pm_groups g ON g.id = ps.shared_with_group_id
       WHERE ps.project_id = $1
       ORDER BY ps.shared_at DESC`, [projectId]);
        res.json({ shares: result.rows });
    }
    catch (err) {
        console.error("List shares error:", err);
        res.status(500).json({ error: "Failed to fetch shares" });
    }
});
// POST /api/projects/:id/shares - share project
sharesRouter.post("/", async (req, res) => {
    const { email, groupId, permission } = req.body;
    if (!email && !groupId) {
        res.status(400).json({ error: "Either email or groupId is required" });
        return;
    }
    if (email && groupId) {
        res.status(400).json({ error: "Provide either email or groupId, not both" });
        return;
    }
    const perm = permission === "edit" ? "edit" : "view";
    try {
        const projectId = await requireShareOwner(req, res);
        if (!projectId)
            return;
        if (email) {
            // Share with a user
            const targetUser = await findUserByEmail(email);
            if (!targetUser) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            // Prevent sharing with yourself
            if (targetUser.id === req.user.userId) {
                res.status(400).json({ error: "Cannot share project with yourself" });
                return;
            }
            const shareResult = await pool.query(`INSERT INTO pm_project_shares (project_id, shared_with_user_id, permission)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, shared_with_user_id) DO UPDATE SET permission = EXCLUDED.permission
         RETURNING id, permission, shared_at`, [projectId, targetUser.id, perm]);
            res.status(201).json({
                share: {
                    ...shareResult.rows[0],
                    user_id: targetUser.id,
                    user_email: targetUser.email,
                    user_display_name: targetUser.display_name,
                },
            });
        }
        else {
            // Share with a group - verify group exists and requester is member/owner
            const groupCheck = await pool.query(`SELECT g.id, g.name FROM pm_groups g
         JOIN pm_group_members gm ON gm.group_id = g.id AND gm.user_id = $2
         WHERE g.id = $1`, [groupId, req.user.userId]);
            if (groupCheck.rows.length === 0) {
                res.status(404).json({ error: "Group not found or you are not a member" });
                return;
            }
            const targetGroup = groupCheck.rows[0];
            const shareResult = await pool.query(`INSERT INTO pm_project_shares (project_id, shared_with_group_id, permission)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, shared_with_group_id) DO UPDATE SET permission = EXCLUDED.permission
         RETURNING id, permission, shared_at`, [projectId, groupId, perm]);
            res.status(201).json({
                share: {
                    ...shareResult.rows[0],
                    group_id: targetGroup.id,
                    group_name: targetGroup.name,
                },
            });
        }
    }
    catch (err) {
        console.error("Create share error:", err);
        res.status(500).json({ error: "Failed to share project" });
    }
});
// DELETE /api/projects/:id/shares/:shareId - remove a share
sharesRouter.delete("/:shareId", async (req, res) => {
    try {
        const projectId = await requireShareOwner(req, res);
        if (!projectId)
            return;
        const result = await pool.query(`DELETE FROM pm_project_shares WHERE id = $1 AND project_id = $2 RETURNING id`, [routeParam(req, "shareId"), projectId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "Share not found" });
            return;
        }
        res.json({ ok: true });
    }
    catch (err) {
        console.error("Delete share error:", err);
        res.status(500).json({ error: "Failed to remove share" });
    }
});
// GET /api/shared - list projects shared with me
const sharedWithMeRouter = Router();
sharedWithMeRouter.use(requireAuth);
sharedWithMeRouter.get("/", async (req, res) => {
    try {
        const result = await pool.query(`SELECT DISTINCT p.id, p.name, p.slug, p.description, p.prefix,
              p.user_id AS owner_id,
              u.email AS owner_email, u.display_name AS owner_display_name,
              ps.permission, ps.shared_at
       FROM pm_projects p
       JOIN pm_project_shares ps ON ps.project_id = p.id
       JOIN pm_users u ON u.id = p.user_id
       WHERE
         ps.shared_with_user_id = $1
         OR ps.shared_with_group_id IN (
           SELECT group_id FROM pm_group_members WHERE user_id = $1
         )
       ORDER BY ps.shared_at DESC`, [req.user.userId]);
        res.json({ projects: result.rows });
    }
    catch (err) {
        console.error("List shared projects error:", err);
        res.status(500).json({ error: "Failed to fetch shared projects" });
    }
});
export { sharesRouter, sharedWithMeRouter };
//# sourceMappingURL=sharing.js.map