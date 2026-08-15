import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, asc, desc, eq, gte, inArray, notExists, sql } from 'drizzle-orm';
import { ANGLES, toBoardName } from '@boardsesh/board-config';
import { withSerialPlan, type SerialPlanDb } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { boardClimbAliases, boardClimbStats, boardClimbs } from '@/app/lib/db/schema';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import {
  climbRowsToItems,
  resolveClimbSitemapGroups,
  type ClimbConfigGroup,
  type ClimbSitemapRow,
} from './climb-entries';
import type { SitemapItem } from './entries';

/**
 * Tier 2 is the slice of the catalogue worth a crawl budget: a climb people have
 * actually done. Tier 3 (every listed climb) is deliberately NOT submitted until
 * Search Console shows healthy tier-2 coverage.
 */
export const TIER_2_MIN_ASCENTS = 10;

/**
 * Per-group safety cap. Not a tuning knob — it exists so one pathological group
 * cannot pull an unbounded result set into memory. Hitting it means the shard is
 * silently losing its tail, so it warns rather than truncating quietly.
 */
export const MAX_ROWS_PER_GROUP = 250_000;

/** In-process TTL for the full item list; matches the shard's CDN freshness window. */
const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
/** Next Data Cache window for the (small) summary the index reads on every hit. */
const SUMMARY_REVALIDATE_SECONDS = 21_600;
const SUMMARY_CACHE_TAG = 'sitemap-climbs';

export type Tier2Summary = { itemCount: number; lastModified: Date | null };

