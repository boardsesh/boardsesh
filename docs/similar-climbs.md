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

One job body, `runRefreshClimbNeighbors` in
`packages/db/src/jobs/refresh-climb-neighbors.ts` (`@boardsesh/db/jobs`), with
two callers:

- **Today's owner: the workflow.** `.github/workflows/refresh-climb-neighbors.yml`
  runs the CLI `packages/db/scripts/refresh-climb-neighbors.ts` at 06:45 UTC
  against Production, one matrix job per board (every board but spray, pinned
  to `CLIMB_NEIGHBOR_BOARDS` by `climb-neighbors-workflow.test.ts`). Each job
  has a 350-minute timeout, 4 GB of heap and its own concurrency group, so a
  newer run never cancels a running build. GitHub keeps only one pending job
  per group, so at most one run waits behind a long build (a later one
  replaces it). A dispatch picks one board or `all` from a fixed list. Run
  locally over several boards, the CLI takes the cheapest boards first.
- **Next owner: the `refresh-climb-neighbors` batch family**
  (`packages/backend/src/workers/families/refresh-climb-neighbors.ts`,
  docs/background-workers.md "Batch families"). Its `nightly` schedule
  (`45 6 * * *` UTC, pinned to the workflow's cron by
  `scripts/__tests__/batch-families-cron.test.ts`) fans out one job per board,
  cheapest first (`orderBoardsByClimbCount`), and the batch worker runs them one
  at a time. Payload `{ board, full?, dryRun?, refillGaps? }` (the fan-out
  sets `refillGaps` once per night, true on Sundays UTC; unset means no scan), one dedup key per
  board, a 6-hour lease, two retries. It runs only once
  `BATCH_FAMILIES_ENABLED` names it; the workflow keeps its schedule until the
  cutover PR removes it. **That PR lands the same day the family is enabled**:
  both crons are `45 6 * * *`, and only GitHub's lateness keeps the two runs
  apart (see "Don't run two at once" below).

Every write goes through the caller's `transact`: the CLI's is a plain
transaction, the family's is the worker's attempt fence, so a chunk commits
only while that attempt still owns the run. The job stops between chunks when
its signal aborts (worker shutdown, the lease running out, a lost attempt),
exactly as a cut-off CI job does, and throws `ClimbNeighborsInterruptedError`.
A signal that fires mid-batch surfaces as the fence's AbortError instead. The
family records `INTERRUPTED` for both, pg-boss retries, and the retry resumes
from what was recorded (below).

Scoring is synchronous CPU work, and the worker's heartbeat timer only runs
between awaits, so the job yields to the event loop before every chunk (dry
runs included) and every 500 climbs while an incremental run collects the
lists to rewrite. Each group's log line ends with its longest write batch, and
the board's last line with the closing batch, both in seconds.
The per-board logic lives in `packages/db/src/queries/climbs/climb-neighbors-refresh.ts` so
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

Per board, per comparison group (layout, or layout + wall on Woods), smallest
group first:

1. Delete each work-set climb's own list. A list that names a work-set climb
   (a "displaced" list) is found here but left in place: step 3 rewrites it
   whole in one transaction, so a run stopped in between leaves it complete
   (with a stale entry) and the next run finds it again.
2. Load the group's eligible climbs (`uuid, frames`, parsed with the same
   `parseFramesToHoldEntries` the resolver uses) into an in-memory
   hold → climbs index.
3. Recompute, from scratch, every list that can have changed: the work-set
   climbs, their above-0.5 neighbours (the new climb may now rank in their
   top 25), the displaced lists from step 1, and, on the weekly gap-scan
   run, any list now shorter than when it was written (see below). When more
   than half the group's climbs changed, the whole group is recomputed
   instead. Each chunk of lists is replaced in one transaction.
4. Advance the watermark, once every group on the board is done.

Each group logs climbs processed, rows written and seconds. A group with 5,000 or
more lists to write also logs a progress line every 5,000 climbs: done / total,
rows written, elapsed, climbs per second, and an ETA.

