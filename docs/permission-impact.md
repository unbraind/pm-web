# Permission impact previews

Preview an explicit replacement of one existing project share before changing it. The proposal is `{ shareId, permission }`, with `permission` set to `edit`, `view`, or `none` (remove the share). Optional integer `limit` is 1–50 (default 20); `offset` is 0–1000000. UUIDs are canonicalized; extra fields, coercion, blank flags and nonfinite numbers are refused.

```sh
pm web permission-impact --url https://pm.example.test --project <project-uuid> \
  --share <share-uuid> --permission view --limit 20 --json
```

Set `PM_WEB_TOKEN` using your existing authenticated session. Omit `--json` for the host's compact TOON output. Follow `nextOffset` with the same explicit proposal. Pages are fresh reads; concurrent changes may move entries between pages, so refresh before acting. Results never constitute an executable plan or an authorization token.

`PermissionImpactClient.preview(project, input)` and `POST /api/projects/:projectId/pm/permission-impact` expose the same typed contract. Only the project owner may preview share consequences. Viewers receive `view_only`, other editors `owner_required`, and hidden/missing project scopes `not_found`. Invalid inputs receive `invalid_input`; unavailable tracker/decision/capability sources receive `unavailable`. Every refusal includes a remedy.

Effective permissions come from the same owner/direct/group grant resolver used by live requests. Removing one grant can leave access intact through another grant. The SQL read uses a read-only repeatable snapshot. It never changes shares, packet contents, packet revisions, native items or deployment settings, and never writes an idempotency record. Repeated requests always recompute from current state.

The counts and identities describe distinct resources with at least one affected recipient:

- Active context packet IDs are included only when both the caller and an affected recipient can read their consented audience. Hidden packets are excluded from both counts and identities. Audience membership counts and hidden-resource totals are never returned.
- Pending decision IDs use the existing SDK-backed Decision Inbox projection. Removing read access reports `read`; losing edit access reports `respond`. Decision lifecycle is determined by the inbox's request/response protocol, independently of a Plan's configured status name.
- Agent operation IDs are currently available core backend capabilities from the SDK contract resolver. A downgrade loses mutations; scope removal loses reads and mutations. These are capabilities, not a count of running agents or queued jobs. Unknown, unsupported and extension-specific authorization contracts remain disabled and are never represented as executable operations. This preview cannot enable or run any operation.

Counts are integers, with total at most 1000000. Groups over 10000 members are refused with a narrower-scope remedy. Responses contain at most 50 identities and validate through the same exported response schema used by the SDK. No item titles, decision questions, context contents, user names, tokens or storage paths enter preview output.

The sharing screen previews removal before presenting its separately authorized confirmation. Applying via existing sharing controls rechecks ownership. Existing project access signals clear only the selected project's context, decision and contract views; late reads are fenced. Subsequent API calls recheck effective permission and packet consent. A preview is advisory at read time; it cannot guarantee future access or force a subsequent apply.

There is no new native import/export/sync, journal, outbox, lease, ACL persistence format or role-changing endpoint. Existing import and synchronization semantics are unchanged. The seeded model suite generates 500 sequences with older proposal replays, direct/group grant combinations, consent revision changes and whitespace/CRLF packet evidence, reads state through authenticated SDKs, and compares preview verdicts with actual authorization. Boundary fuzzing also checks 1000 producer records. Custom status registries and ambient focus changes verify that a still-pending decision remains visible and native relationships stay intact.

## Without git

The SDK, HTTP preview and native CLI work in plain trackers without a Git executable. Public evidence extraction alone needs a repository containing the public source commit. `scripts/permission-impact-public-data.ts` reads an immutable copy of public main in a non-git scratch tracker, uses synthetic grants in a disposable PostgreSQL database, and verifies every original source byte after validation. It prints measured counts and output bytes; it does not change the original tracker or contact a hosted workspace.
