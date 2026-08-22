/**
 * Nightly materialisation of the tier-2 climb sitemap.
 *
 * Rebuilds `sitemap_tier2_climbs` (one row per submitted climb URL) and
 * `sitemap_tier2_groups` (the ≤20-row summary and self-description) so
 * `/sitemap.xml` and `/sitemaps/climbs/N.xml` can read bounded rows instead of
 * running the tier-2 `DISTINCT ON` scan per group on every cold instance.
 *
 * Why (#4583): `/sitemaps/climbs/N.xml` builds the ENTIRE ordered item list before
 * it can slice page N — measured at 27.4 s for a genuinely cold production page
 * fetch on 2026-08-21, and paid again per cold lambda on a crawl. That cost does
 * not go away here, it moves to a place where latency is free.
 *
 * Run locally: `node --import tsx packages/db/scripts/refresh-sitemap-tier2.ts`
 * In CI it runs on a schedule (`.github/workflows/refresh-sitemap-tier2.yml`)
 * with a writable DATABASE_URL.
 *
 * Idempotent: one transaction deletes both tables and re-inserts. `DELETE`, never
 * `TRUNCATE` — `DELETE` takes only `ROW EXCLUSIVE`, so readers keep seeing the old
 * snapshot under READ COMMITTED until commit. An atomic swap with no reader
 * blocking, the same property `refresh-recommendations` relies on.
 */
import { sql } from 'drizzle-orm';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { sitemapTier2Climbs, sitemapTier2Groups } from '../src/schema/app/sitemap-tier2.js';
import { fetchPopularBoardConfigRows } from '../src/queries/boards/popular-configs.js';
import {
  buildTier2ClimbQuery,
  chooseWinningConfigPerLayout,
  MAX_ROWS_PER_GROUP,
  planTier2Refresh,
  tier2PredicateFingerprint,
  type ClimbConfigGroup,
} from '../src/queries/sitemap/index.js';
import { rowsOf } from '../src/queries/util/rows.js';
import type { SerialPlanDb } from '../src/queries/util/serial-plan.js';

/** Postgres caps a statement at 65,535 bind parameters; 1,000 × 6 columns is 6,000. */
const INSERT_CHUNK_ROWS = 1_000;

type BuiltGroup = {
  group: ClimbConfigGroup;
  rows: { climbUuid: string; angle: number; climbName: string | null; lastModified: Date }[];
  lastModified: Date | null;
};

/**
 * The winning board config per `(board_type, layout_id)` — the same ranking the
 * web read path applies, over the same SQL the `popularBoardConfigs` resolver
 * runs. Deliberately not a restatement of either.
 *
 * Unfiltered by URL resolvability: that rule is web's (`isResolvableGroup`, which
 * needs the locale-aware slug resolver), and the read path drops what it cannot
 * address from both its page arithmetic and its emitted set. Materialising a
 * group web will drop costs a few kilobytes; owning a second copy of the URL rule
 * would cost correctness.
 */
async function resolveGroups(db: SerialPlanDb): Promise<ClimbConfigGroup[]> {
  const configs = await fetchPopularBoardConfigRows(db);
  return chooseWinningConfigPerLayout(configs);
}

/**
 * The tier-2 rows for one group.
 *
 * Deliberately NOT wrapped in `withSerialPlan`, unlike the web read path.
 * `max_parallel_workers_per_gather = 0` measured 1,773 ms against 1,419 ms
 * parallel on production, and the `DISTINCT ON` tie-break ends in
 * `asc(stats.angle)` with `(climb_uuid, angle)` being the stats primary key — the
 * chosen row is unique and plan-independent, so parallelism cannot change the
 * result set. The web path keeps the guard because it shares a ten-connection
 * pool with live traffic; this job owns its single connection.
 */
async function buildGroup(db: SerialPlanDb, group: ClimbConfigGroup): Promise<BuiltGroup> {
  const rows = await buildTier2ClimbQuery(db, group);

  if (rows.length === MAX_ROWS_PER_GROUP) {
    console.log(
      `::warning title=tier-2 group truncated::${group.boardType}/${group.layoutId} hit its ${MAX_ROWS_PER_GROUP}-row cap — the tail of that group is missing from the sitemap.`,
    );
  }

  let lastModified: Date | null = null;
  const built = rows.map((row) => {
    const rowLastModified = row.climbUpdatedAt > row.statsUpdatedAt ? row.climbUpdatedAt : row.statsUpdatedAt;
    if (!lastModified || rowLastModified > lastModified) {
      lastModified = rowLastModified;
    }
    return {
      climbUuid: row.uuid,
      angle: row.angle,
      climbName: row.name,
      lastModified: rowLastModified,
    };
  });

  return { group, rows: built, lastModified };
}