**Resumable full builds.** A full build (a board's first run, or `--full`)
records its state in `board_climb_neighbor_runs` when it starts:
`full_build_started_at` and `full_build_sync_seq`, the watermark it will land on.
The next run finds that state and resumes the same build, whatever flags it was
given:

- A group it finished is in `board_climb_neighbor_group_runs` with
  `completed_at` after the build started. It is skipped whole.
- Inside an unfinished group, a climb whose list already carries
  `computed_at` after the build started was written by an earlier run of this
  build. It is skipped too. A climb with no neighbours writes no rows, so it
  is simply scored again, which costs only CPU.
- When the last group finishes, rows older than the build's start (lists of
  climbs no longer eligible) are deleted. The watermark moves to the pinned
  `full_build_sync_seq` and the build state is cleared.

The watermark lands on the value pinned at the start, not a later one. Climbs
that changed while the build was cut off have a higher `sync_seq`, so the first
incremental run afterwards folds them into lists the build wrote before they
existed.

**How long a full build takes.** Measured against production on 2026-09-25,
every board's first build on a GitHub runner: Kilter 9.5 minutes (layout 1,
294,908 climbs, about 540 a second, 179k rows), MoonBoard 13 minutes
(2.3M rows, 12 a list), Tension 3 minutes, the rest under a minute each. The
heaviest chunk of 1,000 lists, on MoonBoard, took about 4 s with its compute.

The index counts overlaps over typed arrays.
Only the rarest |a| − ⌈0.5·|a|⌉ + 1 holds may admit a candidate; the rest only
add to admitted candidates' counts, and there is no per-candidate intersection.
Measured on the Kilter layout 1 snapshot (294,823 eligible climbs, one group)
on a 12th-gen i9 laptop: about 640 climbs a second, so about 8 minutes of
compute for a full build. The first implementation managed 44 a second, about
110 minutes. A CI runner is slower, and loading the layout plus writing
about 0.6 rows per climb adds a few minutes, so expect well under an hour for a
full Kilter build. Every other board is a fraction of that.

**Lists that lost a row.** One thing removes rows from other climbs' lists
outside the job: a deleted climb, whose rows go with the FK cascade. By the next
run nothing names that climb any more. Each row therefore carries `list_size`,
the length of its list when it was written, and a list whose row count has
dropped below it gets refilled.

Finding those lists means grouping every neighbour row on the board (Kilter: 192k
rows, 20-36 s; MoonBoard: 2.3M rows), so the scan runs **weekly**, on the run
that starts on a Sunday (UTC; for the family, the run fanned out on a Sunday,
retries included), and on any run given `--refill-gaps` or `"refillGaps":true`. A full build
never needs it. Deletes are rare (5 in a day of prod stats), and a list that lost
a row is still correct, one entry short: clients show 10-12 of its 25, so the
cost of waiting is at most a week of one fewer candidate below the fold.

## Edit invalidation

`updateClimb` (`packages/backend/src/graphql/resolvers/climbs/mutations.ts`)
rewrites a climb's `board_climb_holds` when its frames change. In the same
transaction it deletes that climb's **own** `board_climb_neighbors` list, so
until the next run the edited climb shows no similar climbs rather than a list
scored on holds it no longer uses. Its slot in other climbs' lists stays until
the next nightly run: the update bumped `sync_seq`, so the job rewrites each
list it sat in (steps 1 and 3 above). Until
then those lists can still show it, at its pre-edit score, for up to a day.
Deleting those slots in the mutation too would leave each of those lists one
row short, a gap only the weekly scan finds.

## Runbook

The workflow owns the schedule until the cutover PR; the family commands
below work as soon as the batch worker runs this image, enabled or not. Family
runs are enqueued on the batch host with
`node --import tsx packages/backend/src/workers/operator.ts enqueue refresh-climb-neighbors '<payload>'`
(docs/background-workers.md, "Operator runs").

