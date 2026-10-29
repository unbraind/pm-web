# Evidence freshness inspection

Open an item and expand **Evidence freshness**. The panel and
`GET /api/projects/:projectId/pm/evidence/:item` consume the same versioned
`pm-web-evidence/v1` page. `EvidenceInspectionClient.inspect` and `pm web evidence`
provide that same response to agents. No completion judgment is inferred.

```sh
pm web evidence --url https://pm.example.test --project PROJECT_UUID \
  --item example-task --limit 5 --budget 2400 --json
# Omit --json for the host's compact TOON output.
# Follow nextOffset with --offset; omitted always counts all rows outside this page.
```

Set `PM_WEB_TOKEN` using the operator's secret mechanism. The command has no
ambient project or tracker default and never discovers a server from local files.
The supported SDK import is `@unbrained/pm-web` (see the packaged example).

Requests accept only `item`, `offset` (0–1000000), `limit` (1–20, default 10),
and `budget` (400–16000 estimated tokens, default 2400). HTTP selects the item
through the route and accepts only the other three query fields. JSON and TOON
are measured together through pm-evidence's SDK-backed estimator; the larger
representation must fit the budget, including receipts. Insufficient budgets
return `budget` with a remedy rather than hiding an oversized first row.
The host's TOON encoding omits empty root arrays and null end cursors. The shared
page schema restores those canonical empty values; pagination checks still refuse
missing nonempty evidence rows. JSON, UI and decoded TOON have the same meaning.
When the host includes `rows_encoding` or `criterionGaps_encoding`, restore those
declared nested cells with the public SDK `decodePmTableRows` operation before
validating the page. Never infer JSON cells from fragment text.

Each row reports the pm-evidence resolution and exact fragment freshness,
the cited and current fragments when available, and producer-validated criterion
facts with their exact bound/current revisions. `ambiguous` is explicit. Every
binding retains `truthAssessed: false`. Reviews and completion judgments remain
the responsibility of pm-review and authorized reviewers.

Fragments show at most 512 characters each and disclose `omittedCharacters`.
Unretained JSON citations can lack a reconstructable original; `not-retained`
explains that historical gap. Current text is resolved independently from the
same approved immutable source snapshot using pm-evidence's public exact-span
resolver, including when originals are absent or corrupt. Verification does not
request historical diffs. Raw JSON number and escape spellings are preserved;
source text is always rendered as text. Missing, inaccessible, ambiguous, malformed and unsupported records are
visible independently; a malformed citation does not suppress valid siblings.
Foreign envelopes are preserved and reported with `schema`.

The server derives the source root from the authorized project's storage mapping.
Only that item's native `files` links with `scope: project` are eligible. Hidden
configuration, credential files, unlinked paths and unsupported providers are
excluded. The host adapter authorizes both the linked name and the actual opened
file descriptor before reading bytes and revalidates its identity before returning
the immutable snapshot to pm-evidence. Safe public symlinks, including directory
and chained aliases, work; aliases into reserved paths and multiply linked files
are refused. The latter cannot establish which inode alias supplies its authority.
pm-evidence owns exact selection and freshness checks. Opened-source verification
requires Linux procfs; other
platforms get explicit unsupported facts. Each source snapshot is bounded to
256 KiB with a three-second read timeout and an eight-second inspection signal. One invocation shares immutable
snapshots between freshness and criterion checks, then discards them.

Every request checks live project access before reading and again before returning
source bytes. A viewer can inspect, but inspection calls `check(record: false)`
and read-only `criterionFacts`; it never registers schema fields or records check
observations. No adapter mutation path exists: POST/PUT/PATCH/DELETE receive
HTTP 405 `unsupported` with guidance to use pm-evidence as an authorized editor.
Schema setup, citation creation, binding and reviews are separate explicit
pm-evidence operations, unavailable through this inspection endpoint.

The panel refreshes on demand and every ten seconds while open. Hidden tabs,
project/account/connection changes, ACL invalidations and failed refreshes clear
source bytes. Requests and the service worker use live network access only;
offline evidence reads and mutations are never cached or queued.

This is a read-time observation, not a transaction-isolated snapshot. The complete
item is re-read through the SDK before returning; interleaving item changes refuse
with `conflict`. An ordinary writer can still run after that final read, access
can change after the last authorization query, and a source can change after its
snapshot. Refresh rechecks current facts. `commitWorkspaceTransaction` is not used
and is not claimed to isolate ordinary CLI/SDK writers (pm-cli issue 1620).

There are no import/export/sync, recovery plans, status interpretations, or
idempotency keys in this feature. Existing native fields and relationships are
observed without normalization or rewriting. The seeded regression executes 500
random operation sequences including older source replays, whitespace and CRLF
variants; it reads native state back through the SDK and checks exact preservation
along with the source model. Producer outputs validate and JSON-round-trip through
the same response schema. HTTP tests use real PostgreSQL permissions and no SDK
mocks; interleaving tests inject ordinary writers at every subsequent SDK read.

## Without git

Inspection, SDK/CLI clients, fragments and criterion facts work in a plain tracker
without a Git executable. Real-data validation first extracts the committed public
tracker using git, then runs all inspection in a non-git directory with read-only
source files and checks source hashes afterward. Nothing contacts hosted projects.

Run the focused suite with `node --test --test-concurrency=2 test/evidence-inspection.test.ts`.
The real-data and browser probes are `npm run validate:evidence` and
`npm run accept:evidence`; the latter needs a disposable test database and Chromium.
