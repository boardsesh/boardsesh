# Repairing `board_climb_holds`

This repair rebuilds stale materialized hold rows for multi-frame Aurora-family climbs and removes globally invalid rows (`hold_id <= 0`, an empty state, or a state containing `=`) elsewhere. A valid frame sequence that projects to no canonical holds is cleaned to an empty row set. The repair also migrates fingerprints only when the old value is provably derived from the old rows or the historical per-frame Grips tokens; independent fingerprints are left alone. It does not change climb frames or run against MoonBoard multi-frame data.

## Kilter rollout bridge

Deploy the catalog-sync compatibility bridge before running this repair. During each sync it reads catalog-owned multi-frame Kilter rows once, proves which stored fingerprints came from the historical raw frame events, and adds their current projected fingerprints to the in-memory dedup index without changing the database. Existing stored fingerprint owners always win, and empty or unproven projections add no key.

That dual-key bridge prevents the Kilter daemon from creating a second canonical in the interval between deploy and repair, so the daemon does not need to stay paused for that whole rollout interval. The repair migrates proven legacy fingerprints to the projected key; after migration the stored key is already primary and the bridge is a no-op. Writers should still be paused for the short approved apply window below, when the repair takes table locks.

## Approval gates

Production access is never implicit. Get explicit operator approval separately for:

1. the production dry-run;
2. the production apply, including its short table-lock window; and
3. the post-commit cache action.

Pause catalog and sync writers only for the approved apply window. The transaction takes `SHARE ROW EXCLUSIVE` locks on `board_climbs` and `board_climb_holds`, uses a five-second lock timeout and a two-minute statement timeout, and rolls back on any manifest or verification mismatch. The statement timeout applies to each statement; if the large batch delete or insert times out, the entire transaction rolls back.

## Target database

Inject the approved direct PostgreSQL connection as `DB_URL` through the operator's secret manager before each command. Do not rely on the repository's auto-loaded development env files, and do not paste production credentials into this runbook or shell history.

The script prints `database_host=...` before doing any work. Verify that host against the approved target before accepting a dry-run report. Verify it again immediately before apply; a digest from one host must never authorize writes to another.

## Dry-run

Run the report first. Dry-run performs only reads and takes no table or advisory locks.

```sh
vp run db:repair-board-climb-holds -- --report-limit 100
```

Record the printed SHA-256 and the exact `scanned`, `changed`, `invalid_rows`, `fingerprint_updates`, and `affected` counts. `affected` includes fingerprint-only migrations, so use it for the apply ceiling even when the materialized rows are already canonical. Review every blocker and diagnostic, especially unknown roles, nonpositive IDs, missing placements, malformed frames, and `frames_count` mismatches. Do not apply while any blocker exists.

Missing placements are automatic blockers, not overridable warnings. Repair or resync the affected board's placement catalog, then run a new dry-run and review its new digest and counts. The apply command has no override for missing placement IDs.

## Apply

After approval, pass every reviewed guard back verbatim. `--max-affected` is a ceiling and should normally equal the reviewed affected count.

Confirm the printed `database_host` is still the approved target before allowing the transaction to continue.

```sh
vp run db:repair-board-climb-holds -- --apply \
  --expected-digest <sha256> \
  --expected-scanned <count> \
  --expected-changed <count> \
  --expected-invalid <count> \
  --max-affected <count> \
  --report-limit 100
```

After the locks are acquired, the script rebuilds the manifest inside the repeatable-read transaction. Any drift aborts before writes. It then verifies the exact projected rows for every rebuilt climb and requires the global invalid-row count to be zero before commit. A second approved dry-run should report `changed=0`, `invalid_rows=0`, and a new stable digest for that clean state.

## Popular-config cache

The database script never touches Redis. After a successful, approved production apply, request separate approval before changing the cache.

Inspect the lock key `boardsesh:popular-board-configs:lock`. Never delete or overwrite that lock. If it exists, wait for its 120-second TTL to expire. Then delete only `boardsesh:popular-board-configs`, warm or restart one backend instance, and verify that the rebuilt value exists and has the expected TTL. Counts may move in either direction because repaired valid rows can change config membership.
