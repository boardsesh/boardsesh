# Repairing ticks filed on a shared feed

This local operator tool addresses the existing data from #5121. A tick is eligible only when its climber owns exactly one live board with the feed’s board type, layout, size and normalized set IDs. Ambiguous matches and climbers with no matching board stay on the feed. Historical counts in the PR are the original author’s September 7 report, not a current measurement.

The default is a database dry-run. It still writes a local JSON plan; keep that file for review. Every plan and recovery snapshot is created exclusively: an existing file causes the command to fail before applying any database changes. Choose a new `--out` path for each run. The legacy `--dry-run` flag remains supported. Unknown options, missing filenames and conflicting `--apply --dry-run` flags are rejected before connecting.

```sh
vp run db:backfill-shared-feed-tick-boards -- --out shared-feed-plan.json
```

Only after the plan is reviewed and the operator authorizes the data change, use an explicit write flag and keep the resulting snapshot:

```sh
vp run db:backfill-shared-feed-tick-boards -- --apply --out shared-feed-applied.json
```

Both directions group by current and target board IDs, update at most 500 UUIDs per statement, and run all batches in one transaction. The current board must still match the snapshot, so a later re-file is skipped. Moved ticks receive a fresh sync timestamp; their climber and other tick fields are unchanged. Owner lookup reads are also bounded to 500 IDs. The script does not change board ownership.

Revert is also a dry-run unless `--apply` is explicit:

```sh
vp run db:backfill-shared-feed-tick-boards -- --revert shared-feed-applied.json
vp run db:backfill-shared-feed-tick-boards -- --revert shared-feed-applied.json --apply
```

Revert previews report the snapshot’s row count; apply reports the number still matching its current-board guard. Keep snapshots until the repair is verified. Preparing or merging this tooling does not authorize a production run.
