import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, desc, eq, exists, sql } from 'drizzle-orm';
import type { SerialPlanDb } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { playlistClimbs, playlists } from '@/app/lib/db/schema';
import type { PlaylistSitemapRow } from './playlist-entries';
import { MAX_ITEMS_PER_SHARD } from './sitemap-xml';

/** Next Data Cache window; matches the shard route's own `s-maxage=3600`. */
const PLAYLIST_REVALIDATE_SECONDS = 3_600;
/** In-process window, in front of the Data Cache (which does not dedupe misses). */
const PLAYLIST_TTL_MS = 3_600_000;
/** Per-instance floor between `after()` warm attempts, so a failing query cannot re-run on every crawl hit. */
const WARM_RETRY_MS = 60_000;
const PLAYLIST_CACHE_TAG = 'sitemap-playlists';

/**
 * Split out from the fetch so a test can render this query's real SQL with
 * `.toSQL()` instead of grepping the source for the predicate it hopes is there.
 *
 * Takes the handle rather than closing over `dbzRead` — the shape
 * `buildTier2ClimbQuery` already uses — so the caller can run it inside the
 * transaction the statement timeout needs. Both the outer select and the
 * correlated `exists(...)` use the same handle, so the subquery runs inside that
 * transaction too rather than on a second pooled connection with no timeout.
 */
export function buildPlaylistSitemapQuery(db: SerialPlanDb) {
  return db
    .select({ uuid: playlists.uuid, updatedAt: playlists.updatedAt })
    .from(playlists)
    .where(
      and(
        eq(playlists.isPublic, true),
        exists(
          db
            .select({ playlistId: playlistClimbs.playlistId })
            .from(playlistClimbs)
            .where(eq(playlistClimbs.playlistId, playlists.id)),
        ),
      ),
    )
    .orderBy(desc(playlists.updatedAt), playlists.uuid)
    .limit(MAX_ITEMS_PER_SHARD);
}

/**
 * The query, bounded so an abandoned one cannot pin a pooled connection.
 *
 * `withDeadline` in the index stops WAITING at `SHARD_DEADLINE_MS`, but it does
 * not cancel: the query keeps running against a pool of ten. Fifteen seconds is a
 * pathological-plan bound, NOT an attempt to meet the 3 s deadline — the shard
 * route `/sitemaps/playlists.xml` legitimately takes up to ~4 s in production, so
 * a 3 s statement timeout would break a working URL. A 57014 surfaces as a throw,
 * which the index already degrades on and the shard route already 503s on.
 *
 * `SET LOCAL` inside an explicit transaction is the only form available here.
 * `DB_STATEMENT_TIMEOUT_MS` emits a `statement_timeout` STARTUP parameter, which
 * PgBouncer transaction pooling rejects outright — packages/db/src/client/postgres.ts
 * documents why it stays off. Same shape as
 * `packages/db/scripts/repair-moonboard-8c-grades.ts`.
 */
async function fetchPlaylistRowsFromDb(): Promise<PlaylistSitemapRow[]> {
  return dbzRead.transaction(async (transactionDb) => {
    await transactionDb.execute(sql`SET LOCAL statement_timeout = '15s'`);
    return buildPlaylistSitemapQuery(transactionDb);
  });
}

/**
 * What actually goes into the Data Cache: ISO strings, never `Date`s.
 *
 * Load-bearing, not stylistic. `unstable_cache` JSON-serialises, so a cached
 * `Date` comes back a string, and `renderLastMod` (sitemap-xml.ts) calls
 * `lastModified.toISOString()` on it — a TypeError that 503s
 * `/sitemaps/playlists.xml` and degrades the index HARDER than the uncached
 * version this replaces. A naive `unstable_cache` wrapper makes #4524 worse; this
 * pair is what stops it. Same reasoning and same shape as `cachedTier2Summary` in
 * climb-query.ts.
 */
type CachedPlaylistRow = { uuid: string; updatedAtIso: string };

/**
 * The rows behind the Next Data Cache.
 *
 * Caching the ROWS rather than a summary is what makes this different from the
 * climbs shard, and it is a size question: 2,688 production rows of
 * `{ uuid, updatedAtIso }` is ~200 KB of JSON, and even at the hard
 * `MAX_ITEMS_PER_SHARD` cap it is ~840 KB. That number used to be measured
 * against Vercel's 2 MB Data Cache entry ceiling; off Vercel (#4648) there is no
 * entry ceiling and the thing to stay small against is the standalone server's
 * in-process incremental-cache budget — a megabyte of playlist rows sits in it
 * without evicting anything, where the >10 MB climb item list would (see
 * `SHARD_DEADLINE_MS` in shard-registry.ts, and `buildTier2ClimbItems` in
 * climb-query.ts). That size gap is why #4523 had to materialise a climbs
 * summary into Postgres and this one can just be cached. Caching the rows fixes
 * both the index AND `/sitemaps/playlists.xml`, measured at 1.3–4.3 s per CDN
 * miss.
 *
 * `row.updatedAt.toISOString()` round-trips exactly: `playlists.updated_at` is a
 * `timestamp` holding UTC and comes back through drizzle's timestamp decoder
 * (`new Date(value + '+0000')`), so no `to_char` is needed here — climb-query.ts
 * only needs one because its raw `sql` fragment bypasses that decoder.
 */
