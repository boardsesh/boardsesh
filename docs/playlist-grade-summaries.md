# Playlist grade summaries

A playlist card shows the grade spread of its climbs ("V3–V5"), and `discoverPlaylists` can filter community playlists by grade. Both read `playlist_grade_summaries`, one precomputed row per playlist. Issue #6217.

## The table

`playlist_grade_summaries` has one row per playlist with at least one graded climb. The key is `playlist_id`, which cascades from `playlists`.

| Column | Meaning |
|---|---|
| `board_type` | Copy of `playlists.board_type`: the grade scale the ids are on |
| `graded_climb_count` | Climbs that had a grade. Everything below covers only these |
| `min_difficulty`, `max_difficulty` | Easiest and hardest graded climb |
| `p10_difficulty`, `p90_difficulty` | 10th and 90th percentile (`percentile_disc`): the band cards show and the filter checks |
| `median_difficulty` | 50th percentile |
| `updated_at` | Last time a value moved |

Every value is a grade id, `ROUND(display_difficulty)`. That is the number the climb search's grade filter compares (`gradeValueSql`, upstream source), so a playlist band and a climb band mean the same thing. Boardsesh grades and personal grades are not used.

A climb's grade is `board_climb_stats.display_difficulty` at the `playlist_climbs` row's own angle. A row with a NULL angle (Aurora and Kilter circuit syncs) is graded at the climb's most-repeated angle, ties to the lower angle, skipping angles with no grade. Skipping those rows instead would leave most synced circuits with no band at all. A row with an angle that has no stats row stays ungraded; it never falls back.

A playlist with no graded climb has no row. The grade filter leaves it out.

Every playlist gets a summary, private ones too. A summary tells a viewer nothing they could not count by opening the playlist, it is only returned attached to a playlist they can already see, and covering every playlist means making one public needs no recompute.

### Why not columns on `playlists`

`playlists` feeds the offline sync pull through `playlists_sync_cursor_idx` (`updated_at`, `id`). A grade that drifts under an upstream catalog sync would have to bump `updated_at` to be seen, and every device would re-pull a playlist whose name, climbs and colour never changed. See docs/postgres-query-costs.md and docs/climb-popularity.md for the same rule.

## Keeping it fresh

`refreshPlaylistGradeSummariesFor` and `refreshAllPlaylistGradeSummaries` (`packages/db/src/queries/playlists/grade-summaries.ts`) share one write: compute the summaries for a set of playlists, upsert the ones whose values moved (`IS DISTINCT FROM` on every value column), and delete the rows of playlists in the set that no longer have a graded climb. A rerun over unchanged data writes nothing.

- **On a climb change.** `addClimbToPlaylist` (when it actually added the climb) and `removeClimbFromPlaylist` (when it actually removed one) recompute that one playlist after the write commits. A failure is logged and swallowed: the climb change stands, and the daily job repairs the row. Reordering does not change grades and does not recompute.
- **Daily.** The backend's `playlist-grade-summary-refresh` pg-boss job (`packages/backend/src/services/playlist-grade-summary-refresh.ts`) runs at 04:41 UTC. It walks every playlist in id order, 500 per chunk. This catches grade drift from catalog syncs, and circuit syncs and climb deletions that write `playlist_climbs` outside the mutations. The queue is `exclusive`, so one run is queued or running across all replicas. A run stops starting chunks after 25 minutes, under the queue's 30-minute expiry, and logs an error. There is no resume cursor: the next day's run starts again from the first playlist, so a pass that keeps hitting the budget never refreshes the playlists past where it stops. Each chunk reads every climb of its playlists: one primary-key probe of `board_climb_stats` per climb saved with an angle, and a scan of every angle of the climb for one saved without, so the pass is expected to take minutes; if that error shows up, add a cursor the way `board_climb_popularity_runs` keeps one.
- **Racing a mutation.** A mutation can recompute a playlist between the job reading its climbs and the job writing, and the job's answer is then the older one. So each chunk reads the database clock before it computes, and leaves alone (no update, no delete) any row whose `updated_at` is not older than that. The mutations write without that guard. One case it cannot see: a mutation that removes a playlist's last graded climb deletes the row, so there is no newer `updated_at` to find, and the job can write back the band it computed before the removal. That playlist then shows its old band, and passes grade filters, until the next day's run deletes the row. A playlist deleted mid-chunk fails that chunk's insert on the foreign key; the chunk is redone once without it.
- **The first backfill.** The migration only creates the table. When the backend registers the job and finds the table empty, it also queues one run straight away. Once any row exists nothing runs on boot. The backfill is the same chunked, budgeted job, never a statement inside the migration.

## The read path

`discoverPlaylists` and `searchPlaylists` LEFT JOIN the table on its primary key, so the join never multiplies rows, and return the row as `DiscoverablePlaylist.gradeSummary` (null without one).

`discoverPlaylists` takes three more inputs:

- `minGrade` keeps a playlist whose `p10_difficulty >= minGrade`.
- `maxGrade` keeps a playlist whose `p90_difficulty <= maxGrade`. So one V10 does not keep a V3 list out of a V3–V5 search, and one warm-up does not let a hard list into it. An inverted band is a validation error.
- `followedOnly` keeps playlists whose owner the signed-in viewer follows (`user_follows`), resolved in the query. The client never sends the list. Signed out, the answer is an empty page, not an error.

Both bounds sit in the WHERE, before the size band's HAVING, so `totalCount` counts the same rows the pages show.

## Runbook

- **Recompute everything now:** `DELETE FROM playlist_grade_summaries;` then restart one backend. Registration sees the empty table and queues a run. Cards show no band until it finishes.
- **Turn the job off:** `DELETE FROM pgboss.schedule WHERE name = 'playlist-grade-summary-refresh';`. Every boot schedules it again, so to keep it off across restarts revert the registration in `packages/backend/src/index.ts`. Mutations keep their own rows fresh either way.
