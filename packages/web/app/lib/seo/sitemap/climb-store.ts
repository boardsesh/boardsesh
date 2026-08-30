import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { dbz } from '@/app/lib/db/db';
import { sitemapClimbUrls, sitemapShardRefreshes } from '@/app/lib/db/schema';
import { buildAllTier2UrlRows, buildTier2ClimbItems, fetchTier2Summary, type Tier2Summary } from './climb-query';
import type { SitemapItem } from './entries';
import { CLIMB_URLS_PER_SHARD } from './sitemap-xml';

/**
 * The precomputed side of the climbs shard, in two tables written by one
 * refresher inside one transaction:
 *
 * - **`sitemap_shard_refreshes`** (#4523) — the SUMMARY. `/sitemap.xml` asks how
 *   many climb URLs exist and when the newest one changed, and reads the answer
 *   out of one row instead of running the scan that produces it. The index is
 *   `force-dynamic` and races every paged summary against `SHARD_DEADLINE_MS`
 *   (3 s); the live answer is sixteen sequential `DISTINCT ON` scans — 16.7 s
 *   cold — so every cache miss dropped ~52,000 climb URLs out of the index.
 * - **`sitemap_climb_urls`** (#4552) — the PAGES. `/sitemaps/climbs/N.xml` used
 *   to build the whole ordered list live and slice it in JS, so page N cost the
 *   full scan plus URL rendering — 51 s cold in production, once per page on a
 *   genuinely cold crawl. Stored, a page is an `ordinal` range read measured at
 *   ~21 ms over a 53,000-row stand-in with no index beyond the primary key.
 *
 * One transaction for both is what gives the count the index advertises and the
 * rows the pages serve a single epoch — the summary/item cache-epoch disagreement
 * the paged route handler 503s on can now only happen across a mid-flight
 * refresh, not steady-state.
 */

/** Matches `PagedShardId` in the registry; the table is keyed by shard so playlists can join later. */
export const CLIMBS_SHARD_ID = 'climbs';

/**
 * How old a stored answer may get before the read path starts shouting and the
 * self-heal fires. Forty-eight hours avoids treating ordinary catalogue drift as
 * an outage while still bounding how long an enabled store can go untouched.
 */
export const SITEMAP_CLIMB_STORE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Which path answered: the materialised store, or the live scan it falls back to.
 *
 * The fallback is correct and deliberate — it is why truncating either table
 * loses nothing — but it is also the 51 s page build and the summary that cannot
 * meet `SHARD_DEADLINE_MS`. #4583 was live in production for weeks precisely
 * because a degrade left no trace anyone was watching, so the store says which
 * path it took: `reportStoreFallback` puts it in Sentry, and the registry puts it
 * on the response as `X-Sitemap-Climbs-Source`.
 *
 * Spelled out here rather than imported as the registry's `PagedShardSource`,
 * which is the identical union: `shard-registry.ts` imports this module, so the
 * registry owns the CONTRACT ("a paged shard may report which path answered") and
 * this file owns its own answer. Pointing one at the other would close the loop
 * for the sake of two string literals.
 */
export type ClimbShardSource = 'store' | 'live';

/**
 * Per-reason floor on Sentry emission, per instance.
 *
 * A crawl burst is `/sitemap.xml` plus one request per page arriving together,
 * and an empty store degrades every one of them. Without a floor, one wedged
 * store is one event per request; with it, it is one event per reason per
 * instance per six hours — still loud, still deduplicated by Sentry on top.
 */
const FALLBACK_REPORT_FLOOR_MS = 6 * 60 * 60 * 1000;

const lastFallbackReportAt = new Map<string, number>();

/**
 * Log every time, page at most once per reason per `FALLBACK_REPORT_FLOOR_MS`.
 *
 * `console.error` alone is what this fixes: on Vercel it lands in a log stream
 * nobody reads, which is how the climbs shard stayed absent from the index from
 * the day W-23 landed until #4661.
 */
function reportStoreFallback(reason: string, detail: string): void {
  const message = `[sitemap] climb store fallback (${reason}): ${detail}`;
  console.error(message);

  const now = Date.now();
  const previous = lastFallbackReportAt.get(reason);
  if (previous !== undefined && now - previous < FALLBACK_REPORT_FLOOR_MS) return;
  lastFallbackReportAt.set(reason, now);
  Sentry.captureMessage(message, 'error');
}

