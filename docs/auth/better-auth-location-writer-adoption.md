# Selected-authority location owner and data writes

This draft implements the remaining location-sync fixed-owner writer from epic
#6975, after the shared batch preparation in
[the preparation proof](better-auth-location-batch-preparation.md). Rollout and
activation remain tracked in #7430. Every production activation gate remains
open; this change enables no mode and changes no deployed grant.

## Compound commit

`CURRENT_STORE_LOCATION_SYNC_MODE` defaults to `legacy`. The optional
`backend-staging` mode requires the separately selected
`CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE=cooperative-staging`, the existing
enforced identity projection and cutoff enforcement, plus a dedicated trusted
origin and RPC secret. The location secret must differ from human auth, cron,
NextAuth, batch-system-user and deleted-email secrets.

Actual worker dispatch binds a batch writer to the claimed run ID and attempt
token. The public MoonBoard and Aurora location entrypoints require that delegate
in staged mode; unsupported direct CLI/daemon calls fail before location writes.
Aurora refuses a staged shared pass without a delegate before claiming its
cooldown or writing catalog data. A dispatcher-bound delegate stays selected if
the process mode later changes. Neither transport uncertainty nor a lost reply
permits a direct SQL fallback or an automatic retry.

Provider HTTP and the private request run outside the worker's SQL transaction.
The backend owns one compound transaction, in this order:

1. Lock/revalidate the exact persisted run and active queue attempt.
2. Derive the provider from its persisted routine-provider family and payload.
3. Capture the selected writer receipt, take the fixed-owner key, and ensure the reserved system identity.
4. Apply the existing location data helper, retaining its PostGIS matching, aliases and savepoints.
5. Revalidate the selected receipt and both job fences before committing.

The owner, email reservation, replay nonce, aliases, gyms and boards roll back
together. A failure in the first batch cannot leave an owner-only commit. Later
batch failures retain earlier committed whole-gym batches. Existing owner fields
and the prohibition on authentication history are inherited from the fixed-owner
core. The new path issues no credentials, sessions, profiles or verification
links. Replay claims use a disjoint location subnamespace of the existing bounded
expired-command cleanup.

The backend accepts MoonBoard and Aurora's current scheduled location providers
(tension, decoy, touchstone, grasshopper and soill). Board type and both source-key
prefixes must match the locked run. Callers cannot choose an owner. Existing
worker ledger DML is not tamper-proof evidence of a job family's provenance.

## Bounds and compatibility

Batches retain the existing 25 complete-gym grouping, first-seen gym order,
duplicates, source keys and invalid-coordinate skips. The wire projection omits
provider-only fields such as `layoutName`; explicit NaN/Infinity sentinels retain
the existing planner's skip behavior across JSON. Empty batched input does not
create an owner. A nonempty all-invalid batch still establishes its owner and
reports skips. Legacy direct empty-input behavior remains unchanged.

A command accepts at most 1,024 records and 512 KiB of UTF-8 JSON. A complete gym
that exceeds either cap is rejected without truncation or splitting. Summary
responses are bounded to 1 MiB. These are admission limits, not a claim that every
possible duplicate or upstream string fits; rejected jobs require investigation.
The real current MoonBoard catalog emits 350 records for 25 gyms and fits.

The backend uses a 25-second cooperative command deadline, existing per-statement
and lock limits, and the job fence's final real lease checks. The client permits
30 seconds for a response. A deadline cannot interrupt a SQL statement; the next
checkpoint rolls its enclosing transaction back. A lost response may follow a
successful commit, so no transport retry is attempted. A later job retry uses
existing deterministic source/UUID upserts.

## Evidence and remaining gates

The dedicated proof uses actual private HTTP, the actual transport codec,
PostgreSQL 18/PostGIS, all 311 unchanged migrations and both original migration
ledgers, real pg-boss initialization, and actual fetched/claimed jobs. Its backend
actor is a generated restricted role with the exact identity/content privileges
used by the composition. No production grants are inferred from that fixture.

The proof covers both selected authorities with forward mirroring off; first
owner/data failure rollback; stale attempts, projections and provider binding;
whole-gym partial progress; invalid coordinates; oversized requests; replay
cleanup; cooperating content and existing-owner lock waits; actual missing-donor
and missing-credential worker dispatch; and a committed success whose HTTP reply
is destroyed. In-flight SQL sleeps prove final receipt and real lease rejection
without a short advisory-lock timeout masking those checks. An unrelated positive
password registration completes while the location statement is in flight.

The actual 350-record MoonBoard builder is exercised through one private request.
This is local bounded timing evidence, not a production latency or pool-capacity
qualification. A compound batch holds the shared auth gate and fixed-owner
exclusive key through its data writes. Operator switches may hit their existing
2-second gate timeout while a batch is active; this remains an operational gate.

CI runs the proof as a required step of the PostGIS location integration job,
using a separate fresh disposable database and the checked-in per-file migration
bootstrap. The bootstrap binds the URL and PG* targets before any mutation and
refuses shared `main` databases. Ordinary simplified backend schemas cannot
substitute for this proof.

Global fixed-owner cooperation, bounded deployed pool behavior, stale legacy
worker/daemon fencing, actual least-privilege rollout grants, all other remaining
writer adoption, production activation and hardware/offline release acceptance
remain gates. Selecting the cooperative mode is a software prerequisite, not a
mixed-fleet role fence. A stale legacy location process can still attempt its
legacy user insert; stopping/fencing those writers must be proved before rollout.
