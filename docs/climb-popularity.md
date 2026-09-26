# Climb popularity table

The popular sort (`sortBy: 'popular'`) ranks climbs by their ascent count summed over every angle. Before this table, each search computed that sum with a GROUP BY over every `board_climb_stats` row of the board type (420k rows on Kilter) and a hash join over every climb in the layout. In production that averaged 20.2 s and wrote about 2.4 GB of temp files per call. This is change C9 in `docs/postgres-query-costs.md`.

## The tables

`board_climb_popularity` has one row per `board_climb_stats` row: `(board_type, climb_uuid, angle)`.

- `total_ascensionist_count` is the climb's `COALESCE(SUM(ascensionist_count), 0)` over every angle. All rows of one climb carry the same total.
- `display_difficulty` and `ascensionist_count` are copies of the stats row at that angle.
- `board_climb_popularity_rank_idx` is `(board_type, angle, total DESC, climb_uuid DESC, display_difficulty, ascensionist_count)`. The two copies are trailing key columns, because drizzle-kit cannot write `INCLUDE`. A grade band or a minimum-ascents filter is checked inside the index, before any heap or `board_climbs` probe.

`board_climb_popularity_runs` has one row per board: the refresh's `updated_at` high-water mark and `full_built_at`.

Two columns we did not add, on purpose:

- **Not on `board_climbs`.** Its trigger bumps `sync_seq`, so every popularity change would make every device re-pull the climb.
- **Not on `board_climb_stats`.** The total changes when any angle changes, so one tick would rewrite every angle's row and re-sync all of them.

## The refresh

The backend's `climb-popularity-refresh` pg-boss job (`packages/backend/src/services/climb-popularity-refresh.ts`, body in `packages/db/src/queries/climbs/climb-popularity.ts`) runs hourly at :23 UTC. The queue is `exclusive`, so one run is queued or running across all replicas.

- **Full pass:** a board's first run, then weekly. It walks the board's stats rows in chunks of about 20,000, cut on `climb_uuid` so a climb never spans two chunks. `full_built_at` is stamped only after the last chunk.
- **Incremental pass:** every other run. It re-reads the climbs that have a stats row with `updated_at` at or after the last high-water mark minus 1 hour, through `board_climb_stats_sync_cursor_idx`. The hour covers transactions that commit after they stamp `updated_at`. More than 50,000 touched climbs switches the run to a full pass.
- Every write is an upsert that skips unchanged rows, plus a delete of rows whose stats row is gone. A rerun costs reads, not writes.
- A stats row deleted from a climb nobody else touched is only noticed by the weekly full pass. Until then it affects only that climb's rank, never whether it shows, because the search re-checks the live stats row.
- A run stops starting new statements after 25 minutes, under the queue's 30-minute expiry. A stopped full pass is started again by the next run.

Nothing runs on deploy or boot.

## The read path

`searchClimbs` uses the table only when all of these hold. Otherwise it runs the old aggregation.

- The sort is `popular` and descending.
- The search is not cross-angle.
- The board has a `full_built_at`. Each process caches this answer for 60 s. This makes the deploy order safe: the code can ship before the migration's first build finishes.

**The walk:** read `board_climb_popularity_rank_idx` in order at the browsed angle, join the live stats row and the climb by primary key, and stop after one page. The walk runs when:

- the grade filter can be split into its stats-row form;
- the search does not use the climber's own grades or `projectsOnly`;
- it is not routes-only.

**The fallback:** when the walk returns less than a full page plus one, the standard search runs with an ORDER BY that puts the walk's rows first, in the walk's order. Every other row follows by the old total (`NULLS LAST`), then `uuid DESC`. This is the same page-boundary contract as the stats-driven fallback (#1971).

## The one order change

A climb with no stats row at the browsed angle now comes after every climb that has one, whatever its total at other angles. This is the same rule the ascents sort has always used. Before, it ranked by its total from other angles.

Pages whose walk fills them are unchanged. On the production replica, 7 of 7 pages across Kilter, Tension and MoonBoard (page 0, page 5, two grade bands) came back identical, row for row. The difference shows only once a narrow filter exhausts the walk, for example page 3 and later of a Kilter name search. The mobile offline search (`search-climbs-local.ts`) still uses the old order.

## Size

On the dev DB (917k stats rows), measured after `VACUUM ANALYZE`:

| Relation | After the first build | After `REINDEX` |
|---|---|---|
| Heap | 91 MB | 91 MB |
| Primary key | 82 MB | 62 MB |
| `rank_idx` | 154 MB | 92 MB |

Production has 934k stats rows, so expect the same. Only the first pages of the index for each (board, angle) are hot.

## Runbook

- **Force a full rebuild of one board:** `DELETE FROM board_climb_popularity_runs WHERE board_type = 'kilter';`. The search goes back to the aggregation within 60 s, and the next hourly run rebuilds the board.
- **Turn the table off:** the same delete for every board. Then pause the job by unscheduling `climb-popularity-refresh` in pg-boss.
- **Reclaim the index space after the first build:** `REINDEX INDEX CONCURRENTLY board_climb_popularity_rank_idx;`
