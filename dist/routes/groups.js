import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
const router = Router();
router.use(requireAuth);
// GET /api/groups - list groups I own or am a member of
router.get("/", async (req, res) => {
    try {
        const result = await pool.query(`SELECT g.id, g.owner_id, g.name, g.description, g.created_at, g.updated_at,
              gm.role,
              (SELECT COUNT(*) FROM pm_group_members WHERE group_id = g.id) AS member_count
       FROM pm_groups g
       JOIN pm_group_members gm ON gm.group_id = g.id AND gm.user_id = $1
       ORDER BY g.created_at DESC`, [req.user.userId]);
        res.json({ groups: result.rows });
    }
    catch (err) {
        console.error("List groups error:", err);
        res.status(500).json({ error: "Failed to fetch groups" });
    }
});
// POST /api/groups - create a group
router.post("/", async (req, res) => {
    const { name, description } = req.body;
    if (!name?.trim()) {
        res.status(400).json({ error: "Group name is required" });
        return;
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const groupResult = await client.query(`INSERT INTO pm_groups (owner_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, owner_id, name, description, created_at, updated_at`, [req.user.userId, name.trim(), description?.trim() || ""]);
        const group = groupResult.rows[0];
        // Add owner as a member with role 'owner'
        await client.query(`INSERT INTO pm_group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`, [group.id, req.user.userId]);
        await client.query("COMMIT");
        res.status(201).json({ group: { ...groupResult.rows[0], role: "owner", member_count: "1" } });
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("Create group error:", err);
        res.status(500).json({ error: "Failed to create group" });
    }
    finally {
        client.release();
    }
});
// GET /api/groups/:id - get group details with members
router.get("/:id", async (req, res) => {
    try {
        // Check membership
        const memberCheck = await pool.query(`SELECT gm.role FROM pm_group_members gm
       WHERE gm.group_id = $1 AND gm.user_id = $2`, [req.params["id"], req.user.userId]);
        if (memberCheck.rows.length === 0) {
            res.status(404).json({ error: "Group not found" });
            return;
        }
        const groupResult = await pool.query(`SELECT id, owner_id, name, description, created_at, updated_at
       FROM pm_groups WHERE id = $1`, [req.params["id"]]);
        const group = groupResult.rows[0];
        const membersResult = await pool.query(`SELECT gm.id, gm.user_id, gm.role, gm.invited_at,
              u.email, u.display_name
       FROM pm_group_members gm
       JOIN pm_users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY gm.invited_at ASC`, [req.params["id"]]);
        res.json({ group: { ...group, members: membersResult.rows } });
    }
    catch (err) {
        console.error("Get group error:", err);
        res.status(500).json({ error: "Failed to fetch group" });
    }
});
// PATCH /api/groups/:id - update group (owner only)
router.patch("/:id", async (req, res) => {
    const { name, description } = req.body;
    try {
        const result = await pool.query(`UPDATE pm_groups
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = NOW()
       WHERE id = $3 AND owner_id = $4
       RETURNING id, owner_id, name, description, created_at, updated_at`, [name?.trim() || null, description !== undefined ? description : null, req.params["id"], req.user.userId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "Group not found or you are not the owner" });
            return;
        }
        res.json({ group: result.rows[0] });
    }
    catch (err) {
        console.error("Update group error:", err);
        res.status(500).json({ error: "Failed to update group" });
    }
});
// DELETE /api/groups/:id - delete group (owner only)
router.delete("/:id", async (req, res) => {
    try {
        const result = await pool.query(`DELETE FROM pm_groups WHERE id = $1 AND owner_id = $2 RETURNING id`, [req.params["id"], req.user.userId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "Group not found or you are not the owner" });
            return;
        }
        res.json({ ok: true });
    }
    catch (err) {
        console.error("Delete group error:", err);
        res.status(500).json({ error: "Failed to delete group" });
    }
});
// POST /api/groups/:id/members - invite user by email
router.post("/:id/members", async (req, res) => {
    const { email, role } = req.body;
    if (!email?.trim()) {
        res.status(400).json({ error: "Email is required" });
        return;
    }
    const memberRole = role === "owner" ? "owner" : "member";
    try {
        // Verify requester is owner
        const ownerCheck = await pool.query(`SELECT id FROM pm_groups WHERE id = $1 AND owner_id = $2`, [req.params["id"], req.user.userId]);
        if (ownerCheck.rows.length === 0) {
            res.status(403).json({ error: "Only the group owner can invite members" });
            return;
        }
        // Find the user by email
        const userResult = await pool.query(`SELECT id, email, display_name FROM pm_users WHERE email = $1`, [email.trim().toLowerCase()]);
        if (userResult.rows.length === 0) {
            res.status(404).json({ error: "User not found" });
            return;
        }
        const invitedUser = userResult.rows[0];
        const memberResult = await pool.query(`INSERT INTO pm_group_members (group_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, user_id, role, invited_at`, [req.params["id"], invitedUser.id, memberRole]);
        res.status(201).json({
            member: {
                ...memberResult.rows[0],
                email: invitedUser.email,
                display_name: invitedUser.display_name,
            },
        });
    }
    catch (err) {
        console.error("Invite member error:", err);
        res.status(500).json({ error: "Failed to invite member" });
    }
});
// DELETE /api/groups/:id/members/:userId - remove member
router.delete("/:id/members/:userId", async (req, res) => {
    try {
        // Verify requester is owner, OR member is removing themselves
        const isSelf = req.params["userId"] === req.user.userId;
        const ownerCheck = await pool.query(`SELECT id FROM pm_groups WHERE id = $1 AND owner_id = $2`, [req.params["id"], req.user.userId]);
        const isOwner = ownerCheck.rows.length > 0;
        if (!isOwner && !isSelf) {
            res.status(403).json({ error: "Not authorized to remove this member" });
            return;
        }
        // Prevent owner from removing themselves (they must delete the group instead)
        if (isSelf && isOwner) {
            res.status(400).json({ error: "Group owner cannot leave the group. Delete the group instead." });
            return;
        }
        const result = await pool.query(`DELETE FROM pm_group_members WHERE group_id = $1 AND user_id = $2 RETURNING id`, [req.params["id"], req.params["userId"]]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: "Member not found" });
            return;
        }
        res.json({ ok: true });
    }
    catch (err) {
        console.error("Remove member error:", err);
        res.status(500).json({ error: "Failed to remove member" });
    }
});
export { router as groupsRouter };
//# sourceMappingURL=groups.js.map