import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import { SPRAY_SET, SPRAY_SET_IDS } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { dbzRead } from '@/app/lib/db/db';
import { boardClimbs, sprayWalls, userBoards } from '@/app/lib/db/schema';

/**
 * The spray walls whose climbs the CLIMB sitemap may name — SW-16 (#5449).
 *
 * Same shape and the same reason as the MoonBoard leg of
 * `board-config-source.ts`: a spray wall never reaches
 * `getAllBoardConfigsOrThrow()`, so a sitemap that wants its climbs has to ask a
 * second question rather than change what the home rail and the board picker
 * read. The reason differs, though. MoonBoard is missing because nothing writes
 * it a `board_product_sizes_layouts_sets` row; a spray wall IS written one, and
 * that row is deliberately `is_listed = false` (see "Every per-wall catalogue row
 * is `is_listed = false`" in `docs/spray-walls.md`). Both sources are additive,
 * neither narrows the listed configs, and the privacy flag on the catalogue rows
 * stays exactly as it is.
 *
 * What SW-03 excluded and this does NOT bring back: the board TYPE. A wall still
 * gets no `/spray/...` config-tuple URL and no `/list` entry in
 * `/sitemaps/boards.xml`. The only thing that becomes indexable is the climbs of
 * a wall whose owner made it public, at the `/b/{slug}` front door those climbs
 * already self-canonicalise to.
 *
 * Kept in the web sitemap layer for the same reasons as the MoonBoard leg: no
 * backend deploy coupling, and no change to any resolver the app reads.
 */

/** In-process TTL and Data Cache window, matching the MoonBoard leg. */
const SPRAY_REVALIDATE_SECONDS = 3_600;

/**
 * Wall-clock bound on the wall query, matching `MOONBOARD_COUNT_TIMEOUT_MS` for
 * the same reason: `dbzRead`'s pool sets no `statement_timeout` (PgBouncer
 * rejects it as a startup parameter, see `docs/db-connectivity.md`), so an
 * unbounded read here would hold the climbs shard for the whole platform timeout
 * and the single-flight below would make every later caller join the stall.
 *
 * Like `withDeadline` in `shard-registry.ts`, this stops waiting rather than
 * cancelling: the abandoned query still runs and still populates the caches.
 */
const SPRAY_QUERY_TIMEOUT_MS = 10_000;
const SPRAY_TTL_MS = SPRAY_REVALIDATE_SECONDS * 1_000;
const SPRAY_CACHE_TAG = 'sitemap-spray-wall-configs';

/**
 * A wall's config plus the one thing its URLs cannot be built without.
 *
 * `PopularBoardConfig` describes a `(board, layout, size, sets)` tuple, which is
 * exactly the shape `/spray/...` does NOT have a route for
 * (`boardHasDeepConfigRoute`). A wall's climb URLs are `/b/{slug}/...`, so the
 * slug travels with the config and is the marker every downstream indexability
 * check keys on — nothing else in the codebase sets it.
 */
export type SitemapSprayWallConfig = PopularBoardConfig & { sprayWallSlug: string };

/**
 * One row per PUBLIC, published, slugged wall, with its listed climb count.
 *
 * Every predicate is load-bearing, and all four say the same thing from a
 * different angle — "somebody other than the owner is meant to see this":
 *
 *  - `is_public` is the owner's own decision and the only consent that exists.
 *    `is_unlisted` is deliberately not an escape hatch: unlisted means
 *    "reachable if you have the link", and a sitemap is the opposite of a link
 *    you were given. Same call `sprayClimbVisibilityCondition` makes.
 *  - `current_version_id IS NOT NULL` drops a wall whose first photo is still a
 *    draft. It has no published holds, so nobody but its owner can set on it and
 *    there is nothing behind the URL — the rule SW-14 wrote for the app, applied
 *    to the crawler.
 *  - both soft-delete columns, because a deleted wall's rows stay in the table.
 *  - a slug, because `constructBoardSlugViewUrl` has nothing to build from
 *    without one. The column is `NOT NULL` today; the predicate is what keeps
 *    this source honest if that ever relaxes, and it costs nothing.
 *
 * The count is the same gate MoonBoard uses — listed, non-draft, non-hidden — and
 * is used the same way, as a `> 0` boolean rather than a prediction of how many
 * URLs ship. A LEFT JOIN plus `count(uuid)` rather than a correlated subquery so
 * a wall with no climbs comes back as 0 instead of vanishing.
 *
 * Split out as a builder so a test can render the real SQL with `.toSQL()`
 * instead of grepping this file for the predicate it hopes is there.
 */
