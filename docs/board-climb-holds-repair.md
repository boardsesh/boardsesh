# Repairing `board_climb_holds`

This repair rebuilds stale materialized hold rows for multi-frame Aurora-family climbs and removes globally invalid rows (`hold_id < 0`, zero on boards other than Woods, an empty state, or a state containing `=`) elsewhere. A valid frame sequence that projects to no canonical holds is cleaned to an empty row set. The repair also migrates fingerprints only when the old value is provably derived from the old rows or the historical per-frame Grips tokens; independent fingerprints are left alone. It does not change climb frames or run against MoonBoard multi-frame data.

## Production status

As of this PR's backlog repair on 2026-09-21, no production connection, count,
dry-run, apply or cache refresh has been performed by this work. The production
baseline is **unknown**, not zero. Local fixture results and green CI do not
establish production acceptance. Keep #3985 open until the operator records the
approved target, commit, timestamp, manifest digest and exact before/after counts.

## Kilter rollout bridge

Deploy the catalog-sync compatibility bridge before running this repair. During each sync it reads catalog-owned Kilter rows with multi-frame or noncanonical single-frame text once and proves whether each stored fingerprint came from historical raw frame events or the stored-row projection. The owner index uses the proven raw-event key for either generation and never adds the lossy projected key as an alias. It rebuilds owners from all UUID-ordered rows, so suppressing an animated row's projected key still lets a true single-frame row with that key become its owner. Empty projections add no key, and independent fingerprints remain unchanged.

That compatibility normalization prevents the Kilter daemon from creating a second canonical across the historical and repair-era stored hashes without letting a simple climb alias to an animated projection. When applied, the repair writes proven legacy fingerprints to the projected key; the sync reconstructs their exact raw-event identity from the unchanged frames. Writers should still be paused for the short approved apply window below, when the repair takes table locks.

## Approval gates

Production access is never implicit. Get explicit operator approval separately for:

1. the production dry-run;
2. the production apply, including its short table-lock window; and
3. the post-commit cache action.

Pause catalog and sync writers only for the approved apply window. The transaction takes `SHARE ROW EXCLUSIVE` locks on `board_climbs` and `board_climb_holds`, uses a five-second lock timeout and a two-minute statement timeout, and rolls back on any manifest or verification mismatch. Placement lookups, changed-climb identities, fingerprint updates, inserts, invalid-row deletes, and exact-row verification are split into bounded PostgreSQL JSON parameters: at most 500 identities or 5,000 mutation rows, and at most 1 MiB per parameter. All batches still run under the same locks in one transaction; a failure in a later batch rolls back every earlier batch.

## Target database

Inject the approved direct PostgreSQL connection as `DB_URL` through the operator's secret manager before each command. Do not rely on the repository's auto-loaded development env files, and do not paste production credentials into this runbook or shell history.

The script prints `database_host=...` before doing any work. Verify that host against the approved target before accepting a dry-run report. Verify it again immediately before apply; a digest from one host must never authorize writes to another.

## Dry-run

Run the report first. Dry-run performs only reads and takes no table or advisory locks.

```sh
vp run db:repair-board-climb-holds -- --report-limit 100
```

Record the printed SHA-256 and the exact `scanned`, `changed`, `invalid_rows`, `fingerprint_updates`, and `affected` counts. `affected` includes fingerprint-only migrations, so use it for the apply ceiling even when the materialized rows are already canonical. Review every blocker and diagnostic, especially unknown roles, invalid hold IDs, missing placements, malformed frames, and `frames_count` mismatches. Do not apply while any blocker exists.

A leading empty frame is the delayed-start encoding — the wall stays dark for one pace tick — and both Aurora and our own Kilter Grips importer emit it, so it is accepted rather than blocked. An empty unquoted frame anywhere after frame 0 is still corruption and still blocks. `frames_count` is compared against the raw comma-delimited slot count, which is what Aurora and Grips record.

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

After the locks are acquired, the script rebuilds the manifest inside the repeatable-read transaction. Any drift aborts before writes. It then verifies the exact projected rows for every rebuilt climb, including climbs whose authoritative projection is empty, and requires the global invalid-row count to be zero before commit. Woods uses valid zero-based, code-driven hold IDs; its hold zero is preserved in both the repair and similarity readers. Only multi-frame projection is restricted to the Aurora-family board allowlist; invalid stored rows are discovered, deleted, and verified across all board types. A second approved dry-run should report `changed=0`, `invalid_rows=0`, and a new stable digest for that clean state.

## Popular-config cache

The database script never touches Redis. After a successful, approved production apply, request separate approval before changing the cache.

Inspect the lock key `boardsesh:popular-board-configs:lock`. Never delete or overwrite that lock. If it exists, wait for its 120-second TTL to expire. Then delete only `boardsesh:popular-board-configs`, warm or restart one backend instance, and verify that the rebuilt value exists and has the expected TTL. Counts may move in either direction because repaired valid rows can change config membership.

## Existing missing-hold backfill

The separate `backfill-board-climb-holds.ts` script fills missing single-frame
materialized rows; it is not this guarded historical repair. It retains the
`NOT EXISTS` missing-row filter and adds an in-memory ascending UUID cursor so a
full batch with no valid projected holds cannot be fetched forever. Each invocation
starts that cursor from the beginning for each board type. Inserts sorting before
the current cursor may wait for the next invocation; no resume cursor is persisted.
The final remaining-row report includes rows whose frames could not be projected.
Aurora-family frames use the canonical projection; Woods (including hold zero) and
spray retain their existing single-frame parsing. This script is not wired into
the board-snapshot publication pipeline.

Similarity target reads use nonempty multi-frame text as the authoritative hold
projection. The LEFT JOIN skips materialized rows only when that projection is
already selected; null/empty frames and single/unknown frame counts retain the
materialized fallback. Running the repair does not switch that reader policy or
remove the need to parse authoritative animation frames.
