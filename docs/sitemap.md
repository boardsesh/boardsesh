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
| members           | `static`, `boards`, `gyms`, `setters`, `playlists` | `climbs`                                         |
| file              | one `/sitemaps/<id>.xml`                           | `/sitemaps/climbs/1.xml … N.xml`                 |
| index asks it for | the whole item list                                | `summary()` only — count + newest timestamp      |
| N comes from      | —                                                  | `ceil(itemCount / urlsPerShard)` at request time |

`N` is derived from the summary on every request, never from the filesystem: Next has
no partial dynamic segments, so a `climbs-1.xml` shape would hardcode today's page
count into the directory tree.

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

## The climbs summary store

The climbs shard is the largest surface by two orders of magnitude — roughly 52,000
URLs across six pages — and used to be the one least able to meet the 3 s deadline.
Its summary is two numbers, but the COST of those two numbers was the full
`DISTINCT ON (climb_uuid)` tier-2 scan once per `(board_type, layout_id)` group,
sixteen groups, sequential (concurrent heavy scans against a pool of ten is the #4461
starvation). Measured on the full-board dev image, the largest single group: 16.7 s
cold, 3.8 s warm, 0.95 s fully warm. No cache temperature meets 3 s, so any request
that missed both cache layers dropped every climb URL out of the index for at least a
minute (#4523).

So the answer is stored instead of recomputed:

- **`sitemap_shard_refreshes`** (`packages/db/src/schema/app/sitemap-shard-refreshes.ts`)
  — one row per shard: `shard_id`, `item_count`, `last_modified`, `computed_at`.
  Keyed by shard rather than modelled on climbs, because `playlists` (#4524) has the
  same shape of problem.
- **`climb-store.ts`** — `fetchClimbShardSummary()` reads that row (~1 ms) and is what
  the registry's `summary()` calls. `refreshStoredClimbSummary()` writes it.

It is a **cache, not a source of truth**. Truncate it and nothing is lost: the read
path falls back to the live scan it replaced, and the next refresh repopulates it.

### Read behaviour

| store state         | what happens                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| fresh row           | served — the only path that meets the deadline                                                                              |
| no row              | falls back to `fetchTier2Summary()`, i.e. the old live scan. Correct, but slow enough to lose the shard                     |
| row older than 48 h | still **served**, plus a `console.error`. A sitemap whose `<lastmod>` drifted by a day beats a shard missing from the index |
| read throws         | falls back to the live scan, plus a `console.error`. The realistic cause is the migration not having been applied           |

### Who refreshes it

1. **The cron** — `/api/internal/refresh-sitemap-climbs`, six-hourly, in
   `packages/web/vercel.json`. Six hours matches the shard's own `s-maxage=21600`, so
   no layer is staler than any other. Auth is `requireCronAuth`, which reads
   `CRON_SECRET`; Vercel injects the matching bearer automatically.
2. **The `after()` self-heal** on `/sitemap.xml` itself. After the response has
   flushed — so it cannot touch the 3 s deadline or the latency a crawler sees — the
   index kicks a refresh if the store is empty or past 48 h. Single-flighted per
   instance behind a 15-minute floor. This is what keeps the fix from depending on a
   scheduler: a lapsed cron degrades to "healed by the next crawl", not to a broken
   sitemap.
3. **By hand**, which is the one to reach for after a deploy that empties the store:

   ```
   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
     https://www.boardsesh.com/api/internal/refresh-sitemap-climbs
   ```

### Refusals, and how to get out of one

The refresher declines to write in four cases. Two are benign concurrency and answer
200; two mean the store is frozen and answer **409**, so a wedge fails the cron run
that found it rather than hiding in the logs.

| `skipped`    | status | meaning                                                                                                                       |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `locked`     | 200    | another instance holds the write lock                                                                                         |
| `superseded` | 200    | another instance wrote a newer answer while this one was scanning                                                             |
| `empty`      | 409    | the scan computed 0 climbs. Never stored — a stored zero makes the index drop the shard, which is the bug this table prevents |
| `shrank`     | 409    | the scan computed less than half the stored count                                                                             |

`?force=1` bypasses the shrink guard, and only the shrink guard. Use it when the
catalogue genuinely shrank; without it, a real shrink would make every scheduled run
decline forever while the read path kept serving a frozen count. It never bypasses the
lock and never lets a zero be stored.

### Locking

The sixteen scans run **outside** any transaction — they take tens of seconds, and
holding a pooled connection idle-in-transaction for that long against a pool of ten is
the starvation the sequential loop already exists to avoid. Only the one-row upsert is
transactional, and it takes `pg_try_advisory_xact_lock` as its first statement.

Transaction-scoped, never session-scoped. `pg_try_advisory_lock` plus a release in a
`finally` is not mutual exclusion on this client: drizzle's `execute()` runs on an
arbitrary pooled connection while `transaction()` reserves a different one, so the
writer would not hold the lock it took and the unlock could land on a connection that
never owned it. Behind PgBouncer transaction-pooling it is worse than useless.
`packages/db/src/schema/app/sync-daemon-leases.ts` documents the same trap at length.

That lock serialises the _write_. Two instances can still _compute_ concurrently; the
`superseded` check means the later finisher writes nothing instead of clobbering a
newer answer.

## What is still slow

`/sitemaps/climbs/N.xml` — the shard route, not the index. It still builds the full
ordered item list live and slices it in JS, so page N costs the whole list and a cold
instance takes ~51 s. The store fixes the index only. The fix for the route is a
`sitemap_climb_urls` table holding the rendered paths, which is additive on the
scaffolding above.

`playlists` has no cache and no store at all: `fetchPlaylistSitemapRows` hits Postgres
on every `force-dynamic` index request, and it is the shard degrading most often now.

## Operational gotchas

- **A deploy that changes climb URL shape does not invalidate the store's counts.**
  Counts and timestamps survive a URL-shape change untouched, which is fine; but the
  follow-up URL table will store rendered paths, and that one will need a manual
  refresh on any such deploy.
- **The cron is one of eight** in `packages/web/vercel.json`. The Railway cutover
  (#3795/#3798) has to re-point all of them. The `after()` self-heal is the backstop if
  one is missed.
- **`scripts/production-smoke.ts` treats `/sitemaps/climbs/1.xml` as degradable
  (WARN, not FAIL).** Leave it there until the URL table lands — immediately after a
  deploy the store is empty and the fallback is the 51 s path.