function setIdArray(setIds: readonly number[]) {
  return sql`ARRAY[${sql.join(
    setIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * The tier-2 selection for one board configuration, one row per climb.
 *
 * `DISTINCT ON (climb_uuid)` keeps the angle with the most ascents. Other angles
 * of the same climb stay self-canonical and reachable through W-15's angle
 * cross-links — they are just not submitted, because submitting fifteen URLs per
 * climb spends the crawl budget on near-duplicates.
 *
 * Three raw `sql` fragments, all of them things Drizzle has no operator for and
 * all of them copied from the predicate the `/list` front door already runs
 * (`create-climb-filters.ts`): the `@>` size containment, the `<@` set
 * containment, and the `COALESCE(...)` angle tie-break.
 */
function buildChosenSubquery(db: SerialPlanDb, group: ClimbConfigGroup) {
  const boardName = toBoardName(group.boardType);
  if (!boardName) {
    throw new Error(`[sitemap] climbs shard: unknown board type "${group.boardType}"`);
  }
  const isMoonboard = boardName === 'moonboard';

  return db
    .selectDistinctOn([boardClimbStats.climbUuid], {
      uuid: boardClimbStats.climbUuid,
      angle: boardClimbStats.angle,
      name: boardClimbs.name,
      updatedAt: boardClimbStats.updatedAt,
    })
    .from(boardClimbStats)
    .innerJoin(
      boardClimbs,
      and(eq(boardClimbs.uuid, boardClimbStats.climbUuid), eq(boardClimbs.boardType, boardClimbStats.boardType)),
    )
    .where(
      and(
        eq(boardClimbs.boardType, group.boardType),
        eq(boardClimbs.layoutId, group.layoutId),
        eq(boardClimbs.isListed, true),
        eq(boardClimbs.isDraft, false),
        gte(boardClimbStats.ascensionistCount, TIER_2_MIN_ASCENTS),
        // Never publish an angle the route tables don't carry — that URL 404s.
        inArray(boardClimbStats.angle, [...ANGLES[boardName]]),
        // The same two predicates the /list front door filters on, so the climb
        // genuinely renders on the configuration we are about to name in its URL.
        // MoonBoard has one fixed size, so it has no size predicate at all.
        ...(isMoonboard ? [] : [sql`${boardClimbs.compatibleSizeIds} @> ARRAY[${group.sizeId}]::int[]`]),
        ...(group.setIds.length === 0
          ? []
          : [
              isMoonboard
                ? sql`(${boardClimbs.requiredSetIds} IS NULL OR ${boardClimbs.requiredSetIds} <@ ${setIdArray(group.setIds)})`
                : sql`${boardClimbs.requiredSetIds} <@ ${setIdArray(group.setIds)}`,
            ]),
        // An alias uuid keeps its own URL and self-canonicalises there, so
        // submitting both forms is duplicate content by construction.
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(boardClimbAliases)
            .where(
              and(
                eq(boardClimbAliases.boardType, boardClimbs.boardType),
                eq(boardClimbAliases.aliasUuid, boardClimbs.uuid),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      boardClimbStats.climbUuid,
      desc(boardClimbStats.ascensionistCount),
      // COALESCE, not a bare comparison: `board_climbs.angle` is nullable and
      // Postgres orders DESC with NULLS FIRST, so a climb with no recorded angle
      // would outrank the angle that actually matches.
      desc(sql`COALESCE(${boardClimbStats.angle} = ${boardClimbs.angle}, false)`),
      asc(boardClimbStats.angle),
    )
    .as('chosen');
}

/**
 * Split out from the fetch so a test can render this query's real SQL with
 * `.toSQL()` instead of grepping the source for the predicate it hopes is there.
 */
export function buildTier2ClimbQuery(db: SerialPlanDb, group: ClimbConfigGroup, limit = MAX_ROWS_PER_GROUP) {
  const chosen = buildChosenSubquery(db, group);
  return db.select().from(chosen).orderBy(asc(chosen.uuid)).limit(limit);
}

/** The count and freshness of exactly what `buildTier2ClimbQuery` would return. */
export function buildTier2ClimbSummaryQuery(db: SerialPlanDb, group: ClimbConfigGroup) {
  const chosen = buildChosenSubquery(db, group);
  return db
    .select({
      itemCount: sql<number>`count(*)::int`,
      lastModified: sql<string | null>`max(${chosen.updatedAt})`,
    })
    .from(chosen);
}

export async function fetchTier2ClimbRows(group: ClimbConfigGroup): Promise<ClimbSitemapRow[]> {
  const rows = await withSerialPlan(dbzRead, async (tx) => buildTier2ClimbQuery(tx, group));

  if (rows.length === MAX_ROWS_PER_GROUP) {
    console.warn(
      `[sitemap] climbs group ${group.boardType}/${group.layoutId} hit its ${MAX_ROWS_PER_GROUP}-row cap — the tail is missing.`,
    );
  }

  return rows.map((row) => ({
    uuid: row.uuid,
    name: row.name,
    angle: row.angle,
    updatedAt: row.updatedAt,
  }));
}

/**
 * `unstable_cache`d, and only the summary is: a 128k-item payload serialises to
 * ~20 MB, past Vercel's 2 MB Data Cache entry ceiling, so caching the items
 * there would silently never cache. The summary is two numbers.
 *
 * Dates do not survive the Data Cache intact, so the ISO string is what gets
 * stored and the public wrapper rehydrates it.
 */
const cachedTier2Summary = unstable_cache(
  async (): Promise<{ itemCount: number; lastModifiedIso: string | null }> => {
    const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());

    let itemCount = 0;
    let lastModified: Date | null = null;

    // Sequential, never Promise.all: a fan-out of concurrent heavy scans is the
    // pool starvation #4461 describes, on a pool of 10.
    for (const group of groups) {
      const [summary] = await withSerialPlan(dbzRead, async (tx) => buildTier2ClimbSummaryQuery(tx, group));
      if (!summary) continue;
      itemCount += summary.itemCount;
      const groupLatest = summary.lastModified ? new Date(summary.lastModified) : null;
      if (groupLatest && (!lastModified || groupLatest > lastModified)) {
        lastModified = groupLatest;
      }
    }

    return { itemCount, lastModifiedIso: lastModified ? lastModified.toISOString() : null };
  },
  ['sitemap-climbs-summary'],
  { revalidate: SUMMARY_REVALIDATE_SECONDS, tags: [SUMMARY_CACHE_TAG] },
);

export async function fetchTier2Summary(): Promise<Tier2Summary> {
  const { itemCount, lastModifiedIso } = await cachedTier2Summary();
  return { itemCount, lastModified: lastModifiedIso ? new Date(lastModifiedIso) : null };
}

let cachedItems: { builtAt: number; items: SitemapItem[] } | null = null;
let inFlight: Promise<SitemapItem[]> | null = null;

async function buildAllTier2Items(): Promise<SitemapItem[]> {
  const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());
  const items: SitemapItem[] = [];
  let dropped = 0;

  // Sequential, for the same pool reason as the summary.
  for (const group of groups) {
    const built = climbRowsToItems(await fetchTier2ClimbRows(group), group);
    for (const item of built.items) {
      items.push(item);
    }
    dropped += built.dropped;
  }

  if (dropped > 0) {
    // Should be zero: unresolvable configurations are filtered out a group at a
    // time. A non-zero count means a climb was dropped rather than published
    // under a URL we cannot prove matches its own canonical.
    console.warn(`[sitemap] climbs shard dropped ${dropped} climbs with no resolvable canonical URL.`);
  }

  return items;
}

/**
 * The full ordered item list, behind a 6-hour TTL and a single-flight promise.
 *
 * One in-flight build per instance is the point: a crawl burst across N shard
 * pages on a cold instance would otherwise run N full scans against a
 * ten-connection pool while the front door waits behind them.
 */
export async function buildTier2ClimbItems(): Promise<SitemapItem[]> {
  if (cachedItems && Date.now() - cachedItems.builtAt < ITEMS_TTL_MS) {
    return cachedItems.items;
  }
  if (inFlight) {
    return inFlight;
  }

  const build = buildAllTier2Items().then((items) => {
    cachedItems = { builtAt: Date.now(), items };
    return items;
  });
  inFlight = build;

  try {
    return await build;
  } finally {
    inFlight = null;
  }
}

/** Test seam: drops the in-process TTL cache. */
export function resetTier2ItemCacheForTests(): void {
  cachedItems = null;
  inFlight = null;
}
