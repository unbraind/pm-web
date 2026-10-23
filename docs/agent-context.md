# Agent context workspace views

The Agent context view shows one publishing agent's current question, served receipt references, source omission reasons and unresolved evidence gaps. Open it from the project sidebar, select an authorized scope, and use **Refresh access** to request an additional current-consent check. Every displayed omission reason and remedy comes unchanged from the same packet returned by the API. Receipt metadata is reported by the publisher; it does not prove the agent used evidence or that an inference was correct.

A scope is one packet UUID within one project. Project membership alone never grants packet access. The publishing account explicitly consents to an audience of account UUIDs with `consent: true`. A packet is visible only to its publisher and named viewers who still have project access. Other editors and the project owner gain no implicit read access to another publisher's packets. A viewer cannot publish; editors can publish their own packets. Display names identify the reported agent, while `publisher` identifies the authenticated account responsible for the assertion.

## SDK and API

`AgentContextClient` uses the existing authenticated pm-web API. Pass an operator-selected HTTPS origin (HTTP is allowed on loopback for development) and a session token. It forwards no credentials on redirects and never persists credentials. The local tracker requires neither git nor database access; the server uses pm-web's existing PostgreSQL database. No additional service, inference engine, memory store or raw chat archive is created.

- `list(project, offset = 0)` returns at most 20 authorized scope summaries plus `nextOffset`.
- `publish(project, input, binding?)` creates a packet or replaces an owned packet against `{id, revision}`. Replacement changes the revision, including when the audience changes.
- `get(project, id, revision)` requires both current audience consent and the exact revision.
- `revoke(project, id, revision)` deletes an owned packet atomically. Future retrieval and discovery fail, including for the publisher.

The routes are `GET/POST /api/projects/:project/pm/agent-context` and `GET/DELETE /api/projects/:project/pm/agent-context/:id`; GET detail requires `?revision=...`. POST and DELETE require current revision bindings for existing packets. The server derives publisher identity from authentication; body fields cannot override it. Concurrent replacements of one revision have exactly one winner. Scope lookups return identical `not_found` refusals for absent, unauthorized and revoked packets. Responses carry `Cache-Control: no-store, private`; API reads are network-only in the service worker. Revocation prevents future retrieval; it cannot erase information a recipient already copied or a copy already captured by a recipient. Open views clear confidential content immediately on content-free realtime access/packet invalidations and reauthorize before restoring it. Project-share revocation sends a terminal access-revoked control frame before the existing SSE connection closes. The same path covers group grants and project/account removal. A serialized fallback checks every 10 seconds with a five-second request deadline, even while SSE is disconnected; failed verification clears content. Hidden tabs clear content and revalidate when shown again. An offline revocation is shown as queued; access remains until the server confirms it.

Packets contain metadata only. `coreContextEvidence` adapts actual core `PmReadOutputSessionReceipt` and `PmReadOutputReceipt` values, preserving repeat suppression and budget omission remedies. `packContextEvidence` adapts pm-context's `pm-context-usage/v1` receipt identity with explicitly supplied omission reasons. Supply the serving source revision and timestamp; these are provenance assertions, not a fresh read of the source tracker. When evidence changes, replace the packet and share its new revision. The server does not silently recompute source context or read pm-context's runtime store.

Input is bounded to 12 KiB, with a 2,000-character question and at most 20 viewers, receipts, gaps and omissions per receipt. Oversized input is refused with a remedy instead of truncating away an omission receipt. The exported TypeScript input/packet/error types cover all operations. Refusals include `code`, `remedy` and HTTP status: `invalid_input` (400), `view_only` (403), `not_found` (404), `revision_conflict` (409), and `unavailable` (503). The CLI maps unavailable servers to core `DEPENDENCY_FAILED`, stale revisions to `CONFLICT`, and hidden packets to `NOT_FOUND`. Refresh metadata on conflict; request explicit consent on hidden scopes; check server availability on dependency failures.

See [the typed example](../examples/agent-context.ts).

## CLI

Set `PM_WEB_TOKEN` through your normal secret mechanism. Never put it in shell arguments, tracker comments or a committed file. Select the authorized server and project explicitly:

```sh
pm web agent-context --url https://pm.example.test --project <project-uuid> --json
pm web agent-context get --url https://pm.example.test --project <project-uuid> --id <packet-uuid> --revision <revision-uuid>
pm web agent-context publish --url https://pm.example.test --project <project-uuid> --input '<consented-packet-json>' --json
pm web agent-context revoke --url https://pm.example.test --project <project-uuid> --id <packet-uuid> --revision <revision-uuid> --json
```

Use `--offset` with the returned `nextOffset`. Omit `--json` for the host's compact default TOON output. A replacement publish additionally needs `--id` and `--revision`. The SDK example shows the packet shape, including `consent`, `viewers`, `receipts` and `gaps`. The CLI uses authenticated HTTP rather than trusting an arbitrary actor flag.

## Validation

`node scripts/with-test-db.ts node --test test/agent-context.test.ts` runs real HTTP/database, source receipt adapter and non-git native CLI regressions. `node scripts/agent-context-public-data.ts` extracts the committed public tracker at `origin/main` into a non-git scratch directory, makes source files read-only, performs a certified complete SDK read and a bounded output-session read, then verifies identical source hashes. It prints counts and byte/token measurements without printing item bodies.

`CONTEXT_SCREENSHOTS=docs/screenshots node scripts/with-test-db.ts node scripts/agent-context-browser.ts` serves synthetic data locally, checks exact API/UI omission parity at 1440px and 390px, checks overflow, and verifies that refreshing after revocation clears the displayed question. The committed screenshots contain synthetic data only.

Keyed mutations also use [current replay authorization](idempotency-replay.md): an Idempotency-Key cannot retrieve a deleted packet or bypass a revoked project grant.
