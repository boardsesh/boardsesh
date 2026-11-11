# First-party authentication enforcement windows

This document records local developer qualification. [#7430](https://github.com/boardsesh/boardsesh/issues/7430) remains the owner action list. The implementation and safety boundaries live in [the synthetic harness](../scripts/auth-rehearsal/README.md).

| Boundary | Enforcement | Qualification limit |
| --- | --- | --- |
| Legacy bridge versus password reset | Shared authority gate, user lock, primary generation check; old proof is denied after reset commits | Bounded synthetic qualification below; full rehearsal remains incomplete |
| Refresh versus native signout | User lock before refresh row; successful generation revocation leaves no live descendant | Dark core only; default production revoke preserves legacy behavior; Garmin gate open |
| Web account switch | A credential retains its original subject | Concurrent source readers do not order Set-Cookie responses across tabs; activation blocker remains |
| Existing WebSocket | Primary cutoff sweep runs every 1,000 ms; connection closes with 4401 | The interval is a scheduler setting, not a measured upper bound |
| Reconnecting WebSocket | Actual admission reads the current primary cutoff before ACK | Bounded observation below; not a production bound |
| Primary dependency unavailable | Protected actions distinguish unavailable from denied and refuse access | No stale positive cache or decoder fallback qualifies unavailable access |

Measurements must identify the commit and fixture class and report timings without account identifiers. Host scheduling, PostgreSQL/Redis response time, and the socket transport contribute to observed latency. A local maximum is evidence for that run, not a production guarantee or SLA.

## Open qualification boundaries

The PR10 harness reports partial synthetic qualification. It cannot qualify actual writer switching, stop issuance, rollback to the reader floor, full restored-copy identity/reference preservation, or no-route host-process isolation before those flows exist and are exercised. BA-05 cross-tab response ordering remains separate: a delayed password replacement cookie for A can arrive after another tab signs in B. Source identity binding alone cannot close that gap.

The owner confirmed Garmin is installed only on his own test watch, with no shared/public release; publication is planned for December. There is no unknown public-old-watch population. The native-generation and administrative apply gates remain hard blocked pending preservation of existing test ticks, update safety with the original signing key, and real watch QA. No data-loss exception is accepted, and no synthetic backend race result closes those remaining gates.

## Bounded synthetic observation

The current local implementation produced this two-instance run inside fresh synthetic PostgreSQL/Redis and an owned Linux namespace. These are dispatch-to-assertion pipeline durations, including transaction, IPC, and reader work. They are neither exact commit-to-denial bounds nor production guarantees. Independent marker/worker/race review passed five actual semantic fault probes and eight marker/readiness/privacy/reference mutations, then restored the complete bounded run.

| Scenario | Observed duration | Observed result |
| --- | ---: | --- |
| Legacy bridge/reset | 10.8 ms | Old signed JWE denied after reset |
| Refresh/native signout | 8.1 ms | Signout acknowledged; no live child; both native readers denied old JWT |
| Concurrent source-account readers | 1.0 ms | Each credential retained its source account; cross-tab cookie order unqualified |
| Existing WebSocket and second-instance reconnect | 536.6 ms | Existing connection closed 4401; reconnect denied before ACK |

Mandatory controls first proved a persisted canonical bridge was admitted, a successful refreshed child token was admitted and then revoked, and native revocation preserved the web proofs. Both initial and any returned native JWT are checked on both actual readers after acknowledged revocation. A bridge that always denies, a refresh that always returns 401, or a revocation that never acknowledges cannot qualify this run.

The run preserved five identities, one provider link, three untouched password hashes, and the fixture's 89 single-column users-FK references. Two intended password changes and exactly one expected activity row were checked separately. The restored production reference catalog and restored-copy data were not exercised.

Independent local target-safety review and the actual namespace/route probe passed. All SQL, race-driver and backend-worker processes in this run executed inside that namespace. The host controller still ran outside it: its general egress isolation remains unqualified, and the report retains the explicit host-worker-egress blocker. A namespace label alone does not qualify the controller or future restored-copy/browser processes. Full switch/stop/rollback and the other open qualification boundaries above remain blocked.

`vp run auth:rehearsal` (default/full) returns not-ready/nonzero before Docker or SQL. Only the explicitly named `vp run auth:rehearsal:synthetic` can return success for this bounded partial probe. Successful synthetic cases cannot mark the missing full rehearsal ready.
