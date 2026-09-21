# Repairing ticks filed on a shared feed

This local operator tool addresses the existing data from #5121. The tick’s active session board takes precedence when its board type, layout, size and normalized set IDs match the feed, including a party session hosted by another climber. A matching session already on the feed stays there. Otherwise, the fallback requires exactly one live matching board owned by the climber; ambiguous or absent matches stay on the feed. Missing sessions, deleted session boards and configuration mismatches do not override that fallback. Historical counts in the PR are the original author’s September 7 report, not a current measurement.

The default is a database dry-run. It still writes a local JSON plan; keep that file for review. Every plan and recovery snapshot is created exclusively: an existing file causes the command to fail before applying any database changes. Existing explicit paths are rejected before database queries; the exclusive create still guards a path created concurrently after that check. Defaults include `plan` or `apply` and a filesystem-safe ISO timestamp, so a same-day preview and apply use different paths. Choose a new `--out` path when supplying one explicitly. The legacy `--dry-run` flag remains supported. Unknown options, missing filenames and conflicting `--apply --dry-run` flags are rejected before connecting.

```sh
vp run db:backfill-shared-feed-tick-boards -- --out shared-feed-plan.json
```

Only after the plan is reviewed and the operator authorizes the data change, use an explicit write flag and keep the resulting snapshot:

```sh
vp run db:backfill-shared-feed-tick-boards -- --apply --out shared-feed-applied.json
```

Both directions group by current and target board IDs, update at most 500 UUIDs per statement, and run all batches in one transaction. The current board must still match the snapshot, so a later re-file is skipped. Moved ticks receive a fresh sync timestamp; their climber and other tick fields are unchanged. The report distinguishes moves to session walls from sessions already correctly on the feed. Owner lookup reads are also bounded to 500 IDs. The script does not change board ownership.

The transaction retains locks on touched tick rows until the entire operation commits or rolls back, so concurrent edits to those rows may wait. For a separately authorized production apply or revert, schedule a low-traffic window and monitor transaction duration. The 500-row statement limit does not release locks between batches; atomic rollback is intentional.

Revert is also a dry-run unless `--apply` is explicit:

```sh
vp run db:backfill-shared-feed-tick-boards -- --revert shared-feed-applied.json
vp run db:backfill-shared-feed-tick-boards -- --revert shared-feed-applied.json --apply
```

Revert previews report the snapshot’s row count; apply reports the number still matching its current-board guard. Keep snapshots until the repair is verified. Preparing or merging this tooling does not authorize a production run.

Recovery files are validated before opening a database connection. Invalid JSON,
missing metadata, malformed entries, or non-integer/out-of-range board IDs fail
with an entry-specific error; fix or recover the snapshot before retrying.

CI's existing `test-backend` job runs all three Node suites without an affected-file
filter on its first shard. Integration fixtures use only its disposable loopback
PostgreSQL service, and CI rejects a missing URL, failed tests or any skipped
integration cases. Locally, set `SHARED_FEED_TICK_TEST_DB_URL` to an explicit
loopback test database before running the integration file; a remote host is refused.
