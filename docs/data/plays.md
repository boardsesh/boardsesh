# Plays

`board_climb_stats.play_count` counts estimated meaningful selections at that row's
`(board_type, climb_uuid, angle)`. It is server-only for now: API fields, offline
sync and snapshots are tracked in [#8020](https://github.com/boardsesh/boardsesh/issues/8020),
mobile/Expo web display in [#8021](https://github.com/boardsesh/boardsesh/issues/8021),
and public web display in [#8022](https://github.com/boardsesh/boardsesh/issues/8022). The eventual label is
**Plays**. A play is not proof of illumination, an attempt, or an ascent.

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
rows. It never inserts stats rows or changes grades, ascents, `updated_at`, or
`sync_seq`. Previously positive keys absent from the new aggregate become zero.
Missing stats keys and their play totals are reported; a later hourly pass fills
them once normal catalog or tick writers create the row. No per-report hot-path
work is added.

The schedule is `23 * * * *` in UTC. Scheduled work and manual backfills use the
same `all` singleton key. Retry recomputes from a fresh snapshot, so an interrupted
partially applied pass converges. Alias, history, or board changes after the read
snapshot appear on the next pass. Failed reads abort before writes. Run logs
include measured time, qualifying plays, excluded records, unmatched keys/plays,
planned and changed rows, zeroed rows, and duration.

Deploy the schema and column grants before deploying the new family, as required
by [worker deployment ordering](../backend/background-workers.md#a-new-worker-image-can-start-before-the-migrator-has-run).
Using the existing batch-worker operator environment, first enqueue a read-only
preview, review its totals against an independent read-only query, then enqueue
the same family to backfill. Deploy the new backend with `refresh-climb-plays`
included in `BATCH_FAMILIES_DISABLED` so the hourly schedule cannot write before
this preview. Preserve any other disabled families. Manual operator runs remain
available; after verifying the backfill, remove this family from the disabled
list and redeploy the backend to enable hourly refreshes:

```sh
vp exec tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-plays '{"dryRun":true}'
vp exec tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-plays
```

Verify the stored values at the sampled climbs' angles and confirm the next
hourly run succeeds. The schema default is zero before the first backfill. The
positive-count partial index makes stale-key enumeration avoid scanning every
zero-count catalog row.

Before shipping Plays to clients, coordinate the sync trigger's explicit payload
allowlist with the API, SQLite, snapshot, and refresh-revision changes. Plays-only
updates intentionally do not advance client cursors during this storage-only
rollout.