const cachedPlaylistSitemapRows = unstable_cache(
  async (): Promise<CachedPlaylistRow[]> => {
    const rows = await fetchPlaylistRowsFromDb();

    // When the result length equals the budget the shard is full and needs
    // splitting into paged shards — we log rather than silently truncate the tail.
    if (rows.length === MAX_ITEMS_PER_SHARD) {
      console.warn(
        `[sitemap] playlists shard hit its ${MAX_ITEMS_PER_SHARD}-item budget — split it into paged shards before the tail goes missing.`,
      );
    }

    return rows.map((row) => ({ uuid: row.uuid, updatedAtIso: row.updatedAt.toISOString() }));
  },
  ['sitemap-playlist-rows'],
  { revalidate: PLAYLIST_REVALIDATE_SECONDS, tags: [PLAYLIST_CACHE_TAG] },
);

let cachedRows: { builtAt: number; rows: PlaylistSitemapRow[] } | null = null;
let rowsInFlight: Promise<PlaylistSitemapRow[]> | null = null;
let lastWarmAt = 0;

/**
 * Public playlists with at least one climb, newest first, hard-capped at the
 * per-shard item budget — behind the Next Data Cache plus an in-process TTL and
 * single-flight, the same two-layer shape `getAllBoardConfigsOrThrow` uses.
 *
 * Uncached, this ran live on every `force-dynamic` `/sitemap.xml` hit, racing the
 * index's 3 s `SHARD_DEADLINE_MS` against a ten-connection pool it shares with
 * the climbs builder. Re-measured on 2026-08-19 across 12 distinct origin
 * computations of the production index: `playlists` was named in
 * `x-sitemap-degraded` in 4 of them, dropping 10,752 locale-expanded URLs each
 * time (#4524).
 *
 * The in-process layer is not redundant with the Data Cache. `unstable_cache`
 * does not deduplicate concurrent misses, and a crawl burst is `/sitemap.xml`
 * plus `/sitemaps/playlists.xml` arriving together. Sharing one in-flight promise
 * turns that into one query. Nothing is stored on rejection, so a failure is
 * never memoised.
 *
 * Rehydration happens once per TTL, inside the build, so the per-request path
 * reuses the same `Date` objects instead of allocating 2,688 of them per hit.
 *
 * The name and signature are load-bearing: `shard-registry.ts` calls this, and
 * three test files mock this exact symbol.
 */
export async function fetchPlaylistSitemapRows(): Promise<PlaylistSitemapRow[]> {
  if (cachedRows && Date.now() - cachedRows.builtAt < PLAYLIST_TTL_MS) {
    return cachedRows.rows;
  }
  if (rowsInFlight) {
    return rowsInFlight;
  }

  const build = (async () => {
    const rows = (await cachedPlaylistSitemapRows()).map(({ uuid, updatedAtIso }) => ({
      uuid,
      updatedAt: new Date(updatedAtIso),
    }));
    cachedRows = { builtAt: Date.now(), rows };
    return rows;
  })();
  rowsInFlight = build;

  try {
    return await build;
  } finally {
    rowsInFlight = null;
  }
}

/**
 * Populate both cache layers after the response has flushed. Call it from
 * `after()`; never await it in a handler.
 *
 * This is the half of the fix that makes degradation self-healing rather than
 * probabilistic, and the mechanism is not obvious. On a first-population MISS,
 * `unstable_cache` registers its write in `workStore.pendingRevalidates` only
 * AFTER the callback resolves (next/dist/server/web/spec-extension/unstable-cache.js),
 * while the route module snapshots `Object.values(workStore.pendingRevalidates)`
 * into `pendingWaitUntil` at response time (route-modules/app-route/module.js). So
 * an index that abandoned this query at 3 s has already returned, its eventual
 * write is registered into an array nobody is holding, and a container that
 * restarts (or a serverless instance that freezes) can drop it — leaving the
 * next request to miss again. Running the same
 * fetch inside `after()` puts it under `withExecuteRevalidates`
 * (server/after/after-context.js), whose `finally` diffs the store and awaits the
 * writes that appeared while the callbacks ran. That covers the abandoned query
 * too: this call shares its in-flight promise, so the write is registered before
 * the diff.
 *
 * Cheap on the normal path — it returns without touching Postgres when the
 * in-process cache is fresh, and a persistently failing query is held off by a
 * per-instance retry floor instead of re-running on every crawl hit.
 */
export async function warmPlaylistSitemapCache(): Promise<void> {
  const now = Date.now();
  if (cachedRows && now - cachedRows.builtAt < PLAYLIST_TTL_MS) {
    return;
  }
  if (now - lastWarmAt < WARM_RETRY_MS) {
    return;
  }
  lastWarmAt = now;

  try {
    const rows = await fetchPlaylistSitemapRows();
    // `info`, not `warn`: this fires only on a cold cache past the floor, and a
    // successful warm is the expected outcome rather than something to action.
    console.info(`[sitemap] warmed the playlists rows cache: ${rows.length} playlists.`);
  } catch (err) {
    // Swallowed on purpose: this runs in `after()`, where a rejection is only a
    // logged task error, and the next crawl past the floor above retries it.
    console.error('[sitemap] warming the playlists rows cache failed:', err instanceof Error ? err.message : err);
  }
}

/** Test seam: drops the in-process TTL cache, any in-flight query, and the warm floor. */
export function resetPlaylistSitemapCacheForTests(): void {
  cachedRows = null;
  rowsInFlight = null;
  lastWarmAt = 0;
}
