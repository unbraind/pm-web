# Project event delivery and resume

Each project uses one ordered, process-local journal. Mutation identities still
deduplicate route, watcher, and peer delivery before encoding. An event is JSON
serialized and framed once into a UTF-8 `Buffer`, independently of viewer count.
All authorized viewers share that frame. A fixed 4 ms window combines adjacent
frames into one shared batch for viewers at the same journal position; individual
events and their order are retained. A viewer joining during a pending burst starts
at its connection cursor and receives only subsequent events.

The HTTP route checks each subscriber's project access before connecting or
examining a resume token. Before a batch, one SQL statement reads the project's
owner, direct shares, and group memberships. Each viewer must occur in that
result. Read and edit roles have the same existing event visibility. A revoked
viewer is disconnected before receiving the next batch; a failed membership read
disconnects the affected viewers. Draining a previously blocked queue also requires
a fresh membership decision. An empty drain performs no query; the next event
still requires fresh authorization. Each read covers only the events and viewer
registrations captured before it started: later events and new viewers require
the next fresh decision. Unknown-project bus traffic creates no journal or
watcher subscription.

Each response has its own queue. `write(false)` means the submitted buffer was
accepted: it is never retried. Subsequent batches wait for that response's `drain`
event, while other viewers continue. Pending bytes plus Node's buffered response
bytes must stay within 1 MiB, with at most 64 queued batches. A response blocked
for 15 seconds, over either queue bound, or throwing during a write is destroyed
and removed. There is one drain listener and at most one stall timer per viewer;
there is no callback allocated for every response write. Heartbeats use the same
queue. Catch-up is shared in batches of at most 64 KiB, allowing one larger
frame when needed. It progresses after drain instead of buffering the entire
journal per viewer. A single frame exceeding the queue byte budget disconnects.

Every complete SSE frame, including `connected` and presence, carries an opaque
project-epoch/sequence `id`. Native `EventSource` reconnects with `Last-Event-ID`;
other clients should retain the last fully received frame's ID and send that
header. Only frames strictly after that cursor are replayed, followed by live
events through the same ordered queue. Detection stays active while the last
viewer reconnects. Partial frames do not advance the client's cursor.

Resume is bounded to the current process and the retained contiguous journal:
60 seconds, 10,000 frames, or 8 MiB per project, whichever is reached first.
The journal expires 60 seconds after the last viewer leaves. A token from another
project, an expired/evicted token, or a token from a previous server process
receives HTTP 409 after authorization, with a request to refresh project state.
Unauthorized callers receive the existing HTTP 404. A client must refresh its
project snapshot and open a new stream without the stale token after 409; it must
not treat a rejected cursor as a successful replay. This is bounded reconnect
recovery; it is not a durable cross-process event log.

The SPA retains its native `EventSource` during transient failures so the browser
resends its cursor. A terminally closed stream uses the existing replacement
backoff and refreshes its live view after connecting afresh. Stale callbacks from
another project cannot replace the current stream or change its session id.

The response-boundary tests exercise 3,000 sinks, shared buffer identity,
serialization count, ordering, byte/batch/stall limits, and exact replay after
queue eviction. Real-Postgres HTTP tests cover direct and group authorization,
revocation, forged cross-project tokens, and replay. A production-process test
disconnects the last viewer, commits three independent CLI updates to a plain
non-git tracker, then requires exactly those three updates on resume.

## Measurement

The [dated report](capacity/2026-10-20-fanout.md) and its raw numbers distinguish
correct delivery, synchronous fan-out CPU, the rest of the event-loop turn, and
write-to-network latency. The existing [capacity harness](capacity.md) still uses
real authenticated HTTP streams, an isolated production server, the disposable
test database, and separate pinned CLI writers. It first drains the complete
presence snapshot at the requested population, then resets measurement counters.
Comparison startup continuously refills sixteen slots, leaving three request
slots after the default pool's reserved listener. Ordinary acceptance retains the original fifty-slot cap. There are no artificial cohort
pauses that repeatedly trigger large presence snapshots during a ramp. Connection
and presence defaults remain 15 and 45 seconds for ordinary release acceptance.
The comparison explicitly allows 120 seconds for each connection and final-presence
warm-up, separately from measured delivery. Setup duration is retained and no
measured writer starts until all viewers and the final presence snapshot are ready;
join-storm capacity is separate. Production pool and slow-viewer bounds are unchanged.
The generator parses headers before the data field and shares a cache of at most
128 exact presence-frame strings within a 64 MiB text budget. Every socket must receive its own complete
frame before its population count advances. This avoids rescanning a full roster
for an absent header and allocating the same match array for every reader. A
two-socket fragmented-frame test proves the cache cannot acknowledge missing bytes.
Setup failures retain only aggregate reader populations and owned-process samples.

The test-only preload wraps the same local delivery and presence functions in
both builds, plus the candidate's encoding and batch-write scopes. Authorized
deferred drains run through that same batch scope, so no CPU timer is added per
viewer. Nested CPU scopes are counted once. `process.cpuUsage()` differences
sum synchronous service CPU, independent of scheduler waiting. A second union of
non-overlapping CPU windows extends through `setImmediate`, capturing work later
in the turn, including ordinary response-write callbacks. That broader metric can
also include other server work in the turn; it is not an exclusive allocation of
all asynchronous transport CPU. Neither metric includes the external writer or
reader processes, database-process CPU, or network transit. No per-response
completion callback is added by the probe. The report also retains whole-server
CPU samples and event-loop delay. An aligned reset/final sample also records
inclusive server CPU microseconds and its full sampling window, covering later
socket callbacks, membership-set construction, SDK request work and background
watchers. It excludes writer-child, generator and database-process CPU and is
reported separately from the scoped fan-out cost.

Counters record actual UTF-8 JSON and complete wire-frame bytes once per prepared
event, separately for the synthetic measured mutations and all control events.
The primary denominator is the number of measured mutation frames submitted to
responses, checked against committed writes times subscribers and independently
against actual network receipts. There are separate counters for response write
calls carrying events and all submitted frames, so burst batching cannot masquerade as fewer
delivered events. Probe bookkeeping adds overhead to both builds.

For each population, run A/B/A/B on the same host, with immutable baseline and
candidate runtime artifacts. The comparison retains a one-second latency verdict
and a ten-second post-writer loss/duplicate observation window, continuing to the
next population after latency failures while asserting zero loss, duplicates,
write failures, and disconnects. Baseline setup failures are retained explicitly
with unavailable CPU and latency samples; every candidate rung must complete. The ordinary release acceptance keeps its
unchanged two-second SLO. Report host load before and after every run; a busy-host
result does not certify the quiet-host target.

Resource probes keep their five-second query budget. Deleting thousands of
fixture identities and their foreign-key cascades uses a separate connection
with a bounded sixty-second statement budget. Failed deletion retains the
synthetic ownership receipt and tracker for exact cleanup instead of removing
the evidence needed to recover. Successful cleanup removes both the owned rows
and temporary root. This lifecycle budget does not extend delivery deadlines.
