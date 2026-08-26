# Sitemaps

`/sitemap.xml` is a `<sitemapindex>`, not a `<urlset>` — Next's `MetadataRoute.Sitemap`
cannot express one, so it is a route handler (`packages/web/app/sitemap.xml/route.ts`).
It points at a handful of shard files under `/sitemaps/`, each served by its own route.

Everything below lives in `packages/web/app/lib/seo/sitemap/`.

## The registry

`shard-registry.ts` is the single source of truth. The index and the route files both
read it, so a shard cannot exist in one and not the other — a unit test walks
`app/sitemaps/` on disk in both directions to pin that.

Two kinds of shard:

|                   | fixed (`SHARD_REGISTRY`)                           | paged (`PAGED_SHARD_REGISTRY`)                   |
| ----------------- | -------------------------------------------------- | ------------------------------------------------ |
| members           | `static`, `boards`, `gyms`, `setters`, `playlists` | `climbs` when enabled                            |
| file              | one `/sitemaps/<id>.xml`                           | `/sitemaps/climbs/1.xml … N.xml`                 |
| index asks it for | the whole item list                                | `summary()` only — count + newest timestamp      |
| N comes from      | —                                                  | `ceil(itemCount / urlsPerShard)` at request time |

`N` is derived from the summary on every request, never from the filesystem: Next has
no partial dynamic segments, so a `climbs-1.xml` shape would hardcode today's page
count into the directory tree.

## The climb sitemap switch

Climb sitemap publication is paused by default. It is enabled only when the
server-side environment variable `CLIMB_SITEMAPS_ENABLED` is exactly `true`.
Unset values and variants such as `1` or `TRUE` stay disabled.

Disabled mode has one contract across every entry point:

- `/sitemap.xml` omits every `/sitemaps/climbs/N.xml` entry intentionally. It does
  not read the climb store, name `climbs` in `X-Sitemap-Degraded`, or shorten the
  index cache window.
- Direct `/sitemaps/climbs/*.xml` requests return `410 Gone` with
  `Cache-Control: public, s-maxage=3600, must-revalidate`. The one-hour expiry lets
  a later re-enable become visible without leaving crawler retries uncached.
- `/sitemap.xml` does not schedule the climb-store `after()` refresh.
- An authenticated `/api/internal/refresh-sitemap-climbs` request returns
  `{ "shard": "climbs", "skipped": "disabled" }` without scanning the database.
  Authentication still runs first, so an unauthenticated request remains `401`.

The tables, refresh code, and enabled read behavior remain in place. Set
`CLIMB_SITEMAPS_ENABLED=true` to restore publication; all other sitemap shards are
unaffected by the switch.

## Degrade at the index, fail closed at the shard

The doctrine splits by layer, and the split is deliberate.

- A **shard route** 503s when its builder throws, or when a shard that expects URLs
  builds none. Telling Google those pages no longer exist is worse than telling it to
  retry — a 5xx keeps the last good copy, a short 200 does not.
- The **index** degrades instead. A builder that throws, misses `SHARD_DEADLINE_MS`
  (3 s), comes back unexpectedly empty, or blows the URL budget is logged loudly, its
  `<sitemap>` entry is omitted, and the index still answers 200 with whatever built.

A degraded index gets `s-maxage=60, must-revalidate` instead of the usual hour plus a
day of `stale-while-revalidate`, and names what it dropped in the `X-Sitemap-Degraded`
response header. Sixty seconds keeps "partial beats nothing" without pinning a
cacheable lie at the edge for 25 hours.

The index only 503s when there is nothing left to publish at all.

## The climb store

