# Offline write delivery evidence

Issue [#7988](https://github.com/boardsesh/boardsesh/issues/7988) measures the writes durably queued on a phone through server acceptance and local reconciliation. This is first-party operational evidence stored privately in Boardsesh. It is independent of the PostHog SDK queue and does not change the automatic-download default. [#7986](https://github.com/boardsesh/boardsesh/issues/7986) owns recovery and disposition of the existing stuck-write cases; [#7989](https://github.com/boardsesh/boardsesh/issues/7989) owns the rollout decision and its product targets.

## Denominator and identity

The denominator is a successful insertion of an instrumented outbox entry, observed with an offline reason at enqueue. Its opaque `deliveryId` identifies one queue-entry lifetime. It is separate from the mutation's existing business idempotency key.

`enqueueMeasuredMutation` freezes enqueue time, connectivity reason and running release metadata. The shared engine's SQLite insert trigger creates `offline_write_delivery_journal` evidence in the same statement as the outbox insert. A transaction rollback rolls back both. `INSERT OR IGNORE` suppression creates no second journal entry, and retrying or reviving a dead letter retains the original delivery ID. Removing an entry and later inserting a new intent creates a new lifetime. Cancellation and supersession keep their own disposition rather than becoming successes.

Only `device_offline`, `backend_unreachable` and `offline_mode` belong in the offline cohort. Keep their breakdowns separate: a deliberate Offline mode session and a backend outage do not establish no-signal behavior. Online writes can exercise the protocol but do not enter this denominator. Startup connectivity can be unknown before the device probe resolves; `unknown` is an explicit coverage gap, not inferred offline activity.

Rows already in the queue before instrumentation have no durable enqueue observation. They remain legacy cases rather than being retroactively assigned an origin, enqueue release or new denominator entry. A server receipt whose enqueue observation never arrives is also outside the observed denominator and must be reported separately.

## Independent stages

| Evidence | Meaning | What it does not establish |
| --- | --- | --- |
| Durable journal entry | The outbox entry committed on the device | A request reached the backend |
| Client `serverResponseAt` | The replay returned a usable response | Independent proof of a server commit |
| Backend `serverAcceptedAt` | An allowlisted, authenticated replay resolver returned after its canonical operation committed | The device applied local bookkeeping |
| `finalized` | The outbox removal and journal transition committed atomically | The local entity exists or a deletion is reflected |
| `reconciled` | The device verified committed local storage after finalization | An independent backend acceptance receipt exists |

Replay dispatch carries `x-boardsesh-offline-write-id` per request, never as mutable client-wide headers. The backend observer binds it to the authenticated owner, actual mutation and a private operation fingerprint. It observes only recognized, single-root HTTP mutations. Successful idempotent replays can establish acceptance; generic failures and missing receipts remain ambiguous. The client upload API cannot set the server acceptance or rejection columns. A receipt persistence failure does not convert a successful business write into a failed save.

Local proof reads SQLite or persisted workout preferences, not the optimistic query cache. A normal tick requires its owned local logbook row. An outbox-only fallback cannot reconcile until a later pull creates that row. Authored climbs require the canonical mirrored row; favorites and follows check the requested local presence or absence; workouts check persisted session and revision state. A dormant or legacy handler without a proof stays unreconciled. An empty outbox alone is never proof.

The journal retains the first client response, first and last dead-letter times and recovery history. Transient retries and dead-letter revival do not enlarge the denominator. The report's `recovery_history` counts retry or revival history; `recovered` additionally requires server acceptance and local reconciliation. Server rejection can precede recovery, so rejection history is retained alongside eventual acceptance. A deleted-target cleanup, explicit discard or superseded operation must not be silently interpreted as a delivered save.

## Publication, accounts and privacy

The publisher runs independently of mutation draining. It starts after the database's account owner is claimed, wakes on launch, foreground, usable reconnect and outbox changes, and schedules a foreground heartbeat every 60 seconds. Each trigger examines and uploads at most 100 entries; it never drains an unbounded backlog in one loop. Background, effective-offline and account-generation guards stop it. Publication failures do not consume mutation retries or interrupt saves.

`recordOfflineWriteObservations` requires `ownerUserId` to match the currently authenticated account. Each observation carries its monotonically increasing revision, and an acknowledgement covers that exact uploaded revision. Duplicate or reordered delivery cannot consume a newer local observation. Both the local owner stamp and the credential generation are checked across awaits. Account teardown removes the owner's local journal with their data. A departure that could not report remains unknown on the server; the next account cannot upload those observations under its identity.

Private local reconciliation targets contain only the references needed to inspect committed storage. They are not uploaded. Server receipts retain a private owner relationship and binding fingerprint, without duplicating tick comments or other mutation payloads. Existing account erasure includes the receipt rows. Aggregate reports omit account IDs, mutation IDs, delivery IDs and local target references.

The receipt protocol is first-party operational evidence. Existing consent requirements still apply to optional product analytics; enabling analytics later does not reconstruct missing historical events. PostHog delivery, duplication or queue overflow cannot turn a private receipt gap into success, and PostHog absence is not used as a receipt denominator.

## Repeatable evidence report

The exact aggregate query is [offline-write-delivery-report.sql](../../packages/backend/scripts/offline-write-delivery-report.sql). Run it on the intended environment's database, supplying a fixed UTC `as_of`, inclusive cohort start, exclusive cohort end and the project's internal/test account exclusions privately. The query publishes aggregates only; never commit a private exclusion list or row-level receipts as evidence.

Use seven days of follow-up as the primary view and 24 hours as the sensitivity view. Time starts at `first_seen_at`, the first backend receipt or upload proving a usable reconnect. This is an observed-reconnect measure; it is not a census of all writes made on phones. Report enqueue-to-receipt delay separately rather than pretending a phone that remained offline had seven days of delivery opportunity.

The report separates server acceptance from local reconciliation, includes late outcomes, and shows immature age-censored cohorts separately. Pending requires both a fresh client observation and a fresh server receipt of that observation; the default freshness window is 24 hours. A silent or stale client becomes unknown. Re-uploading an old observation does not create fresh client follow-up. Recoveries after the selected deadline remain late recoveries rather than rewriting the deadline's success count.

Client wall-clock dates are useful diagnostic metadata, not the authoritative follow-up clock. Invalid or skewed enqueue/observation dates require separate inspection; do not derive success or maturity from their apparent age. Backend receipt times anchor follow-up and local reconciliation reporting. A reconciliation that occurred offline but reported later is conservatively observed when its report arrives.

Break results down by enqueue release and receiving release: native application namespace, platform, application version, runtime fingerprint, OTA update ID, embedded status and branch. The primary cohort requires `com.boardsesh.app`; development clients and missing namespaces belong in separate coverage counts. Application version alone cannot identify the code that ran. Exclude explicitly non-production branches and report missing runtime/branch attribution separately. The database connection establishes the server environment; a client-supplied branch name is not proof that the backend is production.

Never-reconnected phones cannot export their local denominator. Lost storage, uninstall, unreported account departure, old bundles and unavailable proof handlers also limit coverage. Publish these limits alongside the success, rejected, pending, unknown, superseded, discarded, recovered and late populations. The observed cohort must never be described as the entire fleet.

## Release and acceptance

Deploy the generated Postgres migration and backend receipt support before the instrumented mobile OTA. Backend initialization also applies the maintenance worker's column-level receipt reads for account exports. Old clients do not send the optional header or call the new API. An instrumented client talking to a temporarily older backend keeps publication pending and continues normal business replay; publication failure does not burn mutation retries.

The SQLite change is device-only migration 15: nullable queue metadata, a new journal table and triggers, with no rewrite of old payloads or catalogue artifacts. Artifact schema compatibility remains at version 12. The previous code can ignore the additive columns and table at the SQL level, but the repository's [schema downgrade guard](offline-sync.md#older-js-on-a-newer-database-the-downgrade-rule) deliberately refuses any database whose version is newer than the running bundle. An OTA rollback can therefore pause local storage and leave queued writes intact until a compatible bundle returns. Never reset the database, reduce its version or bypass that guard to make a rollback appear compatible. The PR's offline-migration compatibility notes must name this behavior and the recovery order.

Automated tests cover real SQLite rollback, duplicate enqueue and delivery, replay identity, restart, finalization atomicity, recovery history, upload revision races and owner changes. These are protocol checks, not device or production receipts.

Issue #7988 is not complete solely because CI passes. Retain iOS and Android evidence for offline enqueue, restart, reconnect, transient retry, duplicate delivery, server rejection and local reconciliation failure, including one canonical tick despite repeated requests. After release, retain the exact report parameters, receiving runtime/OTA identities, extraction date and mature aggregate results for both platforms. No native device run or mature production cohort is claimed by this implementation. #7989 remains responsible for deciding whether that evidence meets the rollout targets.
