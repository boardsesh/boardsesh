# Postgres query costs under the 4 GB cap

This is the reference for what our Postgres queries cost and which changes cut that cost. Production Postgres runs under a 4 GB memory cap with 1,024 MiB of shared_buffers. Every number here comes from the September 2026 query-cost audit. Before you add a query, index or job that touches a large table, read the section for that area.

Each number carries a tag that says where it came from. The tags are explained in [How this was measured](#how-this-was-measured).

- **(P)** measured on production
- **(R)** measured on the replica
- **(E)** estimated

## Summary

- **Quiet-day load:** 15,727 s of query time in the 15.3 h window (P), or about 24,700 s/day (E).
- **Savings:** the 15 changes below remove about **9,000 s/day on a quiet day, roughly 36% (E)**. Days with several deploys save more, because each popular-configs stampede costs about 10,000 s (P).
- **Memory:**
  - Dropped: about 1.33 GB of indexes (P, from sizes) and 279 MB of dead heap (P).
  - Added: at most about 100 MB (E).
  - Net: about −1.6 GB on disk (E).
- **Offline-only:** moving reads onto the device helps only three families much: stats history, recommendation counts and followed-setter counts. See [Offline-only candidates](#offline-only-candidates).

## Known recurring jobs that rewrote data

Two scheduled jobs rewrote large amounts of data on every run without changing it. Check both before changing their schedules or steps.

1. **`refresh-content-model.yml` (Sundays 05:30 UTC):** its similarity step rebuilds `board_climb_similar`, and nothing reads that table. Remove the similarity step and keep the embeddings step.
2. **`refresh-moonboard-wide-angle-estimates.yml` (Mondays 08:30 UTC):** rewrites 2.89M grade rows (P) each run. Every MoonBoard device then re-pulls about 1.2M rows (E). The job needs a no-op diff so it writes only rows that changed. Pause the cron until it has one.

The rule for any sync or batch job: a write that changes nothing still costs WAL, and on offline-synced tables it bumps `sync_seq`, which makes every device re-pull the row. Skip unchanged rows with `IS DISTINCT FROM` or a `setWhere` over the SET columns.

## Ranked changes

Change IDs (C#) match the audit findings. Rows are in rank order.

| Rank | C# | Change | Saved per day | Memory (MB) | Effort | Migr. | Risk | Replica verdict | Offline-only? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C1 | Popular configs: no cache DEL on boot, one scheduled refresh, `required_set_ids <@` rewrite | 2,000–12,000 (E, deploy-dependent) | 0 | S–M | No | Low | speed confirmed; "0 mismatches" refuted | No (a CDN JSON option exists) |
| 2 | C2 | searchClimbs stats path: split the grade filter, join grades after LIMIT | 2,500–4,000 (E) | 0 | S | No | Med | weaker; rare-band regression | Partial, already local-first |
| 3 | C3 | climbStatsHistory reads current board_climb_stats | 1,560–1,915 (E) | 0 (2.7 GB leaves the working set) | S | No | Low | confirmed | Yes, data on device |
| 4 | C4 | Runaway guards: connection check, keepalives, per-service statement timeout, logging | caps tails ≥4,666 s per 16.2 h over 30 s (P) | 0 | S | No | Med | not re-tested | No |
| 5 | C5 | Kilter catalog sync: skip unchanged stats rows, load self-aliases once, guard upserts, unnest | 600–1,700 (E) + about 1.9 GB WAL/day (E) | 0 | M | No | Med | stats half stronger; alias half smaller | No (it also cuts offline pulls) |
| 6 | C6 | Recommendation counts: Redis cache, plus a CTE for misses on CROWD/AT_LEVEL only | 900–1,050 (E) | 0 | S | No | Low | weaker (HIDDEN_GEMS regresses) | Partial: the count can go local |
| 7 | C9 | Popular sort: popularity side table with covering columns (Redis page cache first) | 600 (quiet) to 7,100 (contended) (E) | +65–130 (E) | M | Yes | Med | confirmed | Partial, already local |
| 8 | C7 | Drop dead/duplicate indexes and the unused board_climb_similar | 150–350 (E) + write churn | −1,327 idx, −279 heap (P) | S | Yes | Low–Med | not re-tested | No |
| 9 | C14 | Job trims: setter sitemap, snapshot export, grade backtest, neighbour gap scan, communityStats | 400–700 (E) | 0 | S–M | No | Low | not re-tested | No |
| 10 | C13 | Web climb page: climb row first, alias lookup only on miss/unlisted | 350–375 (E) | 0 | S | No | Low | confirmed, bigger | No |
| 11 | C12 | Followed-setter counts: early return on no follows, bind arrays | about 315 (E) | 0 | S | No | Low | confirmed, bigger | Yes, already local-first |
| 12 | C8 | Discovery rail: cache the top-40 ranking, re-check visibility per request | 280–305 (E) | 0 | S | No | Low | confirmed, smaller | No |
| 13 | C10 | You page: conditional userTicks joins, stop refetch on tick/resume | 200–500 (E) | 0 | S | No | Low | join trim confirmed | Yes, needs new data (L) |
| 14 | C11 | Similar-climbs read: Redis on the limit-25 answer | 200–500 (E) | 0 | S | No | Low | not re-tested | Already local on mobile |
| 15 | C15 | Memory budget: parallel workers 0, smaller pools, pg-boss intervals | ceiling; wait time 500–700 (E) | −270 steady, −500 worst (E) | S | No | Low–Med | not re-tested | No |

## Details per change

### C1. Popular configs

- **What:** remove `publisher.del(REDIS_CACHE_KEY)` and the warm-up on boot. A pg-boss cron job computes the value daily and SETs it over the old one, under a cross-replica lock of at least 600 s. On a miss, readers get the stale value or `[]` and never run the SQL. Apply the same no-DEL fix to `warmRecentBetaLinksCache`.
- **Why:** 24 calls, 13,164 s, 548 s mean, 62M blocks read (P). Each deploy starts one copy per replica. Six ran at once (P).
- **Rewrite, measured:**
  - tension 10/8: 10,131 → 366 ms cold, 978 → 351 ms warm, 947k → 114k buffers (R).
  - kilter 8/24: 9,142 → 226 ms cold, 524 → 172 ms warm (R).
  - grasshopper 1/5: 611 → 233 ms (R).
  - Buffers fall about 8×. Cold time falls 25–40×, because the old query reads about 16k blocks per config (R).
- **Whole run:** the heaviest config (kilter 1/10, 283k climbs) takes 3.0 s with the rewrite: 1.22M buffers, mostly board_climb_stats PK probes, plus a 22.6 MB sort spill (R). All 47 configs take about 30 s (E). The old query on that config would exceed 25 s (E).
- **Results change (R):** the rewrite follows frames. The old query follows stale or junk holds rows.
  - tension 10/8: +31 climbs. 30 have a junk `hold_id=0` row.
  - kilter 8/24: −163 climbs, +1. The 163 have zero holds rows but need set 27.
  - grasshopper: identical.
  - Counts shift by up to about 2% per config, and every shift is a correction.
- **Where:** `packages/backend/src/graphql/resolvers/social/boards.ts:805-807, 849-865, 978-990, 1040-1070`; `server.ts:806`.
- **Caveats:**
  - Keep `totalAscents` as an Int.
  - Exclude `required_set_ids` NULL.
  - Diff all 47 rows and accept the corrections.
  - Update `popular-configs-stampede.test.ts`.

### C2. searchClimbs stats-driven path

- **What:** split the filter into `ROUND(s.display_difficulty) <op> …` OR (`display_difficulty IS NULL AND EXISTS(grades in band)`), for BETWEEN, `>=` and `<=`. Join `board_climb_grades` after LIMIT/OFFSET. Keep COALESCE for `gradeSource='boardsesh'` and personal grades. Add no enable_* settings.
- **Measured:**
  - Homewall: reads 9,911 → 274, cold 4.7 → 0.38 s, warm 237 → 178 ms (R).
  - MoonBoard L3: reads 30,061 → 9,846 (−67%), hits 309k → 163k, cold 14.7 → 4.9 s, warm 553 → 311 ms (R). The EXISTS fallback runs 3,002 times (R).
  - Kilter L1 band 22–24: the plan flips to an index walk, 1.5 s → 2 ms warm, 587k → 516 buffers, 90 MB temp → 0 (R).
  - **Regression, Kilter L1 rare band 31–33:** 283k stats-PK probes, 587k → 1.0M hits, 1.54 → 1.99 s warm (R). It spills no temp and never touches the 1.3 GB grades table, so it may still win on prod's 1 GB cache (not measured).
- **Rows:** identical, same order, on 3 configs. MoonBoard unlimited: 6,776 = 6,776 (R).
- **Sizing:** the family is 5,295 s in the window (P), about 8,300 s/day (E). MoonBoard is 60% of it and gains the least, so savings are 2,500–4,000 s/day (E).
- **Where:** `packages/db/src/queries/climbs/search-climbs.ts:352-472`, `create-climb-filters.ts:334-345, 547-558`.
- **Caveats:** add a test or guard for narrow bands on big layouts. Test NULL `display_difficulty` with a grades row. Pair the implementation with a reviewer.

### C3. climbStatsHistory

- **What:** select current `board_climb_stats` rows with `ascensionist_count > 0`, map `updated_at` to `createdAt`, and keep the spray visibility check. Give it its own rate-limit bucket. Delete the dead web `climb-analytics.tsx`.
- **Measured:**
  - Top Kilter climb: 2,860 ms cold / 15,730 reads → 1.25 ms / 18 buffers (R).
  - Median climb: 16.5 → 1.8 ms cold (R).
  - Prod: 1,787 reads per call, 6.04M blocks over 3,380 calls (P), about 5,300 calls/day (E).
  - The 79 s prod max was contention. A clean cold run is 2.9 s (R).
- **Output:** fresher, not identical. On the top climb 12 of 15 angles differ, up to +105 ascents, because the newest snapshot lags live stats by about a day (R).
- **Where:** `packages/backend/src/graphql/resolvers/climbs/queries.ts:583-631`.
- **Caveats:**
  - Angles whose count fell to 0 disappear.
  - Angles with NULL difficulty lose their bar (0.9% of kilter rows (P)).
  - Planning, 3–8 ms (R), now takes longer than execution. Skipping the spray subquery for non-spray boards is a later small win.

### C4. Runaway guards

- **What:** set `client_connection_check_interval=5s`, keepalives 60/10/3, `track_io_timing=on`, `log_lock_waits=on` and `log_temp_files=10MB` (#5811). After C1 ships, set `DB_STATEMENT_TIMEOUT_MS=30000–60000` on backend and web only.
- **Why:** no statement timeout exists. Orphaned queries ran for over 30 min (P). 98 calls with a mean over 30 s used ≥4,666 s beyond 30 s in 16.2 h (P).
- **Caveats:**
  - Never `ALTER ROLE boardsesh_runtime`: kilter-sync's 80–135 s upserts (P) would fail.
  - A timeout before C1 leaves the popular-configs rail empty.
  - Set `temp_file_limit` only after C9.

### C5. Kilter catalog sync

- **Stats upsert:** `setWhere` over every SET column, plus a 24 h `upstream_synced_at` re-stamp clause if open question 2 says it is needed. The last pass re-stamped 399,189 rows, and at most 763 changed (≤0.19%) (R). Over 26 h, 98.5% were no-ops (R).
- **Self-aliases:** load every kilter self-alias once per run: 77 ms, 21.8k buffers (R). The old per-layout join costs about 1.69M buffers on every layout (R).
  - Do not use `ANY($uuids)` for layout 1. It takes 1.09 s, plus 263 ms planning and a 12.9 MB bind (R).
  - In the window this query had 12 calls, 1.9 s mean and 6.8 s max (P), so it is only 35–130 s/day (E).
- **Also:** alias upsert skip, wall-source `IS DISTINCT FROM` with `is_listed`, unnest batches (852 queryids become 1), user-sync touched keys, and self-heal watermark slack.
- **Offline side effect:** every no-op rewrite bumps `sync_seq`, so each device holding the layout re-pulls those rows. This fix shrinks the offline-sync-pull family too.
- **Where:** `packages/kilter-sync/src/sync/catalog-sync.ts:492, 579-617, 786, 1032-1103`, `stats-repair.ts:314-354`, `locations-sync.ts:193-213`.

### C6. Recommendation counts

- **What:** cache the user-independent count in Redis for 6–24 h under `rec-count:v1:{type}:{board}:{layout}:{size}:{sets}:{angle}[:{band}]`. On a miss, use the `MATERIALIZED` stats CTE for **CROWD and AT_LEVEL only**. Leave HIDDEN_GEMS as it is.
- **Measured:**
  - CROWD, top kilter config: 50,156 → 4,974 buffers, 485 → 17 ms warm (R).
  - CROWD, tension: 228k → 52k buffers, 462 → 184 ms (R).
  - AT_LEVEL: 4–16× faster (R).
  - HIDDEN_GEMS: gets worse, from 18.5k to 46.5k buffers and 68 to 405 ms (R).
  - Counts identical in 9 of 9 cases (R).
- **Why the cache matters most:** for heavy tickers the per-user ticks NOT EXISTS is 31k of the 52k buffers (R), and only a user-agnostic key removes it.
- **Where:** `recommendation-query.ts:34-146`, `smart-playlists.ts:506-513`. `useSmartPlaylistCounts` is live (Discover `index.tsx:163`). Keep the hero count exact.

### C9. Popular sort

- **What:** a `board_climb_popularity` side table per angle, with covering `display_difficulty` and `ascensionist_count`, indexed on `(board_type, angle, total DESC, climb_uuid DESC)` and refreshed incrementally. Ship a 10 min Redis page cache first.
- **Measured:**
  - Baseline: 1.6–2.7 s, 460k buffers, about 91 MB temp. The most common shape: 2.9–3.9 s, 1.36M buffers (R).
  - Prod: 20.2 s mean, 2.27M reads, about 2.4 GB temp per call (P). The replica does not reproduce this.
  - Side-table simulation: 2.3–2.5 ms, about 410 buffers, rows identical (R).
  - Hard band without covering columns: 1.09 s and 276k buffers (R). With them: 2.4 ms (R).
- **Not measured:** refresh cost, climbs with no stats row, deep OFFSET pages.
- **Caveats:** never add a column to `board_climbs`, because the sync trigger bumps `sync_seq`. Pair it with an OFFSET cap.

### C7. Index and table drops

- **Drop:**
  - stats v1 covering indexes (470 MB (P); they are prefixes of v2);
  - `board_climb_neighbors_rank_idx` (256 MB (P));
  - the small unused indexes from the audit findings and `boardsesh_ticks_sync_pending_idx`;
  - `board_climb_similar` (763 MB (P), 0 scans; owner approval needed).
- **Declare** `board_climbs_layout_filter_idx` IF NOT EXISTS (557k scans (P)).
- **Caveats:** use `SET LOCAL lock_timeout='3s'` with retry. Keep the similar-table CREATE in the moonboard-dedup fixture.

### C14. Job trims

- **Sitemap:** Redis-shared setter list, MoonBoard EXISTS gate, `item_count` from `sitemap_shard_refreshes`. 145–355 s/day (E).
- **Snapshot export:** in-stream watermark, about 78 s/day and 9.8M reads/day (E).
- **Grade job:** skip an unchanged backtest, or use a hash join (3.2M → 248k reads (P)). Add a keyset cursor.
- **Neighbour job:** `updateClimb` deletes only its own list, and the gap scan runs weekly. Since #5770 this job serves only web and old binaries.
- **communityStats:** 1 h Redis plus a 21,600 s revalidate. 110–170 s/day (E).

### C13. Web climb page

- **What:** select the climb row first with `is_listed`. Look up an alias only on a miss or an unlisted row.
- **Measured:**
  - 200 renders: 148.8 → 7.4 ms cold, with all 240 reads gone (R).
  - 0 of 400 sampled listed climbs needed an alias (R).
  - The alias statement cost 239 s in the window (P), about 375 s/day (E), and nearly all of it goes.
- **Caveats:**
  - 4 listed kilter self-rows need explicit handling (R).
  - 9,596 unlisted MoonBoard husks must route to the alias lookup (R).
  - Also fix the real bug: stats, similar, beta and cache tags are keyed on the unresolved uuid.

### C12. Followed-setter counts

- **What:** resolve the follow lists in JS. If they are empty, return `[]`. Otherwise bind `setter_username = ANY($1) OR user_id = ANY($2)`.
- **Measured:**
  - Before: 320–460 ms warm and 40k buffers, even with 0 rows (R).
  - After, with follows: 48.7 ms warm and 541 buffers, rows identical (R).
  - After, empty list: no query.
- **Sizing:** 708 calls and 207 s in the window (P), about 325 s/day (E).
- **Follow-up:** 45 of the 48 ms is a `required_set_ids` GIN BitmapAnd. The useful work is about 3 ms (R).
- **Caveats:** keep the correlated form for the crew feed. No `is_draft=false` inside the user_id arm.

### C8. Board-discovery rail

- **What:** cache the LIMIT 40 result for 10–15 min under `board-discovery:v1:{gymUuid|all}`, behind singleFlight. Re-check visibility and the spray EXISTS per request.
- **Measured:**
  - Before: 160 ms warm, 62k buffers (R).
  - Re-check: 0.7–1 ms, 182 buffers, rows identical (R).
- **Sizing:** 1,059 calls and 205.9 s in the window (P), about 323 s/day (E).

### C10. You page

- **userTicks:** join grades and ratings only when the selection asks for them. Buffers fall 30,013 → 19,687 (−34%), executor time about 104 → 65 ms, planning 22 → 6 ms, rows identical (R). The ratings join is a full 629-page seq scan on every call (R). The join trim is worth 50–90 s/day (E).
- **Refetch:** `refetchType:'none'` on tick invalidations, `refetchOnWindowFocus:false`, `staleTime` 30 min, and the invalidate keys fixed. The database effect was not measurable.

### C11. Similar-climbs read

Redis plus singleFlight around `getMaterializedSimilarClimbs`. Fetch 25 and slice. TTL at most 1 h. Mobile is already local-only (#5770), so the remaining load is www SSR, admins and old binaries.

### C15. Memory budget

- Run `serial-plan-default.ts` with `ADMIN_DATABASE_URL`. The repo contract is 0 parallel workers per gather and the live value was 2 (P).
- After C1: backend pool 4–5, pg-boss 2, web 4, homelab daemons 3.
- pg-boss: `flowIntervalSeconds 3600`, `cronMonitorIntervalSeconds 45`, `monitorIntervalSeconds ≤120`.
- Lower `max_connections` to 60 last.

## Offline-only candidates

Every move here is JS-only and ships by OTA from `main`. New data must go in a side artifact, not the main per-layout artifact, because shipped binaries reject unknown tables. Downloads are opt-in (`autoOfflineBoards=false`). The share of users with downloads is unknown. Measure it with `Offline Board Download Completed` against native DAU. The Expo browser app and www have no SQLite.

| Move | What moves | Native users without a download, and browser-app users, lose | Server s/day |
|---|---|---|---|
| C3 stats history → local | Register `CLIMB_STATS_HISTORY` in `offlineAwareRequest`. Resolve from local `board_climb_stats`. Switch `useClimbStatsHistory` (hooks/index.ts:1405) off `getHttpClient`. | Local-only: angle badges. Local-first plus C3: nothing. | Local-only 1,560–1,915 (E) |
| C6 recommendation count → local | COUNT from local board_climbs, stats and ticks behind `useSmartPlaylistCounts`. The ranked list stays on the server: it needs setter_score and send_count_30d. | Local-only: Discover card counts. | Local-only 900–1,050 (E) |
| C12 setter counts local-only | Already local-first (offline-request.ts:208). Set `networkPolicy: 'local-only'`. | The "Following" chip. 88% of calls return nothing today (P). | 170–325 (E); C12 gets most of it anyway |
| Search count local-only | `useSearchClimbsCount` returns null when it cannot serve locally. | The "Show N climbs" preview, probably for most users. | 182–300 (E) |
| Hold-state search local | Lift the `hasHoldState` decline and answer from the device holds index. | Nothing, unless it is made local-only. | 50–640 uncontended (E) |
| Favorites reader | A local `user_favorites` reader for `useFavoriteStatus`. User tables sync without a board download. | Nothing on native. | 10–40 (E) |

- **Already local:** C2 search (local-first), the C9 popular sort, C11 similar climbs. Server load there comes from boards that are not downloaded, the browser app and www. Turning on `autoOfflineBoards`, or prompting a download on first board open over Wi-Fi, would move more of it. How much is unknown.
- **C1 alternative (not offline):** the export job publishes the 47-row ranking as JSON next to the snapshot manifest. Nobody loses anything.
- **C10 (L):** a self-view You page from local ticks needs `layout_id` on local ticks (v11 plus a full re-pull), and it lacks grades for boards that are not downloaded.
- **Cost side:** offline-sync-pull and grade-sync grow with every move above. C5 and the wide-angle no-op diff come first.

## Rejected or weakened

- **C1 "0 mismatches":** refuted (R). The counts correct by up to 2%. Diff and accept.
- **C2 at 3,500–5,500 s/day:** weakened to 2,500–4,000 (E). There is a rare-band regression on big layouts (R).
- **C5 `ANY($uuids)` alias probe:** rejected for large layouts (R). Use load-once. The "6.8 s mean" first reported was the max (P).
- **C6 CTE on HIDDEN_GEMS:** rejected. 2.5× more buffers and 6× slower (R).
- **C8 at 340–650 s/day:** only about 323 s/day exists (P→E).
- **SET LOCAL enable_bitmapscan/enable_sort=off:** rejected. 12 s and 136k buffers on a small MoonBoard layout; 240× worse name search.
- **CREATE STATISTICS for search:** rejected. It cannot fix array-operator misestimates.
- **History covering index (1.5–1.7 GB):** rejected. C3 makes it unnecessary.
- **VACUUM of stats history as a speed fix:** weakened to hygiene only.
- **Dropping the history surrogate PK:** deferred. It saves disk only.
- **Stats REINDEX before C5:** deferred. The holds and grades PK REINDEX is fine.
- **Folding the alias lookup into the climb select:** rejected. It saves only 10–35 s/day.
- **Export or grade reads from the DR standby:** rejected (primary-only rule).
- **Dropping the kilter live-import seq floor:** rejected.
- **eligibleViewers cache:** rejected; it is the revocation guard.
- **Widening boardsesh_ticks_climb_idx:** rejected (+40 MB).
- **Board-stats TTL of 24 h:** weakened to 1–6 h.
- **Similar-climbs K=12:** rejected.
- **Search count local-only:** a product call (see the offline section).
- **`LIMIT 1001` count:** rejected.
- **Hold-state search offline:** deferred (M).
- **Retiring board_climb_holds:** deferred (L).
- **Kilter catalog cooldown:** at most 3–4 h.
- **autovacuum_work_mem:** cosmetic.
- **postgres.js LIFO patch:** low priority.
- **Wide-angle row deletion:** a product call.
- **MoonBoard grade-sync layout index:** rejected.
- **Popular-configs inline aggregate:** rejected (34.9 s (P)).
- **Live Jaccard admin routing:** saves 0; kept as a guard only.

## Order of work

Nothing here is native, so everything ships from `main`. The `totalAscents`, `totalCount` and `climbStatsHistory` shapes stay the same. Migrations use `vp run build:db && vp exec drizzle-kit generate`, and each generated `.sql` is read before commit.

1. **Backend:** C1 (no-DEL, lock, pg-boss cron, rewrite, 47-row diff) and the `warmRecentBetaLinksCache` fix.
2. **CI and scripts:** drop the similarity step and add the MoonBoard wide-angle no-op diff (see [Known recurring jobs](#known-recurring-jobs-that-rewrote-data)).
3. **Config and env:** C4 settings and serial-plan-default. After step 1: the statement timeout, pools and pg-boss intervals (C15).
4. **packages/db:** C2 with the rare-band test.
5. **Backend resolvers:** C3, C6 (cache plus the CROWD/AT_LEVEL CTE), C8, C11, C12, the communityStats cache and a 6 h board-stats TTL.
6. **kilter-sync:** C5 with load-once self-aliases.
7. **Web:** C13, the sitemap EXISTS gate, summary-row counts, communityStats revalidate.
8. **Mobile JS OTA:** C10 refetch policy and trimmed GET_USER_TICKS, local-first C3, favorites reader. Optional local-only moves wait on open question 4.
9. **Jobs:** C14.
10. **Migration A:** C7 index drops, `board_climbs_layout_filter_idx` IF NOT EXISTS, kilter_recent partial index.
11. **Migration B (after approval):** DROP TABLE `board_climb_similar`.
12. **Migration C (M):** the C9 side table, after its Redis page cache ships in step 5.
13. **Later (L):** `layout_id` on stats and grades, a keyset search cursor, the ops-run REINDEX.

## How this was measured

- **Window:** `pg_stat_statements` was reset at 2026-09-25 09:11 UTC and read at about 00:30 UTC on 2026-09-26, a 15.3 h window. Every per-day figure is the window total × 1.57.
- **Restart:** the prod postmaster restarted at 00:08 UTC on 2026-09-26. That was a clean config redeploy, not an out-of-memory kill.
- **(P) production:** totals, call counts, means and block counts from `pg_stat_statements`, plus table and index sizes and scan counts from the catalog. Live timings taken on prod during the audit were noisy, so they are not used as baselines.
- **(R) replica:** the homelab DR standby, PG 18.6, with 2 GB shared_buffers against prod's 1 GB and no other load. Its buffer counts and plan shapes are reliable. Its warm timings are optimistic. Prod planner settings were forced where they change the plan: `random_page_cost=1.1`, `jit=off`, `max_parallel_workers_per_gather=0`. "Cold" means the first run after the relevant pages left the cache; "warm" means a repeat run.
- **(E) estimate:** derived from (P) and (R) numbers, for example a window total scaled to a day, or a replica speedup applied to a prod total.
- **Re-measuring:** reset `pg_stat_statements` on a quiet day after steps 1–5 of the order of work ship, and compare against the numbers here.

## Open questions

1. **Data deletion:** OK to DROP `board_climb_similar` (763 MB)? Is the Climb2Vec blend still planned?
2. **`upstream_synced_at` readers:** do any exist? The answer decides C5's 24 h re-stamp clause.
3. **Staleness:**
   - May recommendation counts include your own sends?
   - Popular rail: up to 24 h stale, with counts corrected by up to 2%?
   - Discovery rail: up to 15 min stale?
4. **Offline-only trade-offs:** hide filter-sheet counts, Discover counts and the Following chip for boards that are not downloaded and for the browser app? Measure the download rate in PostHog first.
5. **C2 rare bands:** accept a slower worst case (1.54 → 1.99 s warm (R)) with no temp and no grades reads, or add a guard?
6. **Stats-history snapshot:** can it become change-only once C3 lands? The `gates.ts` backtest assumes a full weekly cross-section.
7. **Setter sitemap:** does it earn search traffic? If not, removing it saves about 270 s/day (E).
8. **Deploy cadence and replica count:** these set the real size of C1.
9. **Wide-angle grades:** keep materialising all 15 MoonBoard angles?
