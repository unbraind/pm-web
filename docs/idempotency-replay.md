# Current authorization for idempotent replay

A retained Idempotency-Key prevents another execution; it does not grant continuing access to the first response. Before returning a settled response, the common idempotency middleware invokes the application's current replay authorizer for the same verified account, request fingerprint and resource. This also runs after waiting for an in-flight original. Access checks never invoke mutation handlers.

Only the 78 canonical mutation routes in `src/idempotency-routes.ts` can replay through the production policy. A regression compares this inventory with every protected router registration. A new or unregistered route fails closed until its permission and response-resource requirements are audited. Embedders of `idempotencyGuard` must supply a current authorization callback; the default refuses replay. Authentication endpoints remain live and are excluded from keying. Shared-project listing and other GET/HEAD/OPTIONS reads are never cached by this mechanism.

| Family | Current authorization and body visibility |
| --- | --- |
| Projects create/update/delete | Existing account; currently owned, existing result/target project. |
| PM item, annotation, relationship, bulk, schema, configuration, Plan and inbox mutations | Fresh `verifyProjectAccess` with edit capability. Singular and created item/Plan identities, explicit relationship endpoints and bounded response/batch IDs are read through the existing SDK loader. Missing items refuse replay; batches exceeding 50 identities require a live reconciliation read. |
| Agent context publish/revoke | Fresh project capability, current packet existence, publisher identity, consent audience and exact revision. Removing access, replacing a revision or deleting a packet prevents returning its stored snapshot. |
| Project sharing | Current project ownership, existing share association, and current group membership when granting a group share. |
| Group creation/update/deletion and invitations/removals | Current ownership, or the original self-removal rule plus existing membership; created groups and invited-member associations must still exist. |
| Admin mutations | Current database admin flag, plus existence of the affected user/project/group. A signed token does not retain an old admin role. |
| Package install/activation/deactivation/removal | Current project edit capability and catalog identity. |
| GitHub writes, extension command execution, graph query and presence sessions | Current project capability is checked, then cached opaque output is refused with `PM_IDEMPOTENCY_REPLAY_REQUIRES_LIVE_READ`. These surfaces have provider/command/session capabilities that project membership alone cannot certify. Reconcile with a fresh authorized read instead of repeating the mutation. |

Refusals carry `code`, `error` and `remedy`, never the old body, and use `Cache-Control: no-store, private`. They do not delete or overwrite the original key or outcome. Regranting an actually readable resource can permit replay again; revocation never silently retries a committed mutation. Missing result resources (including completed deletions) return a typed refusal rather than the old data or acknowledgment. Unknown outcomes retain their existing reconciliation behavior. Retention and fingerprint-conflict rules are unchanged.

## Audited routes

All routes below sit behind the common production callback. No changes were made to hosted services or data.