/**
 * Transaction-scoped advisory-lock slot for the sitemap refresh write.
 *
 * Range 19550000–19559999 is this codebase's reserved app-level advisory-lock
 * space (see `session-discovery.ts`); the suffix is this issue number so a
 * `pg_locks` row stays greppable back to here.
 *
 * `pg_try_advisory_xact_lock`, NEVER `pg_try_advisory_lock`. A session-scoped
 * lock is not mutual exclusion on this client: drizzle's `execute()` runs on an
 * arbitrary pooled connection while `transaction()` reserves a different one, so
 * the writer would not be holding the lock it took and the unlock could land on a
 * connection that never owned it. Behind PgBouncer transaction-pooling it is worse
 * than useless. `sync-daemon-leases.ts` documents the same trap at length.
 */
const REFRESH_LOCK_KEY = 19_554_523;

/**
 * Floor on how often the `after()` self-heal will even LOOK at the store, per
 * instance. Without it, a store that cannot be refreshed (bad credentials, a
 * missing table) would run the sixteen-scan build on every `/sitemap.xml` hit.
 */
const SELF_HEAL_RETRY_MS = 15 * 60 * 1000;

export type StoredShardRefresh = {
  itemCount: number;
  lastModified: Date | null;
  computedAt: Date;
};

/**
 * The stored answer, or null when nothing has been refreshed yet.
 *
 * `dbz`, NOT `dbzRead`. `createReadDb()` is a separate pool that can be pointed at
 * a replica (`READ_REPLICA_URL`, docs/neon-migration.md), and replication lag here
 * would make the shrink guard compare a fresh count against a stale one and make
 * the staleness self-heal re-fire against a row that was already written.
 */
export async function fetchStoredClimbRefresh(): Promise<StoredShardRefresh | null> {
  const [row] = await dbz
    .select({
      itemCount: sitemapShardRefreshes.itemCount,
      lastModified: sitemapShardRefreshes.lastModified,
      computedAt: sitemapShardRefreshes.computedAt,
    })
    .from(sitemapShardRefreshes)
    .where(eq(sitemapShardRefreshes.shardId, CLIMBS_SHARD_ID))
    .limit(1);

  return row ?? null;
}

/**
 * What the index and the shard route call. Store first, live scan only when the
 * store has nothing to say.
 *
 * Three cases, all of which happen:
 *
 * - **A fresh row** — the normal path, and the only one that meets the 3 s deadline.
 * - **No row** — a fresh migration, a truncated table, or local dev. Falls back to
 *   `fetchTier2Summary()`, which is exactly main's behaviour, so this is never
 *   worse than before the store existed. It is also still slow: the first
 *   `/sitemap.xml` after this deploy degrades until one refresh has run.
 * - **A stale row** — still SERVED. A complete sitemap whose `<lastmod>` drifted by
 *   a day is worth far more than a shard missing from the index, which is the bug
 *   being fixed. It is logged at `error` so the wedge is visible.
 *
 * A store read that THROWS (the table not yet migrated, most likely) falls back
 * rather than propagating: an index that degrades because its speed-up is missing
 * would be a worse outage than the one this replaced.
 */