The climbs shard is the largest surface by two orders of magnitude — roughly 52,000
URLs across six pages — and used to be the one least able to meet the 3 s deadline.
Its summary is two numbers, but the COST of those two numbers was the full
`DISTINCT ON (climb_uuid)` tier-2 scan once per `(board_type, layout_id)` group,
sixteen groups, sequential (concurrent heavy scans against a pool of ten is the #4461
starvation). Measured on the full-board dev image, the largest single group: 16.7 s
cold, 3.8 s warm, 0.95 s fully warm. No cache temperature meets 3 s, so any request
that missed both cache layers dropped every climb URL out of the index for at least a
minute (#4523). The shard pages had the same disease with a worse bill: page N was a
JS slice of the whole ordered list, so a cold `/sitemaps/climbs/N.xml` cost the full
scan plus URL rendering — 51 s in production, once per page on a cold crawl (#4552).

So the answers are stored instead of recomputed, in two tables written by one
refresher inside one transaction:

- **`sitemap_shard_refreshes`** (`packages/db/src/schema/app/sitemap-shard-refreshes.ts`)
  — one row per shard: `shard_id`, `item_count`, `last_modified`, `computed_at`.
  Keyed by shard rather than modelled on climbs, because `playlists` (#4524) has the
  same shape of problem.
- **`sitemap_climb_urls`** (`packages/db/src/schema/app/sitemap-climb-urls.ts`) — the
  rendered tier-2 URL list, one row per submitted URL: `ordinal` (int PK), `path`,
  `last_modified`, `board_type`, `layout_id`. `ordinal` is the 0-based emission order
  (groups in `resolveClimbSitemapGroups` order, then `uuid ASC` within a group), so a
  page is `WHERE ordinal >= start AND ordinal < start + perPage` — measured at 21 ms
  for a 10,000-row range against a 53,000-row stand-in with no index beyond the PK.
- **`climb-store.ts`** — `fetchClimbShardSummary()` reads the summary row (~1 ms) for
  the registry's `summary()`; `buildClimbShardPage()` reads an ordinal range for the
  registry's `buildPage()`; `refreshClimbSitemapStore()` writes both. The summary is
  DERIVED from the built URL rows (count + max `last_modified`), so one set of
  sixteen scans feeds both tables and they can never describe different sets.

The URL table also buys the index a **per-page `<lastmod>`**
(`fetchStoredClimbPageLastmods`, a `max(last_modified)` per ordinal bucket): one
stats update no longer makes all six pages look changed. It is strictly
best-effort — an empty store or a failed aggregate falls back to the shard-wide
value and never degrades the shard.

Both tables are a **cache, not a source of truth**, and are retained while climb
sitemaps are paused. When the switch is enabled, truncating them loses no source
data: the read paths fall back to the live scan they replaced, and the next refresh
repopulates them.

### Read behaviour

| store state         | what happens                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| fresh row           | served — the only path that meets the deadline                                                                              |
| no row              | falls back to `fetchTier2Summary()`, i.e. the old live scan. Correct, but slow enough to lose the shard                     |
| row older than 48 h | still **served**, plus a `console.error`. A sitemap whose `<lastmod>` drifted by a day beats a shard missing from the index |
| read throws         | falls back to the live scan, plus a `console.error`. The realistic cause is the migration not having been applied           |

The page read (`buildClimbShardPage`) follows the same doctrine: an empty
`sitemap_climb_urls` or a read that throws falls back to the live grouped build —
the 51 s path, correct and never worse than before the store existed. There is no
staleness bound on pages; the summary row's 48 h shout covers the store as a whole,
since both tables share one refresh.

### Saying which path served (#4583)

The fallback is correct, and that is exactly the problem: an empty store produces a
complete, correct sitemap, so nothing external goes red while every crawler fetch
behind it pays the scan. The climbs shard was absent from the production index on
every request from the day W-23 landed until #4661, and the reason it stayed there
for weeks is that a degrade only ever reached a `console.error`.

So a fallback names itself, on two channels:

- **`X-Sitemap-Climbs-Source: store | live`** on `/sitemap.xml` and on every
  `/sitemaps/climbs/N.xml`. Set from the `source` the summary and page builds have
  already returned — never a fresh read. That matters: the index races each summary
  against `SHARD_DEADLINE_MS` and `withDeadline` cannot cancel the loser, so a
  diagnostic that issued its own query could outlive the deadline it describes and
  hold the whole index open to `maxDuration`. A rejected or timed-out summary
  reports no source at all rather than guessing, since `X-Sitemap-Degraded` already
  covers that case. On a page the build's own answer wins over the summary's: a
  fresh summary row against an empty URL table is exactly the state the deploy that
  added the store was in.
- **A Sentry event**, from `reportStoreFallback` in `climb-store.ts`, at most once
  per reason per instance per six hours (`summary-empty`, `summary-read-failed`,
  `page-empty`, `page-read-failed`). The page-path event fires _before_ the 51 s
  fallback build, so a Vercel timeout cannot swallow it.

While publication is paused, `scripts/production-smoke.ts` requires this header to
be absent. It also requires the index to omit climb shard URLs and requires a direct
climb shard request to return the cacheable 410. Re-enabling the surface therefore
requires an intentional smoke-test update; changing only an environment variable
cannot silently restore the crawler load.

One honest limit, shared with `X-Sitemap-Degraded`: the header rides a CDN-cached
response. A healthy index is `s-maxage=3600` and the shard pages are
`s-maxage=21600`, and Vercel's edge ignores the smoke's `Cache-Control: no-cache`
request header, so the value read can be up to that old in either direction. It is a
signal that a wedged store gets noticed within the hour, not a live probe. The Sentry
event has no such lag.

### Who refreshes it when enabled

The former six-hour Vercel cron has been removed while publication is paused.
There are two refresh paths when `CLIMB_SITEMAPS_ENABLED=true`:

1. **The `after()` self-heal** on `/sitemap.xml` itself. After the response has
   flushed — so it cannot touch the 3 s deadline or the latency a crawler sees — the
   index kicks a refresh if the summary row is missing or past 48 h, **or if
   `sitemap_climb_urls` is empty**. That last probe matters on the deploy that adds
   the URL table: an older summary row can still be fresh while the new table is
   empty, so a summary-only check would wait for the age threshold while every page
   request took the 51 s fallback. Single-flighted per instance behind a 15-minute floor.
   This keeps the enabled surface scheduler-independent: a missing or old store
   degrades to "healed by the next crawl", not to a permanently broken sitemap.
2. **By hand**, after enabling the switch or a deploy that leaves the store empty:

   ```
   curl --fail-with-body --silent --show-error \
     -H "Authorization: Bearer $CRON_SECRET" \
     https://www.boardsesh.com/api/internal/refresh-sitemap-climbs
   ```

   The `after()` hook fires on the first enabled `/sitemap.xml` request, so the curl
   is not required. It closes the window immediately and reports refusals directly:
   a 409 prints why the refresh was declined and exits non-zero, while the self-heal
   only writes that to the log. While the switch is disabled, the same authenticated
   curl returns `skipped: "disabled"` and performs no scan.

### Railway re-enable runbook

1. In the cutover change, update the production smoke contract from paused/410 to
   enabled/store so that the same deployment verifies the intended state.
2. Set `CLIMB_SITEMAPS_ENABLED=true` and `CRON_SECRET` on the Railway web service,
   then deploy the cutover before starting a scheduler.
3. Run the Node validator command in step 4 once from a shell with both variables
   set. Continue only after it exits zero; it rejects non-200 responses, disabled or
   concurrent skips, invalid JSON, empty results, and timeouts.
4. Create a separate one-shot Railway cron service from this repository. Give it
   `BOARDSESH_WEB_ORIGIN` and a reference to the web service's `CRON_SECRET`, set
   its UTC schedule to `0 */6 * * *`, and use this exact start command:

   ```sh
   node -e 'const origin=process.env.BOARDSESH_WEB_ORIGIN;const secret=process.env.CRON_SECRET;if(!origin||!secret)throw new Error("missing BOARDSESH_WEB_ORIGIN or CRON_SECRET");fetch(new URL("/api/internal/refresh-sitemap-climbs",origin),{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(330000)}).then(async response=>{const body=await response.text();console.log(body);const payload=JSON.parse(body);if(!response.ok||payload.shard!=="climbs"||payload.skipped!==null||!Number.isInteger(payload.itemCount)||payload.itemCount<1)throw new Error(`refresh rejected: HTTP ${response.status}`)}).catch(error=>{console.error(error);process.exitCode=1})'
   ```

   The command exits zero only after a stored, non-empty refresh. It exits non-zero
   on HTTP errors, refusal bodies, missing configuration, invalid JSON, or timeout.
   It must terminate after each run; Railway skips later schedules while an earlier
   cron process remains active. Do not attach this schedule to the web service and
   do not restore the Vercel cron.
5. Verify `/sitemap.xml` includes `/sitemaps/climbs/1.xml` with
   `X-Sitemap-Climbs-Source: store`, then verify that direct shard returns HTTP 200
   XML with the same source header. Confirm the scheduler's next run succeeds before
   removing migration monitoring.

### Refusals, and how to get out of one

The endpoint can skip before or during a refresh. Disabled mode answers 200 before
the refresher runs. Of the four refresher-level cases, two are benign concurrency and
answer 200; two mean the store is frozen and answer **409**.

| `skipped`    | status | meaning                                                                                                                       |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `disabled`   | 200    | the switch is off; no database scan runs                                                                                      |
| `locked`     | 200    | another instance holds the write lock                                                                                         |
| `superseded` | 200    | another instance wrote a newer answer while this one was scanning                                                             |
| `empty`      | 409    | the scan computed 0 climbs. Never stored — a stored zero makes the index drop the shard, which is the bug this table prevents |
| `shrank`     | 409    | the scan computed less than half the stored count                                                                             |

A refusal protects **both** tables: a declined refresh leaves `sitemap_climb_urls`
exactly as it was, so the shrink guard cannot half-apply and strand the pages on a
different catalogue than the summary advertises.

`?force=1` bypasses the shrink guard, and only the shrink guard. Use it when the
catalogue genuinely shrank; without it, a real shrink would make every scheduled run
decline forever while the read path kept serving a frozen count. It never bypasses the
lock and never lets a zero be stored.

### Locking

The sixteen scans run **outside** any transaction — they take tens of seconds, and
holding a pooled connection idle-in-transaction for that long against a pool of ten is
the starvation the sequential loop already exists to avoid. Only the writes are
transactional — the summary upsert plus the URL swap (`DELETE` then re-insert in
chunks of 1,000 rows, because 5 columns × ~52,000 rows in one statement blows
Postgres's 65,535 bind-parameter cap) — and the transaction takes
`pg_try_advisory_xact_lock` as its first statement. One transaction for both tables
is what gives the count the index advertises and the rows the pages serve a single
epoch; MVCC keeps concurrent page reads on the previous rows until the commit.

Transaction-scoped, never session-scoped. `pg_try_advisory_lock` plus a release in a
`finally` is not mutual exclusion on this client: drizzle's `execute()` runs on an
arbitrary pooled connection while `transaction()` reserves a different one, so the
writer would not hold the lock it took and the unlock could land on a connection that
never owned it. Behind PgBouncer transaction-pooling it is worse than useless.
`packages/db/src/schema/app/sync-daemon-leases.ts` documents the same trap at length.

That lock serialises the _write_. Two instances can still _compute_ concurrently; the
`superseded` check means the later finisher writes nothing instead of clobbering a
newer answer.

## The playlists cache

`playlists` is a fixed shard, so the index asks it for the whole item list — one
indexed query for every public playlist holding at least one climb. Uncached, that
ran live on every `force-dynamic` index request. Measured across 12 distinct origin
computations of the production index on 2026-08-19, `playlists` was named in
`X-Sitemap-Degraded` in 4 of them, dropping 10,752 locale-expanded URLs each time
(#4524). The shard route itself measured 1.3–4.3 s per CDN miss.

It gets the boards treatment, not the climbs treatment, and the difference is a size
question. The rows are the whole answer and they are small: 2,688 rows of
`{ uuid, updatedAtIso }` is ~200 KB of JSON, ~840 KB at the hard `MAX_ITEMS_PER_SHARD`
cap, against Vercel's 2 MB Data Cache entry ceiling. The climb item list is >10 MB,
which is the only reason it needed the Postgres-backed store instead. So
playlists caches the answer, which fixes the index _and_ `/sitemaps/playlists.xml`;
a summary would have fixed only the index.

Two layers, in `playlist-query.ts`:

- **Next Data Cache** (`unstable_cache`, 1 hour, tag `sitemap-playlists`) — shared
  across instances, so a cold lambda does not re-run the query.
- **In-process TTL + single-flight** (1 hour) — `unstable_cache` does not dedupe
  concurrent misses, and a crawl burst is the index plus the shard route arriving
  together. Nothing is stored on rejection, so a failure is never memoised.

### Dates do not survive the Data Cache

`unstable_cache` JSON-serialises. A cached `Date` comes back a **string**, and
`renderLastMod` calls `lastModified.toISOString()` on it — a TypeError that 503s
`/sitemaps/playlists.xml` and degrades the index harder than no cache at all. So the
cache stores `updatedAtIso` and the wrapper rehydrates with `new Date(...)`, once per
TTL. A naive `unstable_cache` wrapper makes this bug worse; do not "simplify" that
pair away. The climbs summary has the same pattern for the same reason.

The round trip is lossless without a `to_char`: `playlists.updated_at` is a
`timestamp` holding UTC and comes back through drizzle's timestamp decoder
(`new Date(value + '+0000')`). `climb-query.ts` needs `to_char` only because its raw
`sql` fragment bypasses that decoder.

### Why the warm lives in `after()`

`/sitemap.xml` calls `after(warmPlaylistSitemapCache)`. That is not belt-and-braces —
without it the fix only heals probabilistically.

On a first-population miss, `unstable_cache` registers its cache write in
`workStore.pendingRevalidates` only **after** the callback resolves, while the route
module snapshots `Object.values(workStore.pendingRevalidates)` into `pendingWaitUntil`
at response time. An index that abandoned the query at the 3 s deadline has already
returned, so its eventual write goes into an array nobody is holding and a freezing
Vercel instance can drop it — and the next request misses again. Running the same
fetch inside `after()` puts it under `withExecuteRevalidates`, whose `finally` diffs
the store and awaits writes that appeared while the callbacks ran. The abandoned
query is covered too, because the warm shares its in-flight promise.

The warm returns without touching Postgres when the in-process cache is fresh, and a
persistently failing query is held off by a 60 s per-instance floor rather than
re-running on every crawl hit.

### The statement timeout

The query runs inside an explicit transaction with `SET LOCAL statement_timeout = '15s'`.
`withDeadline` stops _waiting_ at 3 s but does not cancel, so before this an abandoned
query kept a connection out of a pool of ten for as long as it liked.

Fifteen seconds bounds a pathological plan; it is deliberately not tuned to the
index's deadline, because `/sitemaps/playlists.xml` legitimately takes up to ~4 s and
a deadline-tight timeout would break a working URL. A 57014 surfaces as a throw, which
the index already degrades on and the shard route already 503s on.

`SET LOCAL` in a transaction is the only form available: the `DB_STATEMENT_TIMEOUT_MS`
startup parameter is deliberately off because PgBouncer transaction pooling rejects it
and fails every connection (`packages/db/src/client/postgres.ts`, `docs/db-connectivity.md`).

## What is still slow

When enabled, `/sitemaps/climbs/N.xml` is fixed (#4552) — a stored page reads in
milliseconds. What remains slow is the **fallback**: an empty
`sitemap_climb_urls` (a truncation or local dev) still takes the 51 s live build until
the first refresh runs. The self-heal's empty-table probe bounds that window to one
crawl of `/sitemap.xml`; the manual curl closes it immediately. Disabled requests do
not reach either path; they return the cacheable 410.

Fixed shards have **no byte budget**. `shardRouteHandler` checks `MAX_URLS_PER_SHARD`
on the fixed path but never `MAX_SHARD_BYTES` — that guard exists only on the paged
path. `/sitemaps/playlists.xml` already renders 2,326,713 bytes for 2,688 items
(~866 B/item), so it crosses Vercel's 4.5 MB response ceiling at roughly 5,200 items
while `MAX_ITEMS_PER_SHARD` lets it reach 11,250. Tracked separately.

## Operational gotchas

- **After enabling, a deploy that changes climb URL shape needs a manual refresh.**
  `sitemap_climb_urls.path` is rendered at refresh time, so new URL logic keeps
  serving the old shape until the store is stale enough for the self-heal or someone
  runs the curl above. The old URLs still resolve and point at the climb's selected
  canonical angle, so
  this is a staleness window, not an outage.
- **`scripts/production-smoke.ts` pins the paused state.** It fails if climb URLs
  or source headers return, and it requires the direct shard's cacheable 410. The
  Railway cutover must update that contract alongside the environment switch.
