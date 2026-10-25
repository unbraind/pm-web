# Authorized resume change packets

An agent reviews a consented Agent context question and its publisher-selected
`items`, then admits a baseline. After working offline, it submits the last
accepted cursor and receives only changes to those item streams. The feature
composes the existing project ACL, context consent and SDK mutation-history API.
It stores no second context snapshot, pending delta or server checkpoint.

```sh
# Publish a question with an explicit selection; share only with named viewers.
pm web agent-context publish --url https://pm.example.test --project PROJECT \
  --input '{"agent":"delivery","question":"What changed for delivery?","items":["demo-one","demo-two"],"consent":true,"viewers":[],"receipts":[],"gaps":[]}' --json
# Inspect the question and source items first. Omit --cursor to admit that baseline.
pm web agent-context resume --url https://pm.example.test --project PROJECT \
  --id PACKET --revision REVISION --budget 12288 --output-budget unbounded --json
# Persist only the cursor after accepting the packet, then use it on reconnect.
pm web agent-context resume --url https://pm.example.test --project PROJECT \
  --id PACKET --revision REVISION --cursor CURSOR --budget 12288 --output-budget unbounded
```

Set `PM_WEB_TOKEN` to an authorized session token. All commands also support
native TOON output (omit `--json`). `--budget` bounds the compact SDK JSON envelope,
including its cursor and receipts, to 2–16 KiB (default 12 KiB); the host renderer
adds its own output receipt and formatting. Use `--output-budget unbounded` to
preserve the complete packet and cursor. Never accept an output the host reports
as compacted or omitted. There are at most 50 complete change references per
packet, 20 selected items per question and 10,000 history events per scan.

`phase: admitted` explicitly acknowledges the existing source prefix; it is not an
empty delta. `phase: delta` reports `missed`, `returned`, `deferred` and `complete`.
`missed` means retained selected-stream events since admission, not global events
or a claim about events outside the selected question. Drain deferred rows with
the returned cursor. Every emitted row includes the item, physical version,
operation, changed field references and a revision-bound event key. Field paths
are bounded and omissions counted. Fetch full native state separately through
the authorized project SDK; packets never export raw patches or messages.

A cursor advances only over returned rows. Save it after processing those rows.
Replaying an older cursor returns the same event keys, permitting retry dedupe;
advancing the accepted cursor emits each retained event once. Independent readers
can safely resume the same cursor without a shared mutable lease. Applications
that perform side effects must bind their own idempotency keys to both the event
key and target revision; content alone is not a safe idempotency key.

SDK cursors page the selected source events. Exact SDK authoritative history
prefixes, hashed in physical version order, validate admission. This follows
pm-context's `since` prefix/ordinal semantics, including backdated appends;
its unscoped disk checkpoint store is deliberately not used. Deleted, rewritten,
compacted, mismatched or damaged cursor prefixes return
`reorientation_required`, never a successful empty delta. Review the current
question and sources before admitting a fresh baseline. A changed context
revision returns `revision_conflict`; refresh authorized metadata and reorient.
Too-small budgets return `budget_too_small` without admitting a new cursor;
raise the budget and retry. `invalid_input`, `not_found`, `view_only` and
`unavailable` carry typed remedies. No refusal contains a storage diagnostic.

The cursor is encrypted, contains metadata only, and binds the project,
principal, packet revision, question and selected items. A shared deployment
`JWT_SECRET` supports replicas/restarts; rotating it requires reorientation.
Development without that secret uses a process key, so restarting also requires
reorientation. The cursor grants no access: project membership and exact packet
consent are checked before source reads and again immediately before return.

The Agent context UI offers **Admit baseline or resume**, a copyable cursor and
completeness receipts. Responses use `Cache-Control: no-store, private`; the SDK
persists neither tokens nor packet contents, and the service worker never caches
API reads. Revocation/invalidation, account changes, backgrounding and failed
access revalidation clear the managed DOM contents. Open views revalidate within
10 seconds even without SSE. An offline client cannot discover a remote
revocation until reconnection, so only the metadata cursor may be retained across
offline sessions. Caller-made exports cannot be remotely erased.

## Without git

Admission, resume, SDK access and native commands work with a plain tracker.
Neither the service nor command invokes Git. The HTTP server requires its normal
PostgreSQL configuration and project authorization. See
[the typed SDK example](../examples/resume-packets.ts) and
[validation measurements](resume-packets-validation.md).