export async function fetchClimbShardSummary(): Promise<Tier2Summary & { source: ClimbShardSource }> {
  let stored: StoredShardRefresh | null = null;
  let readFailed = false;
  try {
    stored = await fetchStoredClimbRefresh();
  } catch (err) {
    readFailed = true;
    reportStoreFallback(
      'summary-read-failed',
      `could not read sitemap_shard_refreshes, so /sitemap.xml is racing the live scan against SHARD_DEADLINE_MS: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!stored) {
    if (!readFailed) {
      reportStoreFallback(
        'summary-empty',
        'no sitemap_shard_refreshes row for the climbs shard — /sitemap.xml is racing the live scan against SHARD_DEADLINE_MS. The after() self-heal should fix this within one crawl; if it does not, run /api/internal/refresh-sitemap-climbs.',
      );
    }
    return { ...(await fetchTier2Summary()), source: 'live' };
  }

  const ageMs = Date.now() - stored.computedAt.getTime();
  if (ageMs > SITEMAP_CLIMB_STORE_MAX_AGE_MS) {
    console.error(
      `[sitemap] the stored climbs summary is ${Math.round(ageMs / 3_600_000)}h old (limit ${
        SITEMAP_CLIMB_STORE_MAX_AGE_MS / 3_600_000
      }h) — serving it anyway, but /api/internal/refresh-sitemap-climbs has not run successfully in that time.`,
    );
  }

  return { itemCount: stored.itemCount, lastModified: stored.lastModified, source: 'store' };
}

/** Why a refresh declined to write. `null` means it wrote. */
export type RefreshSkipReason = 'locked' | 'superseded' | 'empty' | 'shrank';

export type ClimbStoreRefreshResult = {
  itemCount: number;
  lastModified: Date | null;
  previousItemCount: number | null;
  skipped: RefreshSkipReason | null;
  /**
   * The SCAN only — the sixteen `DISTINCT ON` item queries plus URL rendering.
   * Deliberately not the whole call: the write transaction that follows is a
   * summary upsert plus the chunked URL swap, milliseconds against tens of
   * seconds, and lumping it in would hide which half actually costs anything
   * when this number starts drifting.
   */
  scanDurationMs: number;
};

/**
 * Postgres caps one statement at 65,535 bind parameters; 5 columns × ~52,000 URL
 * rows blows that in a single `.values()`. 1,000 rows is 5,000 parameters —
 * comfortable, and ~53 statements per refresh.
 */
const URL_INSERT_CHUNK_SIZE = 1_000;

let refreshInFlight: { force: boolean; run: Promise<ClimbStoreRefreshResult> } | null = null;

/**
 * Rebuild the tier-2 URL list and store it: the summary row for the index, and
 * the `sitemap_climb_urls` rows for the shard pages. The summary is DERIVED from
 * the built rows (count and max `<lastmod>`) rather than recomputed by the old
 * sixteen COUNT scans — one set of scans instead of two, and the two tables
 * cannot describe different sets.
 *
 * Ordering is the whole design. The sixteen scans run OUTSIDE any transaction —
 * they take tens of seconds and holding a pooled connection idle-in-transaction
 * for that long against a pool of ten is the starvation (#4461) the sequential
 * loop already exists to avoid. Only the writes are transactional, and the
 * transaction takes `pg_try_advisory_xact_lock` as its first statement so two
 * writers cannot interleave a read of the previous count with each other's write.
 *
 * **What the lock does and does not buy.** It serialises the WRITE. It does not
 * stop two instances computing concurrently, because taking it before the compute
 * would mean holding a transaction open across it. That residual is acceptable and
 * bounded: the `after()` self-heal is single-flighted per instance behind a
 * 15-minute floor, the manual endpoint shares the in-flight work, and the compute
 * itself is a read-only sequential scan. The `superseded` check inside the
 * transaction means the second finisher writes nothing rather than clobbering a
 * newer answer.
 *
 * `force` bypasses the shrink guard only. It never bypasses the lock, and it never
 * lets a zero-item answer be stored — a stored zero makes the index throw
 * "expects URLs but its summary reports 0" and drop the shard, which is the exact
 * bug this table exists to prevent.
 *
 * The single-flight below shares a scan only between callers that want the SAME
 * thing. A `?force=1` that piggybacked on a non-force in-flight refresh would silently
 * keep the shrink guard and hand the operator back a 409 telling them to do the
 * thing they just did — which would make the escape hatch look broken exactly when
 * it is needed. So a caller whose `force` disagrees waits for the in-flight scan to
 * settle and then runs its own.
 */
export async function refreshClimbSitemapStore(options: { force?: boolean } = {}): Promise<ClimbStoreRefreshResult> {
  const force = options.force === true;

  const inFlight = refreshInFlight;
  if (inFlight) {
    if (inFlight.force === force) {
      return inFlight.run;
    }
    // Its outcome is not ours to report, and a rejection there must not become a
    // rejection here — this caller has its own scan to run either way.
    await inFlight.run.catch(() => {});
  }

  const run = runRefresh(force);
  refreshInFlight = { force, run };
  try {
    return await run;
  } finally {
    // Only clear the slot if it is still OURS: a caller that overlapped on a
    // different `force` may already have replaced it.
    if (refreshInFlight?.run === run) {
      refreshInFlight = null;
    }
  }
}

async function runRefresh(force: boolean): Promise<ClimbStoreRefreshResult> {
  const startedAt = new Date();
  const urlRows = await buildAllTier2UrlRows();
  const itemCount = urlRows.length;
  let lastModified: Date | null = null;
  for (const urlRow of urlRows) {
    if (urlRow.lastModified && (!lastModified || urlRow.lastModified > lastModified)) {
      lastModified = urlRow.lastModified;
    }
  }
  const scanDurationMs = Date.now() - startedAt.getTime();

  return dbz.transaction(async (tx) => {
    const lockRows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${REFRESH_LOCK_KEY}) AS locked`,
    );
    if (!lockRows[0]?.locked) {
      return { itemCount, lastModified, previousItemCount: null, skipped: 'locked' as const, scanDurationMs };
    }

    const [previous] = await tx
      .select({ itemCount: sitemapShardRefreshes.itemCount, computedAt: sitemapShardRefreshes.computedAt })
      .from(sitemapShardRefreshes)
      .where(eq(sitemapShardRefreshes.shardId, CLIMBS_SHARD_ID))
      .limit(1);

    const previousItemCount = previous?.itemCount ?? null;
    const declined = (skipped: RefreshSkipReason) => ({
      itemCount,
      lastModified,
      previousItemCount,
      skipped,
      scanDurationMs,
    });

    if (previous && previous.computedAt > startedAt) {
      // Another instance finished a newer refresh while this one was scanning.
      return declined('superseded');
    }

    if (itemCount === 0) {
      console.error(
        '[sitemap] the climbs summary refresh computed 0 items — refusing to store it. A stored zero drops every climb URL out of the index.',
      );
      return declined('empty');
    }

    // Fail closed on a collapse. A refresh that suddenly reports a third of the
    // catalogue is a regressed predicate far more often than it is a real
    // deletion, and storing it would quietly shrink the index. `?force=1` on the
    // authenticated refresh route is the way out when the shrink IS real, so the
    // guard cannot wedge the store permanently.
    if (!force && previousItemCount !== null && itemCount * 2 < previousItemCount) {
      console.error(
        `[sitemap] the climbs summary refresh computed ${itemCount} items, down from ${previousItemCount} — refusing to store a >50% shrink. Re-run with ?force=1 if the shrink is real.`,
      );
      return declined('shrank');
    }

    // One timestamp for both branches of the upsert, not two: an insert and a
    // conflict-update would otherwise store values a few microseconds apart, and
    // `computedAt` is what the superseded check and the staleness bound both
    // pivot on.
    const computedAt = new Date();
    await tx
      .insert(sitemapShardRefreshes)
      .values({ shardId: CLIMBS_SHARD_ID, itemCount, lastModified, computedAt })
      .onConflictDoUpdate({
        target: sitemapShardRefreshes.shardId,
        set: { itemCount, lastModified, computedAt },
      });

    // The URL swap rides the same transaction as the summary — that shared epoch
    // is the point, and the guards above (locked / superseded / empty / shrank)
    // protect both tables identically. MVCC keeps concurrent page reads on the
    // previous rows until the commit; no reader ever sees the table mid-swap.
    await tx.delete(sitemapClimbUrls);
    for (let start = 0; start < urlRows.length; start += URL_INSERT_CHUNK_SIZE) {
      await tx.insert(sitemapClimbUrls).values(
        urlRows.slice(start, start + URL_INSERT_CHUNK_SIZE).map((urlRow, offset) => ({
          // 0-based emission order; `buildAllTier2UrlRows` documents it as a
          // contract, and the page reads slice on it.
          ordinal: start + offset,
          path: urlRow.path,
          lastModified: urlRow.lastModified,
          boardType: urlRow.boardType,
          layoutId: urlRow.layoutId,
        })),
      );
    }

    return { itemCount, lastModified, previousItemCount, skipped: null, scanDurationMs };
  });
}

