# Plays

`board_climb_stats.play_count` counts estimated meaningful selections at that row's
`(board_type, climb_uuid, angle)`. The [Plays API](https://github.com/boardsesh/boardsesh/pull/8081)
delivers these counts through read APIs, offline sync and snapshots. Display work is tracked
in [#8021](https://github.com/boardsesh/boardsesh/issues/8021) for mobile and Expo web and
[#8022](https://github.com/boardsesh/boardsesh/issues/8022) for public web. A play is not
proof of illumination, an attempt, or an ascent.

## Counting

The hourly `refresh-climb-plays` batch family reads native `board_climb_events`
only. Imported Kilter history contributes neither counts nor timing boundaries.
Consequently an intervening change made through another app may be unobserved.
Virtual board selections remain included; durable history cannot distinguish them
from physical LED writes.

The refresh excludes deleted boards and the known QA fixtures (`boardsesh-qa-%`
board slugs or gym slug `boardsesh-qa`). A shared feed has system owner
`00000000-0000-0000-0000-000000000000` and a `presence-` slug. Its timeline is split
by reporting user, so unrelated walls do not shorten one another's durations.
Shared-feed records with a null reporter are excluded: deleted reporters must not
be combined into one artificial timeline. Individually identified boards use one
timeline across all reporters.

Within each timeline, records are ordered by `confirmed_at, seq`. Aliases resolve
before consecutive identical climb-and-angle reports are collapsed; a gap over
30 minutes starts another run. A run qualifies when the next run starts at least
30 seconds after its first report and no more than 30 minutes after its last
report. This last-report cutoff permits a long run with repeated evidence of
activity. Final runs with no next event are unmeasured and do not count. Clearing
the board and disconnecting do not leave durable endings. Shared-feed estimates
can miss a collaborator's change and can count the same physical wall twice.

## Storage and operation

The job takes one primary-database statement snapshot of the history and stats,
then updates only differences in fenced batches of at most 500 existing stats
rows. It writes `play_count`, preserving grades and ascents. The stats trigger
advances `updated_at` and `sync_seq` for changed counts, including resets to zero.
Equal counts leave both sync fields stable on retries and subsequent runs.
Previously positive keys absent from the new aggregate become zero. Missing stats
keys and their play totals are reported. A later hourly pass fills them once
catalog or tick writers create the row.

The schedule is `23 * * * *` in UTC. Scheduled work and manual backfills use the
same `all` singleton key. Retry recomputes from a fresh snapshot, so an interrupted
partially applied pass converges. Alias, history, or board changes after the read
snapshot appear on the next pass. Failed reads abort before writes. Run logs
include measured time, qualifying plays, excluded records, unmatched keys/plays,
planned and changed rows, zeroed rows, and duration.

## Rollout and backfill

1. Deploy the [Plays storage schema](https://github.com/boardsesh/boardsesh/pull/8023),
   then deploy the Plays API and its stats sync trigger. Verify the migration and
   grant reconciliation completed before merging the worker. The batch role
   needs `UPDATE (play_count)` and `USAGE` on `board_climb_stats_sync_seq_seq`.
   The [worker image can start before migrations finish](../backend/background-workers.md#a-new-worker-image-can-start-before-the-migrator-has-run).
2. Deploy the backend revision that registers `refresh-climb-plays` with that
   family in `BATCH_FAMILIES_DISABLED` and preserve any other disabled entries.
   Apply this setting with the revision that knows the family. Older revisions
   treat the unknown entry as an invalid configuration and clear all schedules.
3. In the [batch-worker operator environment](../backend/background-workers.md#operator-commands-and-health),
   enqueue a dry run. Wait for its run ID to succeed and review the logged totals
   against an independent read-only sample of the native history. Review unmatched
   keys, planned writes and run duration. Each dry run scans the eligible history.

   ```sh
   vp exec tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-plays '{"dryRun":true}'
   vp exec tsx packages/backend/src/workers/operator.ts status <dry-run-id>
   ```

4. With the hourly schedule still disabled, enqueue the backfill and wait for it
   to succeed. Compare `play_count` and `sync_seq` at the sampled climb angles
   before and after the run. All changed rows become eligible for the next stats
   sync pull, so the first backfill can increase sync traffic. The schema default
   is zero before the first backfill. The positive-count partial index limits
   the stale-key scan to rows holding a count above zero.

   ```sh
   vp exec tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-plays
   vp exec tsx packages/backend/src/workers/operator.ts status <backfill-run-id>
   ```

5. After verifying the backfill, remove only `refresh-climb-plays` from the
   disabled list, redeploy the backend and confirm the next hourly run succeeds.
   If verification fails, keep or restore the disabled entry and inspect the
   affected run. Schedule changes prevent future ticks. Queued jobs can still
   start, and running jobs can finish.
