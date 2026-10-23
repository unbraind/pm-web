/** Canonical keyed mutation routes audited for current authorization before cached-body replay. */
export declare const IDEMPOTENT_MUTATION_ROUTES: readonly [{
    readonly method: 'POST';
    readonly path: '/api/projects';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:id';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:id';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/schema/add-type';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/items/:itemId/history-repair';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/create';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:projectId/pm/update/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/close/:itemId';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/delete/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/comments/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/notes/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/search';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/append/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/deps/:itemId';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/deps/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/rel';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/rel';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/graph/provision';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/graph/sync';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/graph/query';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/learnings/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/claim/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/release/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/start-task/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/pause-task/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/tests/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/restore/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/close-task/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/reindex';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/normalize';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/files/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/import';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/update-many';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/close-many';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/docs/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/test-all';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/gc';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:projectId/pm/config/:key';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/decision-inbox/requests';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/decision-inbox/responses';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:projectId/pm/plan/:planId';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/plan/:planId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/steps';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/steps/:stepRef';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/steps/:stepRef/complete';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/steps/:stepRef/block';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/steps/:stepRef';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/approve';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/materialize';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/steps/:stepRef/reorder';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/link';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/plan/:planId/link';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/upgrade';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:projectId/pm/presence/:clientId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/pm/agent-context';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/pm/agent-context/:packetId';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/extensions/:name/install';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/extensions/:name/run';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/extensions/:name/activate';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:projectId/extensions/:name/deactivate';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:projectId/extensions/:name';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:id/shares';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/projects/:id/shares/:shareId';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:id/github';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:id/github/import';
}, {
    readonly method: 'POST';
    readonly path: '/api/projects/:id/github/push';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/projects/:id/github/push/:itemId';
}, {
    readonly method: 'POST';
    readonly path: '/api/groups';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/groups/:id';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/groups/:id';
}, {
    readonly method: 'POST';
    readonly path: '/api/groups/:id/members';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/groups/:id/members/:userId';
}, {
    readonly method: 'PATCH';
    readonly path: '/api/admin/users/:id';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/admin/users/:id';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/admin/projects/:id';
}, {
    readonly method: 'POST';
    readonly path: '/api/admin/groups';
}, {
    readonly method: 'DELETE';
    readonly path: '/api/admin/groups/:id';
}];