/** One shard page from the store, or null when the URL table has never been populated. */
export type StoredClimbPage = { items: SitemapItem[]; totalItems: number };

/** One shard page plus which path built it, which is what the route header reports. */
export type ClimbShardPage = StoredClimbPage & { source: ClimbShardSource };

/**
 * Page N of the stored URL list: `ordinal >= start AND ordinal < start + perPage`,
 * a primary-key range scan measured at ~21 ms for a 10,000-row page.
 *
 * `dbz`, not `dbzRead`, for the same reason as the summary read above: the
 * summary (always `dbz`) is what derives the page count the route handler 404s
 * against, and a replica-lagged URL table meeting a fresh summary would turn
 * every crawl of a new last page into a spurious 503.
 *
 * The count is a second statement, so a refresh can commit between the two reads.
 * That tear is bounded and self-describing: the swap itself is one transaction,
 * so each statement sees a complete epoch, and the worst case — an empty slice
 * against a non-zero count — is exactly the transient disagreement the route
 * handler already 503s with `no-store`.
 */
export async function fetchStoredClimbPage(page: number): Promise<StoredClimbPage | null> {
  const start = (page - 1) * CLIMB_URLS_PER_SHARD;
  const pageRows = await dbz
    .select({ path: sitemapClimbUrls.path, lastModified: sitemapClimbUrls.lastModified })
    .from(sitemapClimbUrls)
    .where(and(gte(sitemapClimbUrls.ordinal, start), lt(sitemapClimbUrls.ordinal, start + CLIMB_URLS_PER_SHARD)))
    .orderBy(asc(sitemapClimbUrls.ordinal));

  const [totalRow] = await dbz.select({ totalItems: sql<number>`count(*)::int` }).from(sitemapClimbUrls);
  const totalItems = totalRow?.totalItems ?? 0;

  // An EMPTY table is "never populated" — the refresher's empty guard means it
  // never commits a zero-row swap — so the caller falls back to the live build.
  // An empty SLICE of a populated table is not: that verdict (transient tear vs
  // out-of-range) belongs to the route handler, which has the summary in hand.
  if (totalItems === 0) {
    return null;
  }

  return {
    items: pageRows.map((pageRow) => ({ path: pageRow.path, lastModified: pageRow.lastModified })),
    totalItems,
  };
}

