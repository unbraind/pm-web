# Authorized project item reads

The item get, historical item, GET search, board, export and calendar feed routes
use one observational SDK boundary. This is the directory-provider slice of
[roadmap #260](https://github.com/unbraind/pm-web/issues/260). Native database
item storage is not implemented by this slice.

The search UI uses POST search. A fresh POST search checks access before its
queued CLI call and does not recheck access before returning results. That
surface remains outside this directory-reader slice.

`readAuthorizedProject` resolves the current account/share grant before binding
an SDK reader. Its bounded LRU caches only immutable read capabilities, keyed by
the normalized principal, project identity, effective permission and directory
binding. It never caches grants or item values. Routes cannot supply a tracker
root or dispatch arbitrary commands through the reader.

The reader joins the same workspace queue as existing web mutations. Workspace
and tracker symlink aliases share the physical tracker queue. It checks access again after waiting and immediately before returning data. Revocation
returns 404; a changed effective permission or storage mapping returns 409 and
requires a fresh request. The final authorization query is the read's admission
point. It does not promise a transaction spanning account grants and item
storage, or a global snapshot across independently written item histories.

Every covered GET and HEAD returns `Cache-Control: no-store, private`.
Extension activation is disabled for item and contract reads; point-in-time
reads use the SDK replay kernel. Complete views retain the SDK's complete-list
certificate and pm-web's supplemental output-budget refusal. Missing or corrupt
trackers fail closed with a safe unavailable response; reads never initialize
a replacement tracker or expose provider exception text. Failure logs retain
only an allowlisted preflight reason (such as missing or unreadable) and the
request middleware's generated request identity.

The public SDK pinned by this package currently accepts `pmRoot`, `cwd`,
`author` and `noExtensions` in `PmClientOptions`. It does not export a native
backend handle injection point. Account and share rows in PostgreSQL remain
access-control metadata, separate from authoritative PM items. Plain-directory
conformance demonstrates no-Git operation, not no-filesystem operation.

Remaining Feature items with acceptance criteria:

- [Native provider binding and remaining reads](https://github.com/unbraind/pm-web/blob/72d78702d044e7a269ca659ebfe092aaa645a67b/.agents/pm/features/pm-web-native-provider.toon): upstream handles, complete native conformance, remaining paginated list/settings/history surfaces and observational pm-graph `ProjectionSource` reuse.
- [Native mutations and idempotency](https://github.com/unbraind/pm-web/blob/72d78702d044e7a269ca659ebfe092aaa645a67b/.agents/pm/features/pm-web-native-mutations.toon): SDK transactions, decisions, retries, isolation and independent writers.
- [Durable native history and events](https://github.com/unbraind/pm-web/blob/72d78702d044e7a269ca659ebfe092aaa645a67b/.agents/pm/features/pm-web-native-events.toon): scoped subscriptions and resume cursors, retention, restart and explicit gap/resync receipts.

Regression coverage uses actual SDK trackers without Git, actual PostgreSQL
grants, HTTP GET/HEAD, and separate OS processes for concurrent item writes,
revocation, permission changes and project rebinding. Existing graph and resume
tests remain in place; this slice does not replace their contracts.
