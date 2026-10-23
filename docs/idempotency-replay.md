# Current authorization for idempotent replay

A retained Idempotency-Key prevents another execution; it does not grant continuing access to the original response content. The middleware binds every replay to the same verified account and exact request fingerprint. Authentication, expected-account checks, rate limits and retained keys remain in effect, including while waiting for an original request to settle.

Successful mutations have two replay forms:

- A successful DELETE always returns a content-free settlement receipt, even when its target or the caller's later access has gone. The original HTTP success status is preserved. JSON receipts contain only `status` and a bounded `ids` array; 204/205 keep their empty-body semantics.
- Other successful mutations return their original body only after current read/capability checks pass. If content can no longer be authorized, they return the same content-free success receipt. Opaque provider output and legacy plain-text success bodies also settle without returning that content.

Outcome-only responses carry `Idempotency-Replayed: true`, `Idempotency-Outcome-Only: true` and `Cache-Control: no-store, private`. The receipt is evidence of the original operation, not permission to retrieve a deleted packet or read a formerly shared resource. Clients needing content must issue a fresh authorized read. Receipts include only validated route/result identifiers, with at most 50 identifiers; questions, receipts, names, email addresses, revisions, provider output and tokens are excluded. No mutation handler is called again, and the original key/outcome is neither overwritten nor deleted.

Only the 78 canonical mutation routes in `src/idempotency-routes.ts` can use the production replay policy. A regression compares this inventory with every protected router registration. Unregistered policies and unconfigured embedders fail closed. Authentication endpoints remain live and are excluded from keying. GET/HEAD/OPTIONS reads are not memoized. Non-success outcomes still require current authorization before returning any stored content; refusal responses carry `code`, `error` and `remedy` without the old body. Retention, unknown-outcome reconciliation and fingerprint-conflict rules are unchanged.

| Content-bearing replay family | Current authorization and body visibility |
| --- | --- |
| Projects create/update/delete | Existing account; currently owned, existing result/target project. Successful deletions use settlement receipts. |
| PM item, annotation, relationship, bulk, schema, configuration, Plan and inbox mutations | Fresh `verifyProjectAccess` with edit capability; known item/Plan identities are checked through the existing SDK loader. Large batches require a fresh read for content. |
| Contract input previews | Fresh project access; mutation previews require edit capability, while read-only previews permit viewers. Replays return the stored unexecuted envelope; revoked access settles without its input content. |
| Agent context publish/revoke | Current project capability, existing packet, publisher identity, audience and exact revision before returning any packet content. Removed/replaced packets never replay old questions or evidence. Successful revocations settle independently of content. |
| Project sharing | Current project ownership, existing share association, and current group membership when granting a group share. |
| Groups and members | Current ownership or the original self-removal rule, plus existing result/member associations. |
| Admin mutations | Current database admin flag and existence of the affected resource. |
| Package lifecycle | Current project edit capability and catalog identity. |
| GitHub writes, extension commands, graph query and presence sessions | Their independent provider/session capabilities cannot certify cached opaque content. Successful operations return settlement receipts; non-success replay requires a live reconciliation read. |

The service worker drains an owned queued DELETE on success, or on terminal HTTP 404/410. A successful IndexedDB removal precedes the settlement notification. An unavailable target is not described as proof of deletion: the current account sees a dismissible notice that the queued deletion was removed because its target is no longer available. Other accounts, unknown-owner records, non-delete 404s, forbidden responses, network failures and failed queue storage remain preserved. Typed non-success replay refusals enter the existing needs-attention flow with explicit owner recovery instead of silently blocking later workspace work. A packet DELETE revision conflict, including one after its original outcome expires, also offers owner recovery; it is never silently treated as proof of deletion. Later owned work in the same workspace can proceed after the delete settles.

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
| POST | `/api/projects/:projectId/pm/contracts/review` |
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
