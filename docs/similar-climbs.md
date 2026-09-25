# Similar climbs: the materialised neighbour index

"Similar climbs" are climbs on the same layout that share at least half their
holds with the one you're looking at: position-only Jaccard over distinct hold
ids, `shared / (|a| + |b| − shared)`, roles ignored. The play drawer and the web
climb page's similar-climbs strip both ask for it through the `similarClimbs`
GraphQL query.

Scoring that live costs two scans of `board_climb_holds` (5.4M Kilter rows, about
5 s cold), and the web climb pages call it for every crawled climb. So the answer
is now precomputed nightly into `board_climb_neighbors`, and only admins still run
the live query.

## Who gets which path

`similarClimbs` (`packages/backend/src/graphql/resolvers/climbs/queries.ts`)
branches on `hasCatalogQueryAccess(ctx, boardType)`
(`packages/backend/src/graphql/resolvers/social/roles.ts`):

| Caller                                               | Path                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Admin (global, or scoped to the board)               | Live Jaccard CTE (`findSimilarClimbsCached`), unchanged                                     |
| Everyone else, anonymous included (the web front door calls anonymously) | `getMaterializedSimilarClimbs`, one indexed read of `board_climb_neighbors` |
| Non-admin with `frames` and no `climbUuid`           | Rejected: an unsaved hold pattern has no precomputed answer                                 |
| Non-admin on a spray wall                            | `[]`: private walls are never materialised; the app answers them from its local mirror      |

Supporters are meant to join the admin row. That is one change in
`hasCatalogQueryAccess`, and every gated resolver widens with it.

The rate limit (30 requests a minute) applies to both paths.

## What is stored

`board_climb_neighbors` (`packages/db/src/schema/app/climb-neighbors.ts`): for
each listed, published, not hidden, single-frame climb, its top 25 neighbours at
Jaccard ≥ 0.5, with `shared_hold_count`, `target_hold_count`,
`candidate_hold_count`, `jaccard` and `rank`. Neighbours come from the same layout.
On Woods they also come from the same physical wall (its two sizes both number
holds from 0), picked by the climb's stored size (`storedWoodsSizeId`). Both uuid
columns reference `board_climbs.uuid` with `ON DELETE CASCADE`.

- 25 covers the play drawer (12) and the web strip (10).
- 0.5 is the default every caller uses. A request below 0.5 gets the stored
  lists, i.e. the 0.5 answer. The floor is also what makes the job fast: it
  only probes each climb's rarest holds (a prefix filter).

The read path joins each neighbour back to `board_climbs` with the live
predicate (`is_draft = FALSE`, `is_listed IS NOT FALSE`, `is_hidden = FALSE`), so
a climb hidden or unlisted during the day drops out immediately rather than at
the next run. Stats and the grade name are joined at the viewer's angle, as the
live path does. Similarity is recomputed from the integer counts in double
precision, so 7 of 10 holds still passes a 0.7 threshold.

## The nightly job

`packages/db/scripts/refresh-climb-neighbors.ts`, run by
`.github/workflows/refresh-climb-neighbors.yml` at 06:45 UTC against Production.
The logic lives in `packages/db/src/queries/climbs/climb-neighbors-refresh.ts` so
the backend test suite can run it against a real Postgres.

**Watermark.** `board_climb_neighbor_runs` holds one row per board with the highest
`board_climbs.sync_seq` already folded in. The row trigger bumps `sync_seq` on
every real change to a climb (new, edited, hidden, unlisted, re-listed), so
"`sync_seq` above the watermark" is exactly "changed since the last run". The
run bounds its work set by the highest `sync_seq` it saw at the start. A climb
edited mid-run lands in the next run.

The watermark itself only advances past rows whose `updated_at` is over an hour
old. `sync_seq` is assigned when a row is written, not when its transaction
commits, so a transaction still open during the run can hold a lower `sync_seq`
than rows that have already committed. Passing the plain maximum would skip that
row for good. The trigger's `updated_at` is the transaction's start time, so this
is safe for any transaction shorter than an hour. The cost: the last hour's
changes are scored again the next night, which gives the same rows.

Per board, per comparison group (layout, or layout + wall on Woods):

1. Delete every row naming a work-set climb, in either direction.
2. Load the group's eligible climbs (`uuid, frames`, parsed with the same
   `parseFramesToHoldEntries` the resolver uses) into an in-memory
   hold → climbs index.
3. Recompute, from scratch, every list that can have changed: the work-set
   climbs, their above-0.5 neighbours (the new climb may now rank in their
   top 25), the lists that lost a row in step 1, and any list now shorter than
   when it was written (see below). Each chunk of lists is replaced in one transaction.
4. Advance the watermark.

Each group logs climbs processed, rows written and seconds.

**Lists that lost a row.** Two things remove rows outside the job: `updateClimb`
(below), and a deleted climb, whose rows go with the FK cascade. By the next run
nothing names that climb any more. Each row therefore carries `list_size`, the
length of its list when it was written. A list whose row count has dropped below
it gets refilled.

## Edit invalidation

`updateClimb` (`packages/backend/src/graphql/resolvers/climbs/mutations.ts`)
rewrites a climb's `board_climb_holds` when its frames change. In the same
transaction it deletes that climb's `board_climb_neighbors` rows in both
directions. Until the next run, the edited climb shows no similar climbs and
appears in no one else's list, which beats showing a score for holds it no
longer uses. The update bumped `sync_seq`, so the next run re-scores it.

## Runbook

- **First run / new board**: nothing to do, no `--full` needed. A board with no watermark row
  gets a full build on its next run, so the first 06:45 run after the migration
  deploys fills every board. Until then non-admins get an empty list. To fill
  sooner, dispatch the workflow (optionally one `board` at a time).
- **Full rebuild**: dispatch with `full` ticked. It rewrites every list, then
  deletes anything it didn't write (lists of climbs no longer eligible). Readers
  never see an empty gap: each chunk of lists is swapped in one transaction.
- **Locally**: `vp run db:refresh-climb-neighbors -- --board=kilter --dry-run`
  (then without `--dry-run`, or with `--full`). Uses `DB_URL` / `DATABASE_URL`
  like the other `packages/db` scripts.
- **Something looks stale**: `--full` for that board is always safe to re-run.
- **Memory**: the job holds one group's `(uuid, frames)` and hold index in memory
  at a time (the biggest layout is roughly 120k climbs). The workflow gives node
  4 GB.
- **Check it worked**: the front-door similar strip should load cold in well
  under a second, and `seq_scan` on `board_climb_holds` in `pg_stat_user_tables`
  should stop climbing.

## Rate limits

Two keys, one per path, both per user or per IP (`applyRateLimit`):

- `similar-climbs-index` — **600/min** on the materialised path. One index lookup per call, and every web
  front-door render reaches the backend from the web server's single IP, so a crawler walking climb pages
  puts hundreds of calls a minute through that one key.
- `similar-climbs` — **30/min** on the live Jaccard path (admins only). Unchanged from before the index.
