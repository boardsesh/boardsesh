import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, count, eq } from 'drizzle-orm';
import { getDefaultRenderBoard } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { dbzRead } from '@/app/lib/db/db';
import { boardClimbs } from '@/app/lib/db/schema';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE, type MoonBoardLayoutKey } from '@/app/lib/moonboard-config';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';

/**
 * The board configurations the SITEMAP builds URLs from — deliberately a
 * different question from the one `popularBoardConfigs` answers.
 *
 * `getAllBoardConfigsOrThrow` asks "which board pages are worth building", and
 * its answer comes from `board_product_sizes_layouts_sets`: the Aurora sync
 * tables. That is the right universe for the home rail and the mobile board
 * picker, and it is why MoonBoard has never appeared in a sitemap — nothing
 * writes a psls row for it. The only writers are the Aurora importers, and no
 * migration seeds one. MoonBoard was not ranked out; it was never a candidate.
 *
 * The sitemap's question is "which climbs are worth indexing", and MoonBoard is
 * the largest board in the addressable set. Its configuration is not in the
 * database at all — it is the static `MOONBOARD_LAYOUTS` / `MOONBOARD_SETS`
 * tables that `getDefaultRenderBoard` already resolves for every renderer we
 * ship — so this module answers the sitemap's question by adding those seven
 * layouts to the listed configs rather than by changing what
 * `popularBoardConfigs` returns.
 *
 * Kept in the web sitemap layer on purpose: no backend deploy coupling, and no
 * change to the resolver the mobile board picker and the www home rail read.
 */

/** In-process TTL and Data Cache window, matching `getAllBoardConfigsOrThrow`. */
const MOONBOARD_REVALIDATE_SECONDS = 3_600;
const MOONBOARD_TTL_MS = MOONBOARD_REVALIDATE_SECONDS * 1_000;
const MOONBOARD_CACHE_TAG = 'sitemap-moonboard-climb-counts';

/**
 * MoonBoard's catalogue is code, not data: adding a layout or a hold set means
 * editing `MOONBOARD_LAYOUTS` / `MOONBOARD_SETS` in
 * `@boardsesh/board-config`, and until that lands the new layout has no sitemap
 * entry and no board art. Two test files pin the tuples as literals so the edit
 * cannot be half-done — `__tests__/board-config-source.test.ts` and
 * `__tests__/moonboard-canonical-identity.test.ts`. Both go red on a new layout
 * and both want updating in the same change.
 */
const MOONBOARD_LAYOUT_KEYS = Object.keys(MOONBOARD_LAYOUTS) as MoonBoardLayoutKey[];

/**
 * Listed, non-draft MoonBoard climbs per layout.
 *
 * A plain grouped count, NOT the tier-2 `DISTINCT ON` scan the climbs shard
 * runs. Both shards use this number only as a `> 0` gate — `board-entries.ts`
 * skips a config with no listed climbs as a thin page, `climb-entries.ts` skips
 * the group entirely — and making the boards shard pay the climbs shard's cost
 * budget for a boolean is the wrong trade. The tier-2 count that decides how
 * many URLs actually ship is computed downstream, where it is already paid for.
 */
export function buildMoonBoardClimbCountQuery(db: typeof dbzRead) {
  return db
    .select({ layoutId: boardClimbs.layoutId, climbCount: count() })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, 'moonboard'), eq(boardClimbs.isListed, true), eq(boardClimbs.isDraft, false)))
    .groupBy(boardClimbs.layoutId);
}

async function fetchMoonBoardClimbCounts(): Promise<Map<number, number>> {
  const rows = await buildMoonBoardClimbCountQuery(dbzRead);

  const countsByLayout = new Map<number, number>();
  for (const row of rows) {
    if (row.layoutId == null) continue;
    countsByLayout.set(row.layoutId, Number(row.climbCount));
  }
  return countsByLayout;
}

