# Decision inbox contract

The core Plan owns durable decisions. `pm-review` owns review findings/verdicts;
`pm-jev` owns model proposals. The inbox adds collaborative requests and responses
over those primitives. It registers no item types or schema fields and does not
modify code-review, task-completion or plan-execution approval policy.

Each request is an ordinary core `plan_decisions` entry: readable question in
`decision`, evidence in `evidence`, and a versioned envelope in `rationale` prefixed
`pm-web:decision-inbox:v1:`. The envelope carries `kind: request`, a UUID, question
and 2–8 distinct alternatives. Replies append `approve` or `acknowledge` envelopes
with the request UUID, observed revision, reason, and approved zero-based
alternative when applicable. Ordinary decisions and future envelope versions do
not become pending requests. Malformed recognized envelopes fail closed.

A SHA-256 revision binds the exact request (including evidence and author) and
all its responses. Unrelated plan edits do not invalidate a request. Each response
acquires a public SDK token-owned tracker lock derived from the plan/request ids,
then re-reads the core log, checks the revision and pending state, and appends via
`PmClient.planDecision`. The SDK owns item locking, audit history, hooks and policy.
The additional response lock coordinates independent inbox processes sharing the
same tracker, with a 5-second wait and 120-second lease. A stale or duplicate
submission fails instead of silently approving newer evidence. A lost HTTP reply
is resolved by refreshing; automatic retry never adds a second approval.

This is a cooperative inbox protocol. A tracker owner can directly edit core
state with other SDK operations; raw filesystem edits or direct fabrication of
versioned envelopes are outside its concurrency contract. The workflow records
a selected course of action and never executes arbitrary mutations described by
request text or evidence. Evidence is escaped as text in the browser.

Inputs bound questions to 1,000 characters, evidence and reasons to 2,000, and
alternatives to 240 each, with a 14,000-byte encoded input ceiling. Pages are sorted by request time/id with a row limit
and a JSON byte budget. Offset pagination reflects current pending work: after
another writer resolves requests, refresh from offset zero to obtain a new view.
It is not an immutable snapshot cursor. No asynchronous background reader claims
that a partial source list is complete.

## Validation

`node scripts/decision-inbox-public-data.ts` extracts only the committed public
package tracker to a non-git scratch directory, marks source files read-only,
performs certified reads, measures output, and compares every original source
file hash before cleanup. Derived indexes use a disposable runtime directory.

Measured against public `unbraind/pm-web` main
`ca7e188bc91ebec838e6791afcbc38f6d057463b`: **172 items**, **0 Plans**, **2 core
Decision items**, **0 explicit pending requests**. The inbox returned **85 JSON
bytes**; the certified corpus read plus inbox projection took **473 ms** on the
shared host. **374 immutable source files remained byte-identical**, aggregate
SHA-256 `43d589b8e5e7cd1ca0b51387518b56efb6aee7993d71540074ca76babe9595b4`.
This establishes compatibility and non-mutation for existing public data. Because
that corpus contains no Plans, active-request behavior is separately exercised
with real seeded non-git trackers and authenticated local HTTP tests.

Targeted tests cover pending/list pagination, evidence and attribution, malformed
input, view-only refusal, acknowledgment without completion, revision conflicts,
already-answered refusal, durable core audit history, unchanged plan lifecycle,
independent-process contention with no Git executable, real extension dispatch,
and HTTP membership checks backed by the throwaway PostgreSQL database.

`node scripts/decision-inbox-browser.ts` captures the base-ref Plan screen and the
new inbox from local servers backed by the same seeded tracker and test database.
Desktop (1440 px), mobile (390 px), and view-only frames are uploaded as a CI
artifact. No screenshots or other binary evidence are committed to the package.
The browser regression also checks loading, populated, SSE-refreshed, empty,
failed and recovered inbox states. A small status announces loading, counts and
errors; interactive requests remain outside live regions, and `aria-busy` clears
after either a successful load or an error.

Behavioral revert proof: removing only the revision refusal in
`respondToDecision` and the editor-capability refusal made all three selected
regressions fail (acknowledgment revision, view-only mutation, independent-process
race); restoring those guards made the targeted suite pass. This changes runtime
behavior and rebuilds the public entrypoint used by subprocess tests.
The accessibility revert proof restored only the previous `renderDecisionInbox`
implementation, retained the new browser assertions and rebuilt the frontend.
Browser acceptance exited 1 at the separate-live-status assertion (0 elements
instead of 1); restoring the rendering function and rebuilding passed again.