| Method | Route |
| --- | --- |
| POST | `/api/projects` |
| PATCH | `/api/projects/:id` |
| DELETE | `/api/projects/:id` |
| POST | `/api/projects/:projectId/pm/schema/add-type` |
| POST | `/api/projects/:projectId/pm/items/:itemId/history-repair` |
| POST | `/api/projects/:projectId/pm/create` |
| PATCH | `/api/projects/:projectId/pm/update/:itemId` |
| POST | `/api/projects/:projectId/pm/close/:itemId` |
| DELETE | `/api/projects/:projectId/pm/delete/:itemId` |
| POST | `/api/projects/:projectId/pm/comments/:itemId` |
| POST | `/api/projects/:projectId/pm/notes/:itemId` |
| POST | `/api/projects/:projectId/pm/search` |
| POST | `/api/projects/:projectId/pm/append/:itemId` |
| POST | `/api/projects/:projectId/pm/deps/:itemId` |
| DELETE | `/api/projects/:projectId/pm/deps/:itemId` |
| POST | `/api/projects/:projectId/pm/rel` |
| DELETE | `/api/projects/:projectId/pm/rel` |
| POST | `/api/projects/:projectId/pm/graph/provision` |
| POST | `/api/projects/:projectId/pm/graph/sync` |
| POST | `/api/projects/:projectId/pm/graph/query` |
| POST | `/api/projects/:projectId/pm/learnings/:itemId` |
| POST | `/api/projects/:projectId/pm/claim/:itemId` |
| POST | `/api/projects/:projectId/pm/release/:itemId` |
| POST | `/api/projects/:projectId/pm/start-task/:itemId` |
| POST | `/api/projects/:projectId/pm/pause-task/:itemId` |
| POST | `/api/projects/:projectId/pm/tests/:itemId` |
| POST | `/api/projects/:projectId/pm/restore/:itemId` |
| POST | `/api/projects/:projectId/pm/close-task/:itemId` |
| POST | `/api/projects/:projectId/pm/reindex` |
| POST | `/api/projects/:projectId/pm/normalize` |
| POST | `/api/projects/:projectId/pm/files/:itemId` |
| POST | `/api/projects/:projectId/pm/import` |
| POST | `/api/projects/:projectId/pm/update-many` |
| POST | `/api/projects/:projectId/pm/close-many` |
| POST | `/api/projects/:projectId/pm/docs/:itemId` |
| POST | `/api/projects/:projectId/pm/test-all` |
| POST | `/api/projects/:projectId/pm/gc` |
| PATCH | `/api/projects/:projectId/pm/config/:key` |
| POST | `/api/projects/:projectId/pm/decision-inbox/requests` |
| POST | `/api/projects/:projectId/pm/decision-inbox/responses` |
| POST | `/api/projects/:projectId/pm/plan` |
| PATCH | `/api/projects/:projectId/pm/plan/:planId` |
| DELETE | `/api/projects/:projectId/pm/plan/:planId` |
| POST | `/api/projects/:projectId/pm/plan/:planId/steps` |
| PATCH | `/api/projects/:projectId/pm/plan/:planId/steps/:stepRef` |
| POST | `/api/projects/:projectId/pm/plan/:planId/steps/:stepRef/complete` |
| POST | `/api/projects/:projectId/pm/plan/:planId/steps/:stepRef/block` |
| DELETE | `/api/projects/:projectId/pm/plan/:planId/steps/:stepRef` |
| POST | `/api/projects/:projectId/pm/plan/:planId/approve` |
| POST | `/api/projects/:projectId/pm/plan/:planId/materialize` |
| POST | `/api/projects/:projectId/pm/plan/:planId/steps/:stepRef/reorder` |
| POST | `/api/projects/:projectId/pm/plan/:planId/link` |
| DELETE | `/api/projects/:projectId/pm/plan/:planId/link` |
| POST | `/api/projects/:projectId/pm/upgrade` |
| PATCH | `/api/projects/:projectId/pm/presence/:clientId` |
| POST | `/api/projects/:projectId/pm/agent-context` |
| DELETE | `/api/projects/:projectId/pm/agent-context/:packetId` |
| POST | `/api/projects/:projectId/extensions/:name/install` |
| POST | `/api/projects/:projectId/extensions/:name/run` |
| POST | `/api/projects/:projectId/extensions/:name/activate` |
| POST | `/api/projects/:projectId/extensions/:name/deactivate` |
| DELETE | `/api/projects/:projectId/extensions/:name` |
| POST | `/api/projects/:id/shares` |
| DELETE | `/api/projects/:id/shares/:shareId` |
| PATCH | `/api/projects/:id/github` |
| POST | `/api/projects/:id/github/import` |
| POST | `/api/projects/:id/github/push` |
| PATCH | `/api/projects/:id/github/push/:itemId` |
| POST | `/api/groups` |
| PATCH | `/api/groups/:id` |
| DELETE | `/api/groups/:id` |
| POST | `/api/groups/:id/members` |
| DELETE | `/api/groups/:id/members/:userId` |
| PATCH | `/api/admin/users/:id` |
| DELETE | `/api/admin/users/:id` |
| DELETE | `/api/admin/projects/:id` |
| POST | `/api/admin/groups` |
| DELETE | `/api/admin/groups/:id` |
