import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, eq, exists, sql } from 'drizzle-orm';
import { getDefaultRenderBoard } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { dbzRead } from '@/app/lib/db/db';
import { boardClimbs } from '@/app/lib/db/schema';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE, type MoonBoardLayoutKey } from '@/app/lib/moonboard-config';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { withTimeout } from './with-timeout';
import type { SitemapClimbConfig } from './climb-entries';
import { getPublicSprayWallConfigs } from './spray-wall-configs';

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

/**
 * In-process TTL and Data Cache window: 6 h, the same window the setter and
 * climbs shards use. The answer is "does this layout have a listed climb",
 * which changes when a whole MoonBoard layout is imported or emptied, not when
 * one climb is.
 */
const MOONBOARD_REVALIDATE_SECONDS = 21_600;

/**
 * Wall-clock bound on the layout-gate query, matching the `SITEMAP_FETCH_TIMEOUT_MS`
 * the listed-config fetch gives its own `AbortController`.
 *
 * `shardRouteHandler` is documented "deliberately unbounded" on the grounds that
 * `getAllBoardConfigsOrThrow` budgets itself 10 s. This leg runs in parallel with
 * it and had no bound at any layer: `dbzRead`'s pool sets `connect_timeout: 30`
 * and `statement_timeout` is off by default (PgBouncer rejects it as a startup
 * parameter — see docs/db-connectivity.md), so a stalled read would have held the
 * boards shard for the whole platform timeout, and the single-flight would have
 * made every later caller join the stall. Measured cost of the query itself on
 * the prod replica: 0.17 ms and 28 buffers, so 10 s is a tail bound and not a
 * budget anything is expected to spend.
 *
 * Like `withDeadline` in `shard-registry.ts`, this stops waiting rather than
 * cancelling: the abandoned query keeps running and will populate the caches for
 * whoever asks next.
 */
const MOONBOARD_GATE_TIMEOUT_MS = 10_000;
const MOONBOARD_TTL_MS = MOONBOARD_REVALIDATE_SECONDS * 1_000;
const MOONBOARD_CACHE_TAG = 'sitemap-moonboard-listed-layouts';

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
 * The MoonBoard layouts that have at least one listed, non-draft, non-hidden
 * climb.
 *
 * Both shards use this only as a gate — `board-entries.ts` skips a config with
 * no listed climbs as a thin page, `climb-entries.ts` skips the group entirely —
 * so it asks exactly that: one `EXISTS` per known layout, each answered by the
 * first matching row of `board_climbs_layout_filter_idx`. It used to be a
 * grouped `count(*)` over every MoonBoard row. On the prod replica that was a
 * bitmap heap scan of 287k rows, 224.8 ms and 34,956 buffers (~270 MB of
 * shared_buffers churn) per call; this is 0.17 ms and 28 buffers, for the same
 * seven layouts. The tier-2 count that decides how many URLs actually ship is
 * computed downstream, where it is already paid for.
 *
 * `is_hidden` is part of the gate, not a refinement of it: the climbs shard
 * already drops community-hidden climbs, so a layout whose only listed climbs
 * have been hidden would otherwise keep its board URL in the sitemap while
 * every climb URL under it disappeared — a thin page submitted to Google.
 */
