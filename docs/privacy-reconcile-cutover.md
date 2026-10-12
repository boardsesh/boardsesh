# Reconciliation cleanup: counts and backend cutover

Migration `0265_privacy_reconcile_tick_tombstones.sql` removes server-written
tick restrictions and converts legacy private session policies to Unlisted.
The backend preceding #6345 treats that new session policy incorrectly. The
normal production workflow migrates before deploying the backend; that order
alone is insufficient for this data cleanup.

The migration is already applied in production. Its exact SQL, header and
Drizzle hash remain immutable. The successful production migration job on
2026-10-12 reported **0 tick stamps removed and 3 legacy sessions remapped** at
06:47:17 UTC. These are applied counts, not a pre-deploy dry run; no historical
dry-run result is available. Evidence: [run 38213666849, migration job
114694688718](https://github.com/boardsesh/boardsesh/actions/runs/38213666849/job/114694688718).
The backend deployment job was queued afterward at 06:47:57 UTC. Do not describe
that release as an already-safe migration/deploy order.

## A pending migration on another environment or restore

The updated runner checks 0265's exact hash in the ledger and counts both blocks
before any migration, queue initialization or ACL reconciliation. Remote targets
always enforce the gate; Production additionally sets
`PRIVACY_RECONCILE_REQUIRE_CUTOVER=1`, including through a local tunnel. An
already-applied hash needs no acknowledgement. A pending migration fails
closed, prints both read-only counts and the exact acknowledgement required,
and does not write migration guards or advance the ledger. Local development
and disposable CI fixtures retain their existing automatic migration behavior.

1. Stage the updated runner and stop older automatic release/migration jobs.
   Run the normal migration command once without `PRIVACY_RECONCILE_CUTOVER`.
   It prints the migration hash and both dry-run counts, then stops before DDL.
2. Obtain the owner's approval for the counted cleanup. Pause and drain every
   old backend instance and worker that reads or reconciles sessions. Keep
   their traffic and jobs stopped throughout migration and deployment.
3. In the Production environment set `PRIVACY_RECONCILE_CUTOVER` to the exact
   printed count/hash value with the **next** attempt number,
   `<hash>:<tick-count>:<session-count>:readers-paused:<run-id>.<attempt>`. This is an
   explicit operator attestation, not an automatic measurement of the pause.
   Rerun that release. The run ID stays the same, but each rerun increments
   the attempt: an acknowledgement printed for attempt 1 must end in `<run-id>.2`
   for its first rerun. The runner recounts; changed counts, hashes, run IDs or
   attempts reject a stale acknowledgement. Zero counts also require the
   attestation.
4. Keep readers stopped until the #6345-or-newer Unlisted-aware backend has
   passed exact-deployment identity and API health checks. Then restore traffic
   and clear the one-time acknowledgement.

For a direct CLI migration outside GitHub, set a fresh one-run
`PRIVACY_RECONCILE_CUTOVER_SCOPE` nonce before the initial read-only preflight.
Use the same nonce as the acknowledgement suffix for that approved invocation,
then clear both variables. There is no implicit or persistent default. GitHub
always uses its real run ID and attempt and ignores the CLI nonce.

The migration workflow still gates backend deployment on successful migration.
The runner prerequisite prevents that DAG from applying this incompatible
cleanup while older readers are serving. Do not deploy arbitrary new code
before its other pending schema migrations just to invert the DAG.

## After migration and rollback

Only restore a backend that understands Unlisted session policies and no
longer stamps tick audiences during reconciliation. The three production rows
already converted by 0265 remain converted during a container rollback. If no
compatible rollback build is available, keep affected readers stopped and roll
forward. Do not rewrite or rerun the historical DELETE/UPDATE to manufacture a
dry-run record. Changing a privacy flag cannot substitute for read enforcement.
