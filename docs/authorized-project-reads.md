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

The reader joins the same workspace queue as existing web mutations. The binding
records the physical workspace and the physical tracker, not only the logical
directory. Workspace and tracker symlink aliases share that physical tracker queue.
The reader and every other queued SDK, CLI, JSON and TOON command stay on the
storage captured when they joined the queue. Access is checked again after waiting
and immediately before returning data. Revocation returns 404; a changed effective
permission, slug, workspace symlink or tracker symlink returns 409 and requires a
fresh request. A retarget while the read is queued or running does not follow the
new target and does not release data from the old target. The final authorization query is the read's admission
point. It does not promise a transaction spanning account grants and item
storage, or a global snapshot across independently written item histories.

Every covered GET and HEAD returns `Cache-Control: no-store, private`.
Extension activation is disabled for item and contract reads; point-in-time
reads use the SDK replay kernel. Complete views retain the SDK's complete-list
certificate and pm-web's supplemental output-budget refusal. Scan folders come
from the SDK's live schema registry. If an enabled extension contributes item
types whose folders cannot be established without activating code, covered
reads return 503 rather than certify a partial corpus. File-backed custom
types remain readable without activation. Storage resolution uses asynchronous
filesystem operations before queue admission. Missing or corrupt
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