export function buildMoonBoardListedLayoutsQuery(db: typeof dbzRead, layoutIds: readonly number[]) {
  const layoutId = sql<number>`layout_ids.layout_id`;
  const layoutIdList = sql.join(
    layoutIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return db
    .select({ layoutId })
    .from(sql`unnest(ARRAY[${layoutIdList}]::int[]) AS layout_ids(layout_id)`)
    .where(
      exists(
        db
          .select({ present: sql`1` })
          .from(boardClimbs)
          .where(
            and(
              eq(boardClimbs.boardType, 'moonboard'),
              eq(boardClimbs.layoutId, layoutId),
              eq(boardClimbs.isListed, true),
              eq(boardClimbs.isDraft, false),
              eq(boardClimbs.isHidden, false),
            ),
          ),
      ),
    );
}

const MOONBOARD_LAYOUT_IDS = MOONBOARD_LAYOUT_KEYS.map((layoutKey) => MOONBOARD_LAYOUTS[layoutKey].id);

async function fetchMoonBoardListedLayoutIds(): Promise<number[]> {
  const rows = await buildMoonBoardListedLayoutsQuery(dbzRead, MOONBOARD_LAYOUT_IDS);
  return rows.map((row) => Number(row.layoutId));
}

/** Data Cache stores plain JSON, so the Set is rebuilt on the way out. */
const cachedMoonBoardListedLayoutIds = unstable_cache(
  fetchMoonBoardListedLayoutIds,
  ['sitemap-moonboard-listed-layouts'],
  {
    revalidate: MOONBOARD_REVALIDATE_SECONDS,
    tags: [MOONBOARD_CACHE_TAG],
  },
);

let cachedLayouts: { builtAt: number; listedLayoutIds: Set<number> } | null = null;
let layoutsInFlight: Promise<Set<number>> | null = null;

/**
 * Same two-layer shape as `getAllBoardConfigsOrThrow`: the Data Cache for
 * cross-instance freshness, an in-process TTL and single-flight in front of it
 * because `unstable_cache` does not deduplicate concurrent misses and one cold
 * `/sitemap.xml` reaches this from the boards shard and the climbs summary at
 * the same moment.
 */
async function getMoonBoardListedLayoutIds(): Promise<Set<number>> {
  if (cachedLayouts && Date.now() - cachedLayouts.builtAt < MOONBOARD_TTL_MS) {
    return cachedLayouts.listedLayoutIds;
  }
  if (layoutsInFlight) {
    return layoutsInFlight;
  }

  // The timeout is INSIDE the shared promise on purpose: a rejection then flows
  // through the same path a query error does, so it is not memoised, every
  // concurrent caller sees it, and the next caller retries instead of joining a
  // stall that already gave up.
  const build = withTimeout(
    cachedMoonBoardListedLayoutIds(),
    MOONBOARD_GATE_TIMEOUT_MS,
    '[sitemap] MoonBoard listed-layout query',
  ).then((layoutIds) => {
    const listedLayoutIds = new Set(layoutIds);
    cachedLayouts = { builtAt: Date.now(), listedLayoutIds };
    return listedLayoutIds;
  });
  layoutsInFlight = build;

  try {
    return await build;
  } finally {
    layoutsInFlight = null;
  }
}

/**
 * One config per MoonBoard layout: the layout's single size with every hold set
 * installed, which is what `getDefaultRenderBoard` already returns for MoonBoard
 * and what every MoonBoard board render in the app uses.
 *
 * `boardCount: 0` is honest — there is no `user_boards` row shape behind these.
 * It buys nothing in ordering, and the source is **additive in content, not in
 * ordinal**: `isBetterConfig` only ranks candidates WITHIN one
 * `boardType:layoutId` group, and cross-group order comes from the lexicographic
 * `boardType` sort at the end of `resolveClimbSitemapGroups`, where `moonboard`
 * lands between `kilter` and `soill`. So every Tension/Soill/Touchstone URL
 * shifts by the MoonBoard row count and changes page in `sitemap_climb_urls`.
 * That is a catalogue change, which is what `ordinal` is allowed to move for —
 * see the "Adding a board also moves `ordinal`" note in `docs/sitemap.md`.
 *
 * A layout with no listed climbs is dropped rather than shipped with a zero
 * count: both shards would skip it anyway, and leaving it in means a future
 * caller has to know that.
 *
 * `climbCount: 1` is a presence flag, not a count. Both shards read it only as
 * a `> 0` gate, and `isBetterConfig` never compares two MoonBoard candidates
 * because there is exactly one per layout group — an invariant
 * `withMoonBoardConfigs` enforces rather than assumes.
 */
function buildMoonBoardConfigs(listedLayoutIds: Set<number>): PopularBoardConfig[] {
  const configs: PopularBoardConfig[] = [];

  for (const layoutKey of MOONBOARD_LAYOUT_KEYS) {
    const layout = MOONBOARD_LAYOUTS[layoutKey];
    if (!listedLayoutIds.has(layout.id)) continue;

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
      climbCount: 1,
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
 * The listed configs plus the MoonBoard ones, refusing any second candidate for
 * a MoonBoard layout group.
 *
 * The MoonBoard configs carry `climbCount: 1` as a presence flag, and
 * `isBetterConfig` ranks candidates within a `boardType:layoutId` group by
 * `climbCount` first. A second candidate for the same group — a psls row for
 * MoonBoard from a future importer, or two `MOONBOARD_LAYOUTS` keys sharing an
 * id — would be ranked against that flag as if it were a count and win or lose
 * for no real reason. Throwing makes that change fail loudly in its own PR
 * instead of silently reordering the sitemap.
 */
function withMoonBoardConfigs(
  listedConfigs: PopularBoardConfig[],
  moonBoardLayoutIds: Set<number>,
): PopularBoardConfig[] {
  const combined = [...listedConfigs, ...buildMoonBoardConfigs(moonBoardLayoutIds)];
  const seenMoonBoardLayouts = new Set<number>();
  for (const config of combined) {
    if (config.boardType !== 'moonboard') continue;
    if (seenMoonBoardLayouts.has(config.layoutId)) {
      throw new Error(
        `[sitemap] two configs for moonboard layout ${config.layoutId}: the static MoonBoard config's climbCount is a presence flag and cannot be ranked against another candidate`,
      );
    }
    seenMoonBoardLayouts.add(config.layoutId);
  }
  return combined;
}

/**
 * Every board configuration the CLIMB shards build URLs from.
 *
 * Strict on both legs, and it has to be. The climbs shard resolves its groups
 * twice per crawl — once for the summary the index sizes pages from, once for
 * the item build — and `pagedShardRouteHandler` throws "cache epochs disagree"
 * the moment those two see different group sets. A MoonBoard count that failed
 * for one and succeeded for the other is exactly that disagreement, so a failure
 * has to fail the whole thing: the route turns the throw into a 503 and the
 * crawler keeps its last good copy, which is what `getAllBoardConfigsOrThrow`
 * already does for the same reason.
 */
export async function getSitemapClimbConfigsOrThrow(): Promise<SitemapClimbConfig[]> {
  const [listedConfigs, moonBoardLayoutIds, sprayWallConfigs] = await Promise.all([
    getAllBoardConfigsOrThrow(),
    getMoonBoardListedLayoutIds(),
    // Strict for exactly the reason above, and its own cache makes it more
    // likely rather than less: the walls sit behind a separate `unstable_cache`
    // entry with its own revalidate clock, so the summary pass and the item pass
    // can land on different sides of one expiry. Swallowing a failure here would
    // turn that into a silently shorter sitemap on one pass and "cache epochs
    // disagree" on the next; throwing turns it into a 503 and the crawler keeps
    // its last good copy.
    getPublicSprayWallConfigs(),
  ]);

  return [...withMoonBoardConfigs(listedConfigs, moonBoardLayoutIds), ...sprayWallConfigs];
}

/**
 * The same configurations for `/sitemaps/boards.xml`, with the MoonBoard leg
 * allowed to fail.
 *
 * Different question, different fail policy. The boards shard has no second
 * builder to disagree with, and the arithmetic is lopsided: MoonBoard
 * contributes 8 of its 668 items on the dev image, while the listed configs
 * contribute 660. Before this module existed no database failure could reach
 * that shard at all — it was a GraphQL fetch behind a backend Redis cache with a
 * one-year TTL — so making 660 working Kilter/Tension/Decoy URLs 503 for an hour
 * because the MoonBoard gate timed out would be a strict regression bought with
 * nothing.
 *
 * A failed listed fetch still throws. That is the leg whose loss would tell
 * Google the boards were deleted.
 *
 * No spray leg at all, and that is not an oversight: a spray wall has no
 * `/b/{slug}/{angle}/list` surface on www, so there is no boards-shard URL to
 * emit for one. SW-16 made a wall's CLIMBS indexable, not the wall's own page.
 */
export async function getBoardsShardConfigsOrThrow(): Promise<PopularBoardConfig[]> {
  const [listedConfigs, moonBoardLayoutIds] = await Promise.all([
    getAllBoardConfigsOrThrow(),
    getMoonBoardListedLayoutIds().catch((err: unknown) => {
      console.error(
        '[sitemap] boards shard: MoonBoard listed layouts unavailable, serving the listed configs without them:',
        err instanceof Error ? err.message : err,
      );
      return new Set<number>();
    }),
  ]);

  return withMoonBoardConfigs(listedConfigs, moonBoardLayoutIds);
}

/** Test seam: drops the in-process TTL cache and any in-flight fetch. */
export function resetSitemapBoardConfigCacheForTests(): void {
  cachedLayouts = null;
  layoutsInFlight = null;
}
