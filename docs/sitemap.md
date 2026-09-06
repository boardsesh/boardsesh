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
| members           | `static`, `boards`, `gyms`, `playlists`            | `setters`, and `climbs` when enabled             |
| file              | one `/sitemaps/<id>.xml`                           | `/sitemaps/<id>/1.xml … N.xml`                   |
| index asks it for | the whole item list                                | `summary()` only — count + newest timestamp      |
| N comes from      | —                                                  | `ceil(itemCount / urlsPerShard)` at request time |

`N` is derived from the summary on every request, never from the filesystem: Next has
no partial dynamic segments, so a `climbs-1.xml` shape would hardcode today's page
count into the directory tree.

`setters` is paged for volume, not for locale expansion: ~108,000 distinct
`(board_type, setter_username)` pairs against `MAX_ITEMS_PER_SHARD`'s 11,250, so
one file cannot hold them at any expansion.

## The climb sitemap switch

Climb sitemaps are **published** (#4648). The surface was paused while www ran on
Vercel, where ~53,000 URLs of crawl drove a render and transfer spike the platform
billed by the invocation; the container on Railway has no per-request ceiling to
buy back, so the pages went out again.

The gate itself stayed, as a kill switch. Publication is on only when the
server-side environment variable `CLIMB_SITEMAPS_ENABLED` is exactly `true`.
Unset values and variants such as `1` or `TRUE` read as off. `Dockerfile.web`
bakes `ENV CLIMB_SITEMAPS_ENABLED=true` into the runner stage, so the deployed
default lives in the repository; a Railway service variable overrides an image
`ENV`, so setting it to anything else on the web service and redeploying
withdraws the whole surface with no code change and no image rebuild.

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

The tables, refresh code, and enabled read behavior remain in place either way,
and all other sitemap shards are unaffected by the switch. Turning it off and back
on costs nothing but a redeploy: the store is a cache, and the `after()` self-heal
below repopulates it on the first crawl.

## Where board configurations come from

Two shards need the list of board configurations to build URLs from, and they do
**not** ask the same question. `board-config-source.ts` is the seam.

`getAllBoardConfigsOrThrow` (`server-popular-configs.ts`) answers _which board
pages are worth building_. It reads `popularBoardConfigs` from the backend, which
builds its universe with a `GROUP BY` over `board_product_sizes_layouts_sets` —
the Aurora sync tables. That is the right universe for the home rail and the
mobile board picker, and it is why MoonBoard was in no sitemap for so long:
nothing writes a psls row for MoonBoard. The only writers are the Aurora
importers and no migration seeds one, so MoonBoard was never ranked out — it was
never a candidate.

The sitemap's question is _which climbs are worth indexing_, and MoonBoard is the
largest board in the addressable set. Its configuration is not in the database at
all; it is the static `MOONBOARD_LAYOUTS` / `MOONBOARD_SETS` tables that
`getDefaultRenderBoard` already resolves for every renderer we ship. So
`board-config-source.ts` synthesises one `PopularBoardConfig` per MoonBoard
layout that has listed, non-draft climbs, and appends them to the listed configs
— rather than changing what `popularBoardConfigs` returns, which would couple a
backend deploy to a sitemap change and move the board picker underneath it.

The synthetic configs carry `boardCount: 0` and `totalAscents: 0`, which is
honest (there is no `user_boards` row shape behind them) and nothing more. It
does not hold them last in any ordering: `isBetterConfig` only ranks candidates
within one `boardType:layoutId` group, so the source is additive in **content**
and not in **ordinal** — see "Adding a board also moves `ordinal`" below. The
`climbCount` is a plain grouped count over `board_climbs`, **not** the tier-2
`DISTINCT ON` scan: both shards read that number only as a `> 0` gate, so making
the boards shard pay the climbs shard's cost budget for a boolean would be the
wrong trade.

### Two callers, two fail policies

|                                   | caller                 | on a MoonBoard count failure    |
| --------------------------------- | ---------------------- | ------------------------------- |
| `getSitemapClimbConfigsOrThrow()` | the climb shards       | **throws**                      |
| `getBoardsShardConfigsOrThrow()`  | `/sitemaps/boards.xml` | logs, serves the listed configs |

The strict one has to be strict. The climbs shard resolves its groups twice per
crawl — once for the summary the index sizes pages from, once for the item build
— and `pagedShardRouteHandler` throws "cache epochs disagree" the moment those two
see different group sets. A tolerated failure there is worse than a 503.

The tolerant one has no second builder to disagree with, and the arithmetic is
lopsided: MoonBoard contributes 8 of `boards.xml`'s 668 items on the dev image
against the listed configs' 660. Before this module existed no database failure
could reach that shard at all — it was a GraphQL fetch behind a backend Redis
cache with a one-year TTL — so 503ing 660 working Kilter/Tension/Decoy URLs
because a grouped count timed out would be a regression bought with nothing. A
failed **listed** fetch still throws on both paths: that is the leg whose loss
would tell Google the boards were deleted.

The count query carries a 10 s budget applied _inside_ the shared single-flight
promise, so a give-up is not memoised and the next caller retries instead of
joining a stall that already gave up. Nothing else bounds it: the pool sets
`connect_timeout: 30` and `statement_timeout` is off by default (PgBouncer
rejects it as a startup parameter — see `docs/db-connectivity.md`).

### The refresher is the only door

Since the climb store landed, adding a board to the sitemap means adding it to
`buildAllTier2UrlRows()`, and nowhere else is sufficient. The shard pages do not
build anything: they read `sitemap_climb_urls`, and that table is written by one
refresher whose only selection entry point is that function. A config that
reaches `/sitemaps/boards.xml` and the live summary fallback but not the
refresher produces a store that has never heard of the board and a shard that
emits nothing new — a change that looks complete in review and ships a no-op.
`__tests__/moonboard-reaches-the-store.test.ts` exists to red exactly that
half-done edit.

Adding a board also moves `ordinal`, because `resolveClimbSitemapGroups` orders
by board type rather than appending — the sort is a plain lexicographic compare
on `boardType`, so `moonboard` landed between `kilter` and `soill` rather than on
the end. On the dev image that pushed 15,032 Soill/Tension/Touchstone URLs from
pages 3–5 onto pages 8–9. That is a catalogue change, which is what `ordinal` is
allowed to move for; each page stays self-contained and its `<lastmod>` is
recomputed from the rows it actually holds. A board type that must NOT move the
existing ordinals needs an explicit rank in that sort — `boardCount` and
`isBetterConfig` cannot deliver it, since neither is consulted across groups.

## One rule picks the published angle

The angle is a path segment (`/{board}/{layout}/{size}/{sets}/{angle}/view/…`),
so two builders that pick different angles for the same climb publish two URLs
for one page. `published-angle.ts` is the single rule, and both callers build
their query from it: the climbs shard (`climb-query.ts`) and the setter front
door (`server-setter-data.ts`).

It shipped as two hand-written `ORDER BY`s and they disagreed on 28 tier-2
climbs — every one a setter row linking to a URL the shard never submitted.
After the change, 0 of 85,596 disagree, pinned by a byte-comparison of the two
real builders' rendered SQL in `server-setter-data.test.ts`.

Two parts are easy to get wrong:

- **`publishableAngles` reads `getRoutableBoardAngles`, not `ANGLES`.** `ANGLES`
  is the picker — 5-degree steps, and only 25° and 40° on MoonBoard — while the
  write contracts accept every integer 0-90 and `parseBoardAngleSegment`
  resolves all of them. Picking from `ANGLES` refuses to publish pages that
  exist. Grasshopper additionally carries -5°, which is a real URL there and a
  404 on every other board, so the setter-side guard is a `CASE` over the row's
  own `board_type`.
- **`nulls last` on the ascent count** is load-bearing on the setter side and a
  no-op on the shard side (which already filters `ascensionist_count >= 10`).
  Postgres sorts NULLs first under a bare `DESC`, which would hand a climb the
  angle of a stats row recording no ascents at all.

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

Both tables are a **cache, not a source of truth**, and are retained even when the
switch is off. Truncating them loses no source data: the read paths fall back to the
live scan they replaced, and the next refresh repopulates them.

### Read behaviour

| store state         | what happens                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| fresh row           | served — the only path that meets the deadline                                                                              |
| no row              | falls back to `fetchTier2Summary()`, i.e. the old live scan. Correct, but slow enough to lose the shard                     |
| row older than 48 h | still **served**, plus a `console.error`. A sitemap whose `<lastmod>` drifted by a day beats a shard missing from the index |
| read throws         | falls back to the live scan, plus a `console.error`. The realistic cause is the migration not having been applied           |

The page read (`buildClimbShardPage`) follows the same doctrine: an empty
`sitemap_climb_urls` or a read that throws falls back to the live grouped build —
the 51 s path, correct and never worse than before the store existed. It is
TTL-cached per instance, so only the first request into an empty store pays it
(measured on the dev image with MoonBoard in: 22.7 s for the first hit against a
warm database, dev route compile included, then 0.40 s and 0.48 s; the same scan
costs 64.9 s cold — see "What the refresh costs" below, it is the same builder).
The `after()` self-heal only fires on `/sitemap.xml`, so a crawler that lands on
a page URL first has to be allowed to finish that slow build rather than be cut
off. On the Railway container it is, with nothing to configure: the route carries
no `maxDuration`, for the same reason `/sitemap.xml` dropped its own (#4648) —
there is no per-invocation ceiling to raise. There is no staleness bound on
pages; the summary row's 48 h shout covers the store as a whole, since both
tables share one refresh.

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
  fallback build, so a request killed partway through cannot swallow it.

`scripts/production-smoke.ts` asserts this header on every deploy, and the
assertion is deliberately the inverse of what it used to be. While publication was
paused the smoke required the header to be **absent**, the index to omit climb
shard URLs, and a direct climb shard request to return the cacheable 410 — so
re-enabling the surface could not be done by changing an environment variable
alone. #4648 flipped all three together in one change: the index must now carry
climb `<loc>` entries, `/sitemaps/climbs/1.xml` must be a cacheable 200 XML, and
both must name a source. The tripwire still works in the other direction — an
image that lost `CLIMB_SITEMAPS_ENABLED` turns the post-deploy smoke red instead
of silently withdrawing 53,000 URLs. A `live` source is a WARN rather than a FAIL:
correct, complete, and paying the scan the store exists to retire.

One honest limit, shared with `X-Sitemap-Degraded`: the header rides a CDN-cached
response. A healthy index is `s-maxage=3600` and the shard pages are
`s-maxage=21600`, and the edge in front of the origin is free to ignore the smoke's
`Cache-Control: no-cache` request header, so the value read can be up to that old in
either direction. It is a signal that a wedged store gets noticed within the hour,
not a live probe. The Sentry event has no such lag.

### Who refreshes it

Three paths, in order of who does the work:

1. **The scheduler.** `refresh-sitemap-climbs` in
   `packages/scheduler/src/jobs/registry.ts` triggers
   `/api/internal/refresh-sitemap-climbs` at `0 */6 * * *` UTC with a 15-minute
   `timeoutMs`, and Sentry raises a missed-occurrence issue on
   `scheduler-refresh-sitemap-climbs` if a run does not check in. Six hours
   matches `s-maxage=21600` on the shard pages: refreshing less often would
   publish `<lastmod>` values the CDN had already aged out, more often would
   re-run sixteen `DISTINCT ON` scans more frequently than any crawler re-reads
   the file. `SCHEDULER_DISABLED_JOBS=refresh-sitemap-climbs` unschedules it
   without a deploy. See [scheduler.md](./scheduler.md).

   This replaces the bespoke one-shot Railway cron service an earlier draft of
   the runbook called for. The scheduler is that service and already has the
   monitors, the per-job timeout and the kill switch.

2. **The `after()` self-heal** on `/sitemap.xml` itself. After the response has
   flushed — so it cannot touch the 3 s deadline or the latency a crawler sees — the
   index kicks a refresh if the summary row is missing or past 48 h, **or if
   `sitemap_climb_urls` is empty**. That last probe matters on the deploy that adds
   the URL table: an older summary row can still be fresh while the new table is
   empty, so a summary-only check would wait for the age threshold while every page
   request took the 51 s fallback. Single-flighted per instance behind a 15-minute floor.
   This keeps the enabled surface scheduler-independent: a missing or old store
   degrades to "healed by the next crawl", not to a permanently broken sitemap.
3. **By hand**, after re-enabling the switch or a deploy that leaves the store empty:

   ```
   curl --fail-with-body --silent --show-error \
     -H "Authorization: Bearer $CRON_SECRET" \
     https://www.boardsesh.com/api/internal/refresh-sitemap-climbs
   ```

   Neither the scheduler nor the `after()` hook makes this necessary — both fire
   on their own — but it closes the window immediately and reports refusals
   directly: a 409 prints why the refresh was declined and exits non-zero, while
   the self-heal only writes that to the log. While the switch is off, the same
   authenticated curl returns `skipped: "disabled"` and performs no scan.

### Post-deploy verification, and the way back

Publication is on, so there is no re-enable to run. What follows is the check
list for a deploy that touches this surface and the way to withdraw it again.

**After a deploy**, `production-smoke.ts` already asserts the shape: the index
lists `/sitemaps/climbs/1.xml`, the shard answers 200 XML, and both name a
source. Read the source it reports. `store` is healthy; `live` is a WARN that
means the store is empty or unreadable and every page fetch behind it is
rebuilding the whole ordered list, so trigger a refresh by hand and confirm it
comes back `store`:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://www.boardsesh.com/api/internal/refresh-sitemap-climbs
```

A stored, non-empty refresh answers 200 with `"skipped": null` and an
`itemCount` in the tens of thousands. A 409 names the refusal — see the table
below — and leaves both tables untouched.

**Watch, for the first day**, the two open connection-pressure issues (#4842,
#4861) that this surface's crawl load feeds: `/health/db`, the web service's 500
rate, and `pg_stat_activity` web connections.

**To withdraw the surface again**, set `CLIMB_SITEMAPS_ENABLED` to `false` on
the Railway `web` service (Variables → the web service → deploy the staged
change). The service variable overrides the image `ENV`, so this takes effect on
the next deploy with no code change and no rebuild. Within one CDN window the
index stops listing climb pages and `/sitemaps/climbs/*.xml` returns the
cacheable 410. The store keeps its rows; nothing needs repopulating on the way
back. The post-deploy smoke will then go red on the enabled contract, which is
the intended tripwire — flip the smoke back in the same change if the withdrawal
is meant to last.

**A DNS rollback to Vercel withdraws this surface.** `CLIMB_SITEMAPS_ENABLED`
is baked into `Dockerfile.web`, which only the Railway image build reads, and
`WEB_DEPLOY_TARGETS` still lists `vercel` for the rollback window
([production-deploy.md](./production-deploy.md#web-deploy-targets)). So the
Vercel deployment serves the withdrawn contract — no climb entries in the index,
410 from `/sitemaps/climbs/*.xml` — and rolling www back to it drops ~53,000
URLs until `CLIMB_SITEMAPS_ENABLED=true` is set on the Vercel project and it
redeploys. That deployment's `/sitemap.xml` also runs on the platform's default
function duration now that #4648 removed `maxDuration = 300`, which was the
Vercel Pro ceiling. Nothing catches either: the Vercel post-deploy smoke is
commented out in `production-deploy.yml`.

**Do not** re-add a schedule to `packages/web/vercel.json`, and do not stand up
a second cron service: the refresh runs on the Railway scheduler
(`refresh-sitemap-climbs`), and `registry.test.ts` reds if a path is scheduled
on both sides.

### What the refresh costs

Worth stating as a range, because the spread between a warm and a cold Postgres
is wide enough to mislead if only one end is quoted. All measured on the full
dev image (648k climbs, 85,347 tier-2 URLs across 13 groups, MoonBoard included),
through the real cron route:

| database state                          | `scanDurationMs` | measured                       |
| --------------------------------------- | ---------------- | ------------------------------ |
| cold — container restarted, empty store | **64.9 s**       | #4578 review, reproduced twice |
| warm, repeat runs on a loaded box       | 20.0 – 28.4 s    | #4578 review, three runs       |
| warm, quiet box                         | 8.9 – 12.2 s     | #4578 authoring, two runs      |

Budget against the **cold** number. `maxDuration` on the refresh route is still
300 s — vestigial on the container, load-bearing only on the frozen Vercel
rollback deployment; scaling 64.9 s by production's projected 126,642 rows over
the dev image's 85,347 gives roughly **96 s**, so that margin is about 3x, not
the 24x the warm figure suggests. The same scan is what `buildClimbShardPage`
falls back to when the store is empty, and on the container that fallback has no
ceiling to run into.

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
cap. That was measured against Vercel's 2 MB Data Cache entry ceiling; off Vercel the
thing to stay small against is the standalone server's in-process incremental-cache
budget, and a megabyte of rows fits where the climb item list (>10 MB) would evict
everything around it. That size gap is the whole reason climbs needed the
Postgres-backed store instead. So
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
returned, so its eventual write goes into an array nobody is holding and a container
that restarts or a serverless instance that freezes drops it — and the next request
misses again. Running the same
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

`/sitemaps/climbs/N.xml` is fixed (#4552) — a stored page reads in
milliseconds. What remains slow is the **fallback**: an empty
`sitemap_climb_urls` (a truncation or local dev) still takes the 51 s live build until
the first refresh runs. The self-heal's empty-table probe bounds that window to one
crawl of `/sitemap.xml`; the manual curl closes it immediately. Disabled requests do
not reach either path; they return the cacheable 410.

That one crawl really does degrade, and it is worth knowing what it looks like so
nobody mistakes it for a regression. Measured on the dev image with the store
truncated, over the thirteen groups the code resolved when this branch was
cut — the shape is what matters here, and the counts are owed a re-measure
since `main` widened the tier-2 angle predicate to the routable set: `/sitemap.xml`
answers 200 in 4.3 s with `X-Sitemap-Degraded: climbs` and no climbs pages
listed, then the `after()` self-heal writes 85,347 rows and every request after
it is healthy at ~0.1 s. Do not reach for concurrency here — a fan-out over the
group list was tried and dropped, because a cold thirteen-group scan does not fit
in `SHARD_DEADLINE_MS` at any lane count and the pool is ten connections wide
(#4461). The answer to a slow fallback is a refreshed store.

Both shard paths now check bytes, and they check different numbers on purpose
(#4618, closed by #4648).

`MAX_SHARD_BYTES` (45 MB) is the **protocol backstop** on any file, fixed or
paged: sitemaps.org rejects one over 50 MB uncompressed and Search Console
rejects it whole rather than reading part of it, so 503-and-retry beats serving
it. 45 MB is that limit with the same 10% headroom `MAX_URLS_PER_SHARD` keeps
against 50,000 URLs. Until #4648 the fixed path had no byte check at all, and the
constant it was missing was Vercel's 4.5 MB response ceiling — a number *below*
what the URL cap allowed, which is what made #4618 a bug rather than a gap.

`pagedShardByteBudget(urlsPerShard)` is the **working guard** on a paged page:
its own page size at 500 bytes/URL, so the climbs pages get 5 MB rather than 45.
A ceiling eighteen times the page it guards cannot see the regression that
matters, which is a per-URL cost that multiplied rather than a shard that grew.

The arithmetic, re-measured on www on 2026-09-02. `/sitemaps/playlists.xml` serves
2,615,676 bytes across 3,020 `<url>` entries: **866 bytes per URL** for an
`all-locales` shard, dominated by the five-entry `xhtml:link` block. (#4618 records
~216 B/URL, from before the alternates block existed, so every row in its table
understates the cost by about four times.) A climbs page is `default-locale-only`
with no alternates block and costs ~250 B/URL, so fanning it out to locales — the
change `entries.ts` warns against — would take a page from 2.5 MB to 8.7 MB. That
is what the 5 MB page budget catches and a 45 MB one would not.

One thing still follows, not urgent: at 866 B/URL, `MAX_ITEMS_PER_SHARD` (11,250
items → 45,000 URLs) lets a fixed shard reach ~**39 MB**. That is legal and it
still serves, and it is a lot of file to hand a crawler. Paging `playlists` onto
the `PagedSitemapShard` machinery — which would give it a page-sized budget the
way climbs has one — is #5073.

## Operational gotchas

- **A deploy that changes climb URL shape needs a manual refresh.**
  `sitemap_climb_urls.path` is rendered at refresh time, so new URL logic keeps
  serving the old shape until the next scheduled run, the self-heal's staleness
  threshold, or someone runs the curl above. The old URLs still resolve and point at
  the climb's selected canonical angle, so this is a staleness window, not an outage.
- **`scripts/production-smoke.ts` pins the published state.** It fails if the index
  stops listing climb pages, if the shard stops answering 200 XML, or if either
  drops its source header. Withdrawing the surface therefore takes a smoke change
  as well as the environment variable — the same tripwire that used to point the
  other way.