/** Data Cache stores plain JSON, so the Map is rebuilt on the way out. */
const cachedMoonBoardClimbCounts = unstable_cache(
  async (): Promise<[number, number][]> => [...(await fetchMoonBoardClimbCounts()).entries()],
  ['sitemap-moonboard-climb-counts'],
  { revalidate: MOONBOARD_REVALIDATE_SECONDS, tags: [MOONBOARD_CACHE_TAG] },
);

let cachedCounts: { builtAt: number; countsByLayout: Map<number, number> } | null = null;
let countsInFlight: Promise<Map<number, number>> | null = null;

/**
 * Same two-layer shape as `getAllBoardConfigsOrThrow`: the Data Cache for
 * cross-instance freshness, an in-process TTL and single-flight in front of it
 * because `unstable_cache` does not deduplicate concurrent misses and one cold
 * `/sitemap.xml` reaches this from the boards shard and the climbs summary at
 * the same moment.
 */
async function getMoonBoardClimbCounts(): Promise<Map<number, number>> {
  if (cachedCounts && Date.now() - cachedCounts.builtAt < MOONBOARD_TTL_MS) {
    return cachedCounts.countsByLayout;
  }
  if (countsInFlight) {
    return countsInFlight;
  }

  const build = cachedMoonBoardClimbCounts().then((entries) => {
    const countsByLayout = new Map(entries);
    cachedCounts = { builtAt: Date.now(), countsByLayout };
    return countsByLayout;
  });
  countsInFlight = build;

  try {
    return await build;
  } finally {
    countsInFlight = null;
  }
}

/**
 * One config per MoonBoard layout: the layout's single size with every hold set
 * installed, which is what `getDefaultRenderBoard` already returns for MoonBoard
 * and what every MoonBoard board render in the app uses.
 *
 * `boardCount: 0` is honest — there is no `user_boards` row shape behind these —
 * and it also keeps them last under `isBetterConfig`'s ordering, so adding them
 * cannot reorder or displace any Aurora group.
 *
 * A layout with no listed climbs is dropped rather than shipped with a zero
 * count: both shards would skip it anyway, and leaving it in means a future
 * caller has to know that.
 */
function buildMoonBoardConfigs(countsByLayout: Map<number, number>): PopularBoardConfig[] {
  const configs: PopularBoardConfig[] = [];

  for (const layoutKey of MOONBOARD_LAYOUT_KEYS) {
    const layout = MOONBOARD_LAYOUTS[layoutKey];
    const climbCount = countsByLayout.get(layout.id) ?? 0;
    if (climbCount <= 0) continue;

    const renderBoard = getDefaultRenderBoard('moonboard', layout.id);
    if (!renderBoard) continue;

    configs.push({
      boardType: 'moonboard',
      layoutId: renderBoard.layoutId,
      layoutName: layout.name,
      sizeId: renderBoard.sizeId,
      sizeName: MOONBOARD_SIZE.name,
      sizeDescription: MOONBOARD_SIZE.description,
      setIds: renderBoard.setIds,
      setNames: MOONBOARD_SETS[layoutKey].filter((set) => renderBoard.setIds.includes(set.id)).map((set) => set.name),
      climbCount,
      // Not measured here, and not read by either shard. A number invented to
      // fill the field would show up in `isBetterConfig`'s ranking as if it
      // meant something.
      totalAscents: 0,
      boardCount: 0,
      displayName: layout.name,
    });
  }

  return configs;
}

/**
 * Every board configuration the sitemap shards build URLs from.
 *
 * Throws for the same reason `getAllBoardConfigsOrThrow` does: a sitemap that
 * quietly loses its URLs tells Google those pages were deleted, so the route
 * turns a throw into a 503 and the crawler keeps its last good copy.
 */
export async function getSitemapBoardConfigsOrThrow(): Promise<PopularBoardConfig[]> {
  const [listedConfigs, moonBoardCounts] = await Promise.all([getAllBoardConfigsOrThrow(), getMoonBoardClimbCounts()]);

  return [...listedConfigs, ...buildMoonBoardConfigs(moonBoardCounts)];
}

/** Test seam: drops the in-process TTL cache and any in-flight fetch. */
export function resetSitemapBoardConfigCacheForTests(): void {
  cachedCounts = null;
  countsInFlight = null;
}