async function main(): Promise<void> {
  const databaseUrl = getScriptDatabaseUrl();
  console.log(`[sitemap-tier2] target: ${describeDatabaseHost(databaseUrl)}`);
  const { db, close } = createScriptDb(databaseUrl);

  try {
    const fingerprint = tier2PredicateFingerprint(db);
    console.log(`[sitemap-tier2] predicate fingerprint ${fingerprint}`);

    const groups = await resolveGroups(db);
    console.log(`[sitemap-tier2] ${groups.length} winning board configurations`);

    // Reads OUTSIDE any transaction, one group at a time. Sequential is right in
    // a cron: it keeps the connection count at one, and a ~60 s transaction
    // pinning `xmin` would block vacuum on a 2,516 MB `board_climb_stats`. A read
    // failure halfway must not abort a write transaction that already started.
    const startedAt = Date.now();
    const built: BuiltGroup[] = [];
    for (const group of groups) {
      const groupStartedAt = Date.now();
      const result = await buildGroup(db, group);
      built.push(result);
      console.log(
        `[sitemap-tier2] ${group.boardType}/${group.layoutId} size=${group.sizeId} sets=[${group.setIds.join(',')}] → ${result.rows.length} rows in ${Date.now() - groupStartedAt}ms`,
      );
    }
    const scanDurationMs = Date.now() - startedAt;
    const builtTotal = built.reduce((total, group) => total + group.rows.length, 0);

    const previousRows = rowsOf<{ total: string | number | null }>(
      await db.execute(sql`SELECT COALESCE(SUM(item_count), 0) AS total FROM sitemap_tier2_groups`),
    );
    const previousCount = rowsOf<{ count: string | number }>(
      await db.execute(sql`SELECT COUNT(*)::int AS count FROM sitemap_tier2_groups`),
    );
    const hasPrevious = Number(previousCount[0]?.count ?? 0) > 0;
    const previousTotal = hasPrevious ? Number(previousRows[0]?.total ?? 0) : null;

    const plan = planTier2Refresh({ builtTotal, previousTotal });
    if (plan.action === 'abort') {
      // Writes NOTHING. The last good table keeps serving, which is the entire
      // point: a predicate regression that matched zero rows would otherwise swap
      // ~126,500 URLs for an empty sitemap atomically, on a green cron run.
      console.log(
        `::error title=tier-2 refresh aborted::Built ${builtTotal} rows (previous ${previousTotal ?? 'none'}) — ${plan.reason}. Nothing was written; the stored table still serves.`,
      );
      console.error(
        `[sitemap-tier2] aborted: ${plan.reason} (built ${builtTotal}, previous ${previousTotal ?? 'none'})`,
      );
      process.exitCode = 1;
      return;
    }

    const refreshedAt = new Date();
    const groupRows = built.map((entry) => ({
      boardType: entry.group.boardType,
      layoutId: entry.group.layoutId,
      sizeId: entry.group.sizeId,
      setIds: entry.group.setIds,
      itemCount: entry.rows.length,
      lastModified: entry.lastModified,
      predicateFingerprint: fingerprint,
      refreshedAt,
    }));

    const writeStartedAt = Date.now();
    await db.transaction(async (tx) => {
      await tx.delete(sitemapTier2Climbs);
      await tx.delete(sitemapTier2Groups);

      for (const entry of built) {
        // Inserted in primary-key order, so the heap ends up clustered on
        // `(board_type, layout_id, climb_uuid)` — the order the read path scans.
        const values = entry.rows.map((row) => ({
          boardType: entry.group.boardType,
          layoutId: entry.group.layoutId,
          climbUuid: row.climbUuid,
          angle: row.angle,
          climbName: row.climbName,
          lastModified: row.lastModified,
        }));
        for (let index = 0; index < values.length; index += INSERT_CHUNK_ROWS) {
          await tx.insert(sitemapTier2Climbs).values(values.slice(index, index + INSERT_CHUNK_ROWS));
        }
      }

      if (groupRows.length > 0) {
        await tx.insert(sitemapTier2Groups).values(groupRows);
      }
    });

    // Aggregate only — no uuids, no climb names. This log is public in the
    // Actions run.
    console.log(
      `[sitemap-tier2] wrote ${builtTotal} rows across ${groupRows.length} groups (previous ${previousTotal ?? 'none'}); scan ${scanDurationMs}ms, write ${Date.now() - writeStartedAt}ms`,
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.log(
    `::error title=tier-2 refresh failed::${err instanceof Error ? err.message : String(err)} — nothing was written; the stored table still serves.`,
  );
  console.error('[sitemap-tier2] failed:', err);
  process.exit(1);
});