export function buildPublicSprayWallQuery(db: typeof dbzRead) {
  return db
    .select({
      layoutId: sprayWalls.layoutId,
      sprayWallSlug: userBoards.slug,
      wallName: userBoards.name,
      // The wall's fixed angle. Not what builds a URL — the angle segment comes
      // from the per-climb `publishedAngleOrderBy` pick, the same as every other
      // board — but it is the wall's identity and it is what a mismatch would be
      // read against when one of these URLs looks wrong.
      wallAngle: userBoards.angle,
      climbCount: count(boardClimbs.uuid),
    })
    .from(sprayWalls)
    .innerJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
    .leftJoin(
      boardClimbs,
      and(
        eq(boardClimbs.boardType, 'spray'),
        eq(boardClimbs.layoutId, sprayWalls.layoutId),
        eq(boardClimbs.isListed, true),
        eq(boardClimbs.isDraft, false),
        eq(boardClimbs.isHidden, false),
      ),
    )
    .where(
      and(
        eq(userBoards.boardType, 'spray'),
        eq(userBoards.isPublic, true),
        isNotNull(userBoards.slug),
        // `IS NULL`, not a boolean column: both tables soft-delete, so the rows
        // of a deleted wall are still here to be selected.
        isNull(userBoards.deletedAt),
        isNull(sprayWalls.deletedAt),
        isNotNull(sprayWalls.currentVersionId),
      ),
    )
    .groupBy(sprayWalls.layoutId, userBoards.slug, userBoards.name, userBoards.angle);
}

async function fetchPublicSprayWallConfigs(): Promise<SitemapSprayWallConfig[]> {
  const rows = await buildPublicSprayWallQuery(dbzRead);

  const configs: SitemapSprayWallConfig[] = [];
  for (const row of rows) {
    const climbCount = Number(row.climbCount);
    // A wall with nothing set on it is dropped rather than shipped with a zero
    // count: `resolveClimbSitemapGroups` would skip it anyway, and leaving it in
    // means a future caller has to know that.
    if (climbCount <= 0) continue;
    if (!row.sprayWallSlug) continue;

    configs.push({
      boardType: 'spray',
      layoutId: row.layoutId,
      // A wall IS its layout, and its size id equals its layout id
      // (`spraySizeIdForLayout`). Both fields hold the same number on purpose.
      layoutName: row.wallName,
      sizeId: row.layoutId,
      sizeName: row.wallName,
      sizeDescription: row.wallName,
      setIds: [...SPRAY_SET_IDS],
      setNames: [SPRAY_SET.name],
      climbCount,
      // Not measured here, and read by nothing: `isBetterConfig` only ranks
      // candidates within one `boardType:layoutId` group and a wall is the only
      // candidate in its own. A number invented to fill the field would show up
      // in that ranking as if it meant something.
      totalAscents: 0,
      // Unlike MoonBoard's `0`, there genuinely is one physical wall behind this.
      boardCount: 1,
      displayName: row.wallName,
      sprayWallSlug: row.sprayWallSlug,
    });
  }

  return configs;
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms budget`)), ms);
    }),
  ]);
}

const cachedPublicSprayWallConfigs = unstable_cache(fetchPublicSprayWallConfigs, ['sitemap-spray-wall-configs'], {
  revalidate: SPRAY_REVALIDATE_SECONDS,
  tags: [SPRAY_CACHE_TAG],
});

let cachedConfigs: { builtAt: number; configs: SitemapSprayWallConfig[] } | null = null;
let configsInFlight: Promise<SitemapSprayWallConfig[]> | null = null;

/**
 * The public walls, behind the same two layers the MoonBoard leg uses: the Data
 * Cache for cross-instance freshness, an in-process TTL and single-flight in
 * front of it because `unstable_cache` does not deduplicate concurrent misses and
 * one cold crawl reaches this from the climbs summary and the item build at the
 * same moment.
 */
export async function getPublicSprayWallConfigs(): Promise<SitemapSprayWallConfig[]> {
  if (cachedConfigs && Date.now() - cachedConfigs.builtAt < SPRAY_TTL_MS) {
    return cachedConfigs.configs;
  }
  if (configsInFlight) {
    return configsInFlight;
  }

  // The timeout is INSIDE the shared promise on purpose: a rejection then flows
  // through the same path a query error does, so it is not memoised, every
  // concurrent caller sees it, and the next caller retries instead of joining a
  // stall that already gave up.
  const build = withTimeout(
    cachedPublicSprayWallConfigs(),
    SPRAY_QUERY_TIMEOUT_MS,
    '[sitemap] public spray wall query',
  ).then((configs) => {
    cachedConfigs = { builtAt: Date.now(), configs };
    return configs;
  });
  configsInFlight = build;

  try {
    return await build;
  } finally {
    configsInFlight = null;
  }
}

/** Test seam: drops the in-process TTL cache and any in-flight fetch. */
export function resetSprayWallConfigCacheForTests(): void {
  cachedConfigs = null;
  configsInFlight = null;
}