- **First run / new board**: nothing to do, no `--full` needed. A board with no watermark row
  gets a full build on its next run, so the first 06:45 run after the migration
  deploys fills every board. Until then non-admins get an empty list. To fill
  sooner, dispatch the workflow (optionally one `board` at a time), or enqueue
  `{"board":"<board>"}`.
- **Full rebuild**: dispatch with `full` ticked, or enqueue
  `{"board":"kilter","full":true}` (one board per job). It rewrites every
  list, then deletes anything it didn't write (lists of climbs no longer
  eligible). Readers never see an empty gap: each chunk of lists is swapped in
  one transaction.
- **A build was cut off** (timeout, cancel, runner lost, worker restarted): do
  nothing. The next run of that board, nightly, dispatched, or the family's own
  retry, resumes it. To start over instead, clear `full_build_started_at` and
  `full_build_sync_seq` on the board's `board_climb_neighbor_runs` row and run
  with `full`.
- **A family run failed**: its `background_job_runs` row carries the code.
  `INTERRUPTED` means the signal stopped it and a retry resumes; after the last
  retry the next night does. `ATTEMPT_FAILED` is anything else (a database
  error); check the worker log for the board and group it reached.
- **Don't run two at once on one board.** The workflow's per-board
  concurrency group and the family's per-board dedup key each prevent it on
  their own side, not across the two, and both fire at 06:45 UTC: remove the
  workflow's `schedule:` the day the family is enabled, and don't dispatch the
  workflow for a board while its family job runs. What an overlap does:
  - two runs writing the same list: the second writer fails on the list's
    primary key (the family retries; the workflow job goes red);
  - the watermark is never corrupted, but it can move backwards when the
    earlier run finishes last, which only rescores some climbs the next night;
  - a full build overlapping an incremental run: the incremental run's
    closing write clears the build's resume state, and the build's closing
    sweep deletes lists the incremental run rewrote before the build started.
    Those stay empty until their climbs are touched again; `full` on that
    board repairs it.
- **A manual dry run can swallow a night.** A `dryRun` job still queued when
  the 06:45 fan-out runs holds that board's dedup key, so the nightly job
  returns it (`ALREADY_QUEUED`) and the board gets only the dry run that
  night. Enqueue dry runs after the nightly jobs have started.
- **Locally**: `vp run db:refresh-climb-neighbors -- --board=kilter --dry-run`
  (then without `--dry-run`, or with `--full`). Uses `DB_URL` / `DATABASE_URL`
  like the other `packages/db` scripts.
- **Something looks stale**: `--full` (or `"full":true`) for that board is always safe to re-run.
- **Refill short lists now** (after a bulk climb delete, say): run
  `vp run db:refresh-climb-neighbors -- --board=<board> --refill-gaps` against
  the target database, or enqueue `{"board":"<board>","refillGaps":true}`; the
  Sunday run does it on its own.
- **Memory**: the job holds one group's `(uuid, frames)` and hold index in memory
  at a time. The biggest is Kilter layout 1, with about 295k eligible climbs.
  The workflow gives node 4 GB, and so does the batch container
  (`NODE_OPTIONS=--max-old-space-size=4096`). Before the family is enabled
  (#5800), hand-run on the batch VM a Kilter full build to record the
  container's peak RSS, and a MoonBoard full build to record its longest
  write batch against the 50 s heartbeat bound.
- **Check it worked**: the front-door similar strip should load cold in well
  under a second, and `seq_scan` on `board_climb_holds` in `pg_stat_user_tables`
  should stop climbing.

## Rate limits

Two keys, one per path, both per user or per IP (`applyRateLimit`):

- `similar-climbs-index` — **600/min** on the materialised path. One index lookup per call, and every web
  front-door render reaches the backend from the web server's single IP, so a crawler walking climb pages
  puts hundreds of calls a minute through that one key.
- `similar-climbs` — **30/min** on the live Jaccard path (admins only). Unchanged from before the index.
