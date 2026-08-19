import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { dbz } from '@/app/lib/db/db';
import { sitemapShardRefreshes } from '@/app/lib/db/schema';
import { computeTier2Summary, fetchTier2Summary, type Tier2Summary } from './climb-query';

/**
 * The precomputed side of the climbs shard: `/sitemap.xml` asks how many climb
 * URLs exist and when the newest one changed, and reads the answer out of
 * `sitemap_shard_refreshes` instead of running the scan that produces it.
 *
 * Why (#4523): the index is `force-dynamic` and races every paged summary against
 * `SHARD_DEADLINE_MS` (3 s). The live answer is sixteen sequential `DISTINCT ON`
 * scans — 16.7 s cold and 0.95 s fully warm for the largest single group — so a
 * request that missed both cache layers structurally could not answer in time, and
 * every miss dropped ~52,000 climb URLs out of the index for at least a minute.
 * One row of this table answers in about a millisecond at every temperature.
 *
 * Scope, stated plainly: this fixes the INDEX. `/sitemaps/climbs/N.xml` still
 * builds its items live and is still slow cold — that is the separate follow-up
 * this table's shape is designed to grow into.
 */

/** Matches `PagedShardId` in the registry; the table is keyed by shard so playlists can join later. */
export const CLIMBS_SHARD_ID = 'climbs';

/**
 * How old a stored answer may get before the read path starts shouting and the
 * self-heal fires. Deliberately far longer than the 6-hour cron interval: this is
 * "nobody has refreshed this in two days, the scheduler is gone", not "this is
 * slightly behind".
 */
export const SITEMAP_CLIMB_STORE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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
export async function fetchClimbShardSummary(): Promise<Tier2Summary> {
  let stored: StoredShardRefresh | null = null;
  try {
    stored = await fetchStoredClimbRefresh();
  } catch (err) {
    console.error(
      '[sitemap] could not read the stored climbs summary — falling back to the live scan:',
      err instanceof Error ? err.message : err,
    );
  }

  if (!stored) {
    return fetchTier2Summary();
  }

  const ageMs = Date.now() - stored.computedAt.getTime();
  if (ageMs > SITEMAP_CLIMB_STORE_MAX_AGE_MS) {
    console.error(
      `[sitemap] the stored climbs summary is ${Math.round(ageMs / 3_600_000)}h old (limit ${
        SITEMAP_CLIMB_STORE_MAX_AGE_MS / 3_600_000
      }h) — serving it anyway, but /api/internal/refresh-sitemap-climbs has not run successfully in that time.`,
    );
  }

  return { itemCount: stored.itemCount, lastModified: stored.lastModified };
}

/** Why a refresh declined to write. `null` means it wrote. */
export type RefreshSkipReason = 'locked' | 'superseded' | 'empty' | 'shrank';

export type ClimbSummaryRefreshResult = {
  itemCount: number;
  lastModified: Date | null;
  previousItemCount: number | null;
  skipped: RefreshSkipReason | null;
  durationMs: number;
};

let refreshInFlight: Promise<ClimbSummaryRefreshResult> | null = null;

/**
 * Recompute the tier-2 summary and store it.
 *
 * Ordering is the whole design. The sixteen scans run OUTSIDE any transaction —
 * they take tens of seconds and holding a pooled connection idle-in-transaction
 * for that long against a pool of ten is the starvation (#4461) the sequential
 * loop already exists to avoid. Only the one-row upsert is transactional, and it
 * takes `pg_try_advisory_xact_lock` as its first statement so two writers cannot
 * interleave a read of the previous count with each other's write.
 *
 * **What the lock does and does not buy.** It serialises the WRITE. It does not
 * stop two instances computing concurrently, because taking it before the compute
 * would mean holding a transaction open across it. That residual is acceptable and
 * bounded: the cron is the normal trigger and runs on one instance, the `after()`
 * self-heal is single-flighted per instance behind a 15-minute floor, and the
 * compute itself is a read-only sequential scan. The `superseded` check inside the
 * transaction means the second finisher writes nothing rather than clobbering a
 * newer answer.
 *
 * `force` bypasses the shrink guard only. It never bypasses the lock, and it never
 * lets a zero-item answer be stored — a stored zero makes the index throw
 * "expects URLs but its summary reports 0" and drop the shard, which is the exact
 * bug this table exists to prevent.
 */
export async function refreshStoredClimbSummary(options: { force?: boolean } = {}): Promise<ClimbSummaryRefreshResult> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const run = runRefresh(options.force === true);
  refreshInFlight = run;
  try {
    return await run;
  } finally {
    refreshInFlight = null;
  }
}

async function runRefresh(force: boolean): Promise<ClimbSummaryRefreshResult> {
  const startedAt = new Date();
  const { itemCount, lastModifiedIso } = await computeTier2Summary();
  const lastModified = lastModifiedIso ? new Date(lastModifiedIso) : null;
  const durationMs = Date.now() - startedAt.getTime();

  return dbz.transaction(async (tx) => {
    const lockRows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${REFRESH_LOCK_KEY}) AS locked`,
    );
    if (!lockRows[0]?.locked) {
      return { itemCount, lastModified, previousItemCount: null, skipped: 'locked' as const, durationMs };
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
      durationMs,
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
    // cron route is the way out when the shrink IS real, so the guard cannot wedge
    // the store permanently.
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

    return { itemCount, lastModified, previousItemCount, skipped: null, durationMs };
  });
}

let lastSelfHealAt = 0;

/**
 * The self-heal, called from `after()` on `/sitemap.xml` once the response has
 * flushed.
 *
 * It is what keeps this fix from depending on a scheduler. A lapsed cron (the
 * Railway cutover, #3795/#3798, has to re-point all eight of them) degrades to
 * "the store is refreshed by a crawler fetch" rather than to a broken sitemap.
 * It also populates the store on the very first `/sitemap.xml` after deploy,
 * without anyone running the manual curl.
 *
 * Never awaited by a request, never allowed to throw into one: `after()` runs
 * post-flush, so the only thing a failure here can cost is the refresh itself.
 */
export async function refreshClimbSummaryIfStale(): Promise<void> {
  const now = Date.now();
  if (now - lastSelfHealAt < SELF_HEAL_RETRY_MS) {
    return;
  }
  lastSelfHealAt = now;

  try {
    const stored = await fetchStoredClimbRefresh();
    if (stored && now - stored.computedAt.getTime() < SITEMAP_CLIMB_STORE_MAX_AGE_MS) {
      return;
    }

    const result = await refreshStoredClimbSummary();
    console.warn(
      `[sitemap] self-healed the climbs summary store (${stored ? 'stale' : 'empty'}): ${result.itemCount} items in ${result.durationMs}ms, skipped=${result.skipped ?? 'no'}`,
    );
  } catch (err) {
    console.error('[sitemap] the climbs summary self-heal failed:', err instanceof Error ? err.message : err);
  }
}

/** Test seam: drops the per-instance single-flight and self-heal floor. */
export function resetClimbStoreStateForTests(): void {
  refreshInFlight = null;
  lastSelfHealAt = 0;
}