/**
 * What the registry's `buildPage` calls. Store first; the live grouped build
 * only when the store has nothing to say — the same doctrine as
 * `fetchClimbShardSummary`, including "a read that throws falls back rather than
 * propagating": the realistic throw is the migration not yet applied, and a page
 * that 503s because its speed-up is missing would be a worse outage than the
 * slow path it replaced.
 *
 * The fallback is never quiet. Nothing in this suite used to look at the page
 * path at all — the smoke asserts the index's `<loc>` entries, not the pages —
 * so an empty URL table meant every crawler fetch paid 51 s with no signal
 * anywhere. It now fires a Sentry event and returns `source: 'live'`, which the
 * route turns into `X-Sitemap-Climbs-Source: live`.
 */
export async function buildClimbShardPage(page: number): Promise<ClimbShardPage> {
  let reason = 'page-empty';
  let detail =
    'sitemap_climb_urls holds no rows, so every /sitemaps/climbs/N.xml is rebuilding the whole ordered list (51 s cold in production, once per page per cold lambda). The after() self-heal on /sitemap.xml should fix this within one crawl; if it does not, run /api/internal/refresh-sitemap-climbs.';
  try {
    const stored = await fetchStoredClimbPage(page);
    if (stored) {
      return { ...stored, source: 'store' };
    }
  } catch (err) {
    reason = 'page-read-failed';
    detail = `could not read sitemap_climb_urls, so /sitemaps/climbs/N.xml is rebuilding the whole ordered list: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  // Reported BEFORE the fallback build, not after: the build is the 51 s path,
  // and on a Vercel timeout an event fired afterwards is an event nobody gets.
  reportStoreFallback(reason, detail);

  const items = await buildTier2ClimbItems();
  const start = (page - 1) * CLIMB_URLS_PER_SHARD;
  return { items: items.slice(start, start + CLIMB_URLS_PER_SHARD), totalItems: items.length, source: 'live' };
}

/**
 * `max(last_modified)` per page, indexed by 0-based page (page 1 is index 0) —
 * what lets the index stamp an honest per-page `<lastmod>` instead of the
 * uniform shard-wide value it had to settle for when knowing which page a climb
 * fell on cost the whole scan (#4552).
 *
 * Returns `[]` when the store is empty, and the caller falls back to the
 * uniform value — this is an enhancement, never a reason to degrade the shard.
 * Integer division needs the explicit casts: an untyped bound parameter would
 * make Postgres resolve `/` as numeric division and round pages up.
 */
export async function fetchStoredClimbPageLastmods(): Promise<(Date | null)[]> {
  const pageRows = await dbz
    .select({
      pageIndex: sql<number>`(${sitemapClimbUrls.ordinal} / ${CLIMB_URLS_PER_SHARD}::int)::int`,
      // `to_char` with an explicit `Z`, exactly like `buildTier2ClimbSummaryQuery`:
      // the raw aggregate bypasses drizzle's timestamp decoder, and the bare pg
      // text form would otherwise be parsed in the process timezone.
      lastModifiedIso: sql<
        string | null
      >`to_char(max(${sitemapClimbUrls.lastModified}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(sitemapClimbUrls)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const lastmods: (Date | null)[] = [];
  for (const pageRow of pageRows) {
    // Ordinals are dense (0..N-1), so every page up to the last one is present;
    // indexing by pageIndex rather than push order keeps this correct even if
    // that ever stops being true.
    lastmods[pageRow.pageIndex] = pageRow.lastModifiedIso ? new Date(pageRow.lastModifiedIso) : null;
  }
  return lastmods;
}

/** True once a refresh has ever populated the URL table. */
async function hasStoredClimbUrls(): Promise<boolean> {
  const rows = await dbz
    .select({ present: sql<number>`1` })
    .from(sitemapClimbUrls)
    .limit(1);
  return rows.length > 0;
}

let lastSelfHealAt = 0;

/**
 * The self-heal, called from `after()` on `/sitemap.xml` once the response has
 * flushed.
 *
 * It keeps the enabled surface independent of a scheduler: a missing or stale
 * store degrades to "the store is refreshed by a crawler fetch" rather than to a
 * permanently broken sitemap. It also populates the store on the first enabled
 * `/sitemap.xml` request after deploy, without anyone running the manual curl.
 *
 * Never awaited by a request, never allowed to throw into one: `after()` runs
 * post-flush, so the only thing a failure here can cost is the refresh itself.
 */
export async function refreshClimbStoreIfStale(): Promise<void> {
  const now = Date.now();
  if (now - lastSelfHealAt < SELF_HEAL_RETRY_MS) {
    return;
  }
  lastSelfHealAt = now;

  try {
    const stored = await fetchStoredClimbRefresh();
    // The URL-table check is not redundant with the summary row: on the deploy
    // that ADDS `sitemap_climb_urls`, an older summary row can still be fresh while
    // the new URL table sits empty — and without this check the self-heal would
    // wait for the age threshold while every page request took the 51 s fallback.
    // One `LIMIT 1` probe closes that window on the first crawl.
    const staleReason = !stored
      ? 'empty'
      : now - stored.computedAt.getTime() >= SITEMAP_CLIMB_STORE_MAX_AGE_MS
        ? 'stale'
        : !(await hasStoredClimbUrls())
          ? 'missing URL rows'
          : null;
    if (staleReason === null) {
      return;
    }

    const result = await refreshClimbSitemapStore();
    console.warn(
      `[sitemap] self-healed the climb sitemap store (${staleReason}): ${result.itemCount} items in ${result.scanDurationMs}ms, skipped=${result.skipped ?? 'no'}`,
    );
  } catch (err) {
    console.error('[sitemap] the climb sitemap store self-heal failed:', err instanceof Error ? err.message : err);
  }
}

/** Test seam: drops the per-instance single-flight, self-heal floor and report floor. */
export function resetClimbStoreStateForTests(): void {
  refreshInFlight = null;
  lastSelfHealAt = 0;
  lastFallbackReportAt.clear();
}
