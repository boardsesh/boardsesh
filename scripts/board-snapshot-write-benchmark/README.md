# Snapshot cursor-trigger write benchmark

This pgbench harness compares the four tables touched by migration `0250_board_snapshot_replica_fence.sql` on two disposable, otherwise-identical PostgreSQL 18 databases:

- **baseline:** current schema through migration 0249, with the existing climb/stat update and delete triggers;
- **candidate:** a clone of that database with only migration 0250 applied.

Before measuring, compare catalog signatures for all affected-table indexes and column defaults with `schema-signature.sql` in both databases. `seed.sql` adds synthetic rows only; it never reads or edits production data. Run it only against private, disposable databases with a unique loopback endpoint. Do not point it at a shared development DB or a production database.

Seed 16,000 upsert rows for each target table and 32,000 rows for the delete path in both databases by running `seed.sql` once per database. Then run `workload.pgbench` with `-c 1 -j 1 -D batch_rows=1000`. The seven `scenario` values cover:

1. New `board_climbs` inserts.
2. `board_climbs` conflict-updates, exercising insert and existing update triggers.
3. New `board_climb_stats` inserts.
4. `board_climb_stats` conflict-updates, exercising insert and existing update triggers.
5. New `board_climb_grades` inserts.
6. `board_climb_grades` conflict-updates.
7. Batched deletes from climbs and stats, including their tombstone inserts into `sync_deletions`.

Use one unreported warm-up transaction followed by three measured repetitions of ten transactions per scenario. Alternate which database runs first on each repetition. Each insert or upsert transaction commits one 1,000-row batch; each delete transaction removes up to 1,000 rows from both climbs and stats. Collect pgbench's per-transaction log and compare the median, 95th percentile, minimum, maximum, and median percentage difference for each path. Record PostgreSQL version, relevant server settings, table/index signatures, synthetic row counts, and the exact migration hash with the result. The run is single-client and synthetic; it is a comparison on that local environment, not a production throughput claim.

Before recreating a run, create fresh scratch databases from the same pre-0250 schema and apply 0250 only to the candidate. The fixed synthetic prefixes make it straightforward to remove only benchmark rows from an owned scratch database after the comparison.

Example for scratch databases on a private loopback port (replace the port, role, and scratch database names with the values for your disposable PG18 instance):

```sh
psql -h 127.0.0.1 -p <port> -U <scratch-role> -d boardsesh_snapshot_bench_base -At -f scripts/board-snapshot-write-benchmark/schema-signature.sql > baseline.signature
psql -h 127.0.0.1 -p <port> -U <scratch-role> -d boardsesh_snapshot_bench_candidate -At -f scripts/board-snapshot-write-benchmark/schema-signature.sql > candidate.signature
diff -u baseline.signature candidate.signature
psql -h 127.0.0.1 -p <port> -U <scratch-role> -d boardsesh_snapshot_bench_base -v ON_ERROR_STOP=1 -f scripts/board-snapshot-write-benchmark/seed.sql
pgbench -h 127.0.0.1 -p <port> -U <scratch-role> -n -c 1 -j 1 -t 10 \
  -D scenario=1 -D batch_rows=1000 -l --log-prefix=<unique-path> \
  -f scripts/board-snapshot-write-benchmark/workload.pgbench boardsesh_snapshot_bench_base
```

Run the seed once in each database, then run all scenarios `1` through `7` on both databases. Use a fresh pair for each full comparison; scenario 7 consumes its synthetic delete fixture.
