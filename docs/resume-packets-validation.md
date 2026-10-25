# Resume validation

The public `unbraind/pm-web` tracker at origin/main `9cdd543` was copied into a
plain scratch project. Every native input file was made read-only. No hosted
service, private tracker or source repository was modified. The measurement
script permits only regular files/directories and compares SHA-256 hashes before
and after reads, excluding disposable SDK runtime caches.

Command: `node scripts/measure-resume-packets.ts <public-tracker-copy>`.

| Measurement | Result |
| --- | ---: |
| Certified complete tracker items | 182 |
| Selected item streams | 20 |
| Selected retained history events | 188 |
| Native files unchanged | 394 / 394 |
| Admission JSON | 3,423 bytes |
| Idle resume JSON | 3,420 bytes |
| Encrypted metadata cursor | 3,039 bytes |
| Admission duration | 494 ms |
| Idle duration | 359 ms |
| Idle missed events | 0, complete receipt |

Durations are a bounded observation on a busy machine, not a capacity claim.
The public source had no mutations during this read-only experiment. Synthetic
SDK tests independently cover offline changes, deferred rows, retries and
backdated commits. No private source contents appear in these measurements.

The seeded model test uses seed `0x5eed2026` for 500 random operation sequences.
Its reference ledger tracks admitted physical item versions independently of
packet hashing/serialization. It publishes/replaces and reads context metadata
through the actual authenticated SDK, replays older consent inputs against the
current target revision, replays older native updates, and exercises whitespace,
CRLF bodies, relationships and all resume-owned envelope fields. Native item
state is read back through `PmClient.get` before and after resume and compared
exactly, without a handwritten normalizer. Resume introduces no native item
import, export or sync writer.

Deterministic interleavings inject audience revocation, project-share removal,
question replacement and a successful peer resume at every asynchronous service
boundary on one non-git tracker. The service owns no claim, lease, checkpoint or
outbox record: concurrent readers cannot delete, overwrite or falsely claim a
peer's state. Existing context publication retains its database compare-and-swap.

Browser evidence extends the existing real-server proof at widths 1440 and 390:
admit, update via native SDK, resume one change, compare API/UI references, copy
the next cursor, and purge the resume DOM on revocation. The existing eight
realtime, fallback and reconnect-backoff revocation cases remain covered.
