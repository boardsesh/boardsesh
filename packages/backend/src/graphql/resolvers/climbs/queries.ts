import { createHash } from 'crypto';
import { storedWoodsSizeId } from './woods-authoring';
import { eq, and, gt, asc, inArray, sql } from 'drizzle-orm';
import {
  type CheckMoonBoardClimbDuplicatesInput,
  type ClimbSearchInput,
  type ConnectionContext,
  type HoldStat,
  type SetterStat,
  type SetterStatsInput,
  type SimilarClimb,
  type SimilarClimbsInput,
  SUPPORTED_BOARDS,
  USER_SPECIFIC_SEARCH_PARAMS,
} from '@boardsesh/shared-schema';
import type { BoardName } from '@boardsesh/board-constants';
import { getGradeLabel, getHoldHeatmapData, getMaterializedSimilarClimbs, getSetterStats } from '@boardsesh/db/queries';
import { logger } from '../../../utils/logger';
import {
  type ClimbSearchParams,
  type ParsedBoardRouteParameters,
  getClimbByUuid,
  mapSearchInputToParams,
} from '../../../db/queries/climbs/index';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { isSprayBoardType, sprayLayoutIsReadable, sprayLayoutIsReadableWithCapability } from './spray-read-access';
import { findMoonBoardDuplicateMatches } from './moonboard-duplicates';
import { parseFramesToHoldEntries, type NormalizedHold } from './climb-similarity';
import { findSimilarClimbsCached } from './similar-climbs-cache';
import { isPopularPageCacheable } from './popular-page-cache';
import { hasCatalogQueryAccess, requireCatalogQueryAccess } from '../social/roles';
import {
  BoardNameSchema,
  CheckMoonBoardClimbDuplicatesInputSchema,
  ClimbSearchInputSchema,
  ClimbStatsForClimbsUuidsSchema,
  ExternalUUIDSchema,
  SetterStatsInputSchema,
  SimilarClimbsInputSchema,
} from '../../../validation/schemas';
import type { ClimbSearchContext } from '../shared/types';
import { db, dbRead } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { redisClientManager } from '../../../redis/client';
import { requireAdmin } from '../social/roles';

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

/**
 * Boards where a hold id only means something once you know which physical wall
 * it is on, so similarity has to be scoped to one size.
 *
 * Woods is the case: its 8x10 and 12x12 walls both number holds from 0, and the
 * 8x10's ids are a numeric subset of the 12x12's sitting at completely different
 * positions. Every Aurora board derives `compatible_size_ids` from a bounding box
 * against a shared placement grid, so one climb legitimately fits several sizes
 * and scoping would just hide results.
 */
function isSizeScopedSimilarityBoard(boardType: BoardName): boolean {
  return boardType === 'woods';
}

const HOLD_HEATMAP_CACHE_PREFIX = 'boardsesh:hold-heatmap:v2:';
const HOLD_HEATMAP_CACHE_TTL_SECONDS = 5 * 60;
/** Search fields that order or page a list and cannot change a whole-set aggregate. */
const HOLD_HEATMAP_IGNORED_FIELDS = new Set(['page', 'pageSize', 'sortBy', 'sortOrder', 'sortSeed']);

/**
 * One cache entry per filter set. The input is hashed rather than spelled out
 * because a search carries a free-form holdsFilter; sorting/paging fields are
 * dropped so the list's scroll position does not split the cache. A search with
 * user-specific filters is keyed by the caller too.
 */
export function holdHeatmapCacheKey(
  input: Readonly<Record<string, unknown>> & { boardName: string },
  userId: string | undefined,
): string {
  const relevant = Object.entries(input)
    .filter(([field, value]) => !HOLD_HEATMAP_IGNORED_FIELDS.has(field) && value !== undefined && value !== null)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const digest = createHash('sha1')
    .update(JSON.stringify(relevant))
    .update(userId ?? '')
    .digest('hex');
  return `${HOLD_HEATMAP_CACHE_PREFIX}${input.boardName}:${digest}`;
}

async function getCachedHoldHeatmap(cacheKey: string): Promise<HoldStat[] | null> {
  if (!redisClientManager.isRedisConnected()) return null;
  try {
    const cached = await redisClientManager.getClients().publisher.get(cacheKey);
    return cached === null ? null : (JSON.parse(cached) as HoldStat[]);
  } catch (error) {
    logger.warn('[hold-heatmap] cache read failed', { error });
    return null;
  }
}

function cacheHoldHeatmap(cacheKey: string, stats: HoldStat[]): void {
  if (!redisClientManager.isRedisConnected()) return;
  try {
    redisClientManager
      .getClients()
      .publisher.set(cacheKey, JSON.stringify(stats), 'EX', HOLD_HEATMAP_CACHE_TTL_SECONDS)
      .catch((error: unknown) => logger.warn('[hold-heatmap] cache write failed', { error }));
  } catch (error) {
    logger.warn('[hold-heatmap] cache write initiation failed', { error });
  }
}

export const climbQueries = {
  /**
   * Per-hold usage over the climbs a search matches — the hold heatmap's live
   * path. Admin only: every other climber answers this on device from the
   * downloaded board (mobile registers the operation local-only), so this GROUP BY
   * over board_climb_holds never runs for the public. Filters ride through the
   * same `ClimbSearchInput` → `createClimbFilters` conversion as `searchClimbs`.
   */
  holdHeatmap: async (
    _: unknown,
    { input }: { input: ClimbSearchInput },
    ctx: ConnectionContext,
  ): Promise<HoldStat[]> => {
    await applyRateLimit(ctx, 30, 'hold-heatmap');
    const parsedInput = validateInput(ClimbSearchInputSchema, input, 'input');
    await requireAdmin(ctx, parsedInput.boardName);
    if (!isValidBoardName(parsedInput.boardName)) {
      throw new Error(`Invalid board name: ${parsedInput.boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }
    // Same guard as searchClimbs: a spray layout id is a guessable sequence value,
    // and an admin is not a member of every private wall.
    const isSpray = isSprayBoardType(parsedInput.boardName);
    if (
      isSpray &&
      !(await sprayLayoutIsReadableWithCapability(
        parsedInput.boardName,
        parsedInput.layoutId,
        ctx.userId,
        parsedInput.sprayWallUuid,
      ))
    ) {
      return [];
    }

    const params: ParsedBoardRouteParameters = {
      board_name: parsedInput.boardName,
      layout_id: parsedInput.layoutId,
      size_id: parsedInput.sizeId,
      set_ids: parsedInput.setIds
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id)),
      angle: parsedInput.angle,
    };
    const searchParams: ClimbSearchParams = mapSearchInputToParams(parsedInput);
    const hasUserSpecificFilters = USER_SPECIFIC_SEARCH_PARAMS.some(
      (param) => !!searchParams[param as keyof typeof searchParams],
    );
    const userId = hasUserSpecificFilters ? ctx.userId : undefined;

    // A spray wall's entry would be keyed by layout, not viewer; never cache it.
    const cacheKey = isSpray ? null : holdHeatmapCacheKey(parsedInput, userId);
    if (cacheKey) {
      const cached = await getCachedHoldHeatmap(cacheKey);
      if (cached) return cached;
    }

    const stats: HoldStat[] = await getHoldHeatmapData(dbRead, params, searchParams, userId);
    if (cacheKey) cacheHoldHeatmap(cacheKey, stats);
    return stats;
  },

  checkMoonBoardClimbDuplicates: async (
    _: unknown,
    { input }: { input: CheckMoonBoardClimbDuplicatesInput },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 60, 'moonboard-duplicate-check');
    const validated = validateInput(CheckMoonBoardClimbDuplicatesInputSchema, input, 'input');
    return findMoonBoardDuplicateMatches(validated.layoutId, validated.angle, validated.climbs);
  },

  /**
   * Find climbs on the same board+layout that share at least `threshold`
   * (default 0.5) position-only Jaccard similarity with the target's holds.
   * Used by the playview drawer's similar-climbs panel and the web climb page's
   * similar-climbs strip (both 0.5).
   *
   * Two paths (docs/similar-climbs.md):
   *  - Admins (`hasCatalogQueryAccess`) run the live Jaccard CTE, cached.
   *  - Everyone else, anonymous callers included (the web front door calls
   *    anonymously), reads the nightly `board_climb_neighbors` index. A bare
   *    `frames` lookup has no precomputed answer, so it stays admin-only.
   */
  similarClimbs: async (
    _: unknown,
    { input }: { input: SimilarClimbsInput },
    ctx: ConnectionContext,
  ): Promise<SimilarClimb[]> => {
    const validated = validateInput(SimilarClimbsInputSchema, input, 'input');

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(`Invalid board name: ${validated.boardType}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }
    const boardType = validated.boardType as BoardName;

    if (!(await hasCatalogQueryAccess(ctx, boardType))) {
      // 600/min/IP on the index path. The read is one index lookup, and every
      // web front-door render reaches here from the web server's single IP:
      // crawlers walking climb pages put hundreds of requests a minute through
      // that one key, which the 30/min live-path limit below turned into
      // RATE_LIMITED errors and empty strips.
      await applyRateLimit(ctx, 600, 'similar-climbs-index');
      // Spray walls are private catalogues and never materialised; the app
      // answers them from the wall it has mirrored on the phone. Checked first
      // so a wall answers every non-admin the same way, frames or not.
      if (isSprayBoardType(boardType)) return [];
      const climbUuid = validated.climbUuid;
      if (!climbUuid) {
        // No materialised answer for an unsaved hold pattern. Throws: the
        // caller was just found not to hold the access it asks for.
        await requireCatalogQueryAccess(ctx, boardType);
        return [];
      }
      return getMaterializedSimilarClimbs(dbRead, {
        boardType,
        layoutId: validated.layoutId,
        climbUuid,
        threshold: validated.threshold ?? 0.5,
        limit: validated.limit ?? 25,
        // Stored lists are already scoped to the target's own wall; a size the
        // caller names narrows them further, as the live path's size scope does.
        sizeId: isSizeScopedSimilarityBoard(boardType) ? (validated.sizeId ?? undefined) : undefined,
        statsAngle: validated.angle ?? undefined,
      });
    }

    // 30/min/IP on the live path only. The similar-climbs CTE scans
    // board_climb_holds for the whole layout before the HAVING prune. React
    // Query caches identical queries for 5 min but the play-drawer surface keys
    // on climbUuid so rapid climb-switching generates fresh requests; 30/min
    // stays well above any realistic interactive cadence while keeping a
    // CGNAT'd shared IP from running the query at 1/s sustained.
    await applyRateLimit(ctx, 30, 'similar-climbs');

    // `climbUuid` is OPTIONAL here — a caller may pass a bare hold set — so this
    // needs no capability at all: posting `holds: [1..N]` with `threshold: 0`
    // against a guessed `layoutId` dumped a private wall's whole catalogue, names
    // and frames included. Results are also written to a Redis cache keyed on
    // `boardType:layoutId:shapeHash` with no viewer in the key, so one leak would
    // have been served to everyone after.
    if (isSprayBoardType(boardType) && !(await sprayLayoutIsReadable(boardType, validated.layoutId, ctx.userId))) {
      return [];
    }

    let holds: NormalizedHold[];
    let excludeUuid = validated.excludeClimbUuid ?? undefined;
    // Size scope, only meaningful on Woods (see below). Starts from the request
    // and can be filled in from the target climb.
    let sizeId = isSizeScopedSimilarityBoard(boardType) ? (validated.sizeId ?? undefined) : undefined;

    if (validated.climbUuid) {
      const targetHoldRows = await db
        .select({
          holdId: dbSchema.boardClimbHolds.holdId,
          holdState: dbSchema.boardClimbHolds.holdState,
        })
        .from(dbSchema.boardClimbHolds)
        .where(
          and(
            eq(dbSchema.boardClimbHolds.boardType, boardType),
            eq(dbSchema.boardClimbHolds.climbUuid, validated.climbUuid),
          ),
        );
      holds = targetHoldRows.map((row) => ({ holdId: row.holdId, holdState: row.holdState }));

      // Legacy fallback: pre-existing climbs (especially MoonBoard imports)
      // carry their hold pattern in board_climbs.frames but have no rows in
      // board_climb_holds yet (backfill follow-up #1). Without this fallback
      // a MoonBoard duplicate-publish that points the UI at the existing
      // climb via `climbUuid` would surface an empty "no identical climbs"
      // state for the exact match it just rejected.
      //
      // The same lookup answers "which wall is the target on?" on a size-scoped
      // board, so it also runs when only the size is missing.
      const needsTargetSize = isSizeScopedSimilarityBoard(boardType) && sizeId === undefined;
      if (holds.length === 0 || needsTargetSize) {
        const [climbRow] = await db
          .select({
            frames: dbSchema.boardClimbs.frames,
            compatibleSizeIds: dbSchema.boardClimbs.compatibleSizeIds,
          })
          .from(dbSchema.boardClimbs)
          .where(and(eq(dbSchema.boardClimbs.boardType, boardType), eq(dbSchema.boardClimbs.uuid, validated.climbUuid)))
          .limit(1);
        if (holds.length === 0 && climbRow?.frames) {
          holds = parseFramesToHoldEntries(boardType, climbRow.frames).map(({ holdId, holdState }) => ({
            holdId,
            holdState,
          }));
        }
        if (needsTargetSize) sizeId = storedWoodsSizeId(climbRow?.compatibleSizeIds) ?? undefined;
      }

      // Always exclude the target climb itself from its own similar list.
      excludeUuid = validated.climbUuid;
    } else {
      holds = parseFramesToHoldEntries(boardType, validated.frames ?? '').map(({ holdId, holdState }) => ({
        holdId,
        holdState,
      }));
    }

    if (holds.length === 0) return [];

    // Fail closed rather than comparing across walls. On Woods the 8x10 and the
    // 12x12 both number their holds from 0, so an unscoped comparison happily
    // reports two unrelated climbs as a 100% match — worse than returning
    // nothing. Callers that can't supply a size (a frames-only lookup on a climb
    // that isn't saved yet) have to start sending one.
    if (isSizeScopedSimilarityBoard(boardType) && sizeId === undefined) return [];

    // Redis-cached and single-flighted (#4968). The statement is a catalogue-wide
    // aggregate — see `similar-climbs-cache.ts` for the measured cost and for why
    // the cache had to move off the web instance's `unstable_cache`.
    return findSimilarClimbsCached({
      boardType,
      layoutId: validated.layoutId,
      holds,
      threshold: validated.threshold ?? 0.5,
      limit: validated.limit ?? 25,
      sizeId,
      excludeUuid,
      statsAngle: validated.angle ?? undefined,
    });
  },

  /**
   * Search for climbs with various filters
   * Returns a context object that field resolvers use to fetch data lazily
   */
  searchClimbs: async (
    _: unknown,
    { input }: { input: ClimbSearchInput },
    ctx: ConnectionContext,
  ): Promise<ClimbSearchContext> => {
    // 120/min/identity. This is the app's hottest query and infinite scroll fires one
    // request per page, so the limit sits well above any interactive cadence while
    // capping abuse (deep-OFFSET pages, holdsFilter floods) on an anonymous endpoint.
    await applyRateLimit(ctx, 120, 'search-climbs');
    const parsedInput = validateInput(ClimbSearchInputSchema, input, 'input');

    // Validate board name
    if (!isValidBoardName(parsedInput.boardName)) {
      throw new Error(`Invalid board name: ${parsedInput.boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // Parse setIds from comma-separated string
    const setIds = parsedInput.setIds
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    // Build route parameters
    const params: ParsedBoardRouteParameters = {
      board_name: parsedInput.boardName,
      layout_id: parsedInput.layoutId,
      size_id: parsedInput.sizeId,
      set_ids: setIds,
      angle: parsedInput.angle,
    };

    // Build search parameters via the shared mapper — same falsy-collapse
    // rules as the web SSR path. Don't inline the field-by-field copy here.
    const searchParams: ClimbSearchParams = mapSearchInputToParams(parsedInput);
    if (parsedInput.onlyFollowedAuthors) requireAuthenticated(ctx);

    if (DEBUG) {
      logger.info(
        '[searchClimbs] onlyDrafts:',
        parsedInput.onlyDrafts,
        'userId:',
        ctx.isAuthenticated ? ctx.userId : 'not authenticated',
      );
    }

    // Drafts require authentication — return empty results if not signed in
    if (parsedInput.onlyDrafts && !ctx.isAuthenticated) {
      return {
        params,
        searchParams,
        userId: undefined,
        _cachedClimbs: [],
        _cachedHasMore: false,
        _cachedTotalCount: 0,
      };
    }

    // A spray climb is stored `is_listed = true`, so every predicate written for
    // the eight catalogue boards reads it as public — and a wall's `layout_id`
    // comes out of a sequence, so this query took a guessable key. Without this a
    // stranger could read a private wall's climb names, frames, setters and stats.
    // The pre-baked empty result is the same shape the drafts branch above returns,
    // which is deliberate: an unreadable wall must be indistinguishable from an
    // empty one.
    //
    // `sprayWallUuid` is the one exemption, and it is a capability rather than a
    // filter: a climber handed an unlisted wall's link may already SET on it
    // (`saveClimb` takes the same uuid as proof), so refusing to LIST what they set
    // made the wall write-only for them.
    if (
      isSprayBoardType(parsedInput.boardName) &&
      !(await sprayLayoutIsReadableWithCapability(
        parsedInput.boardName,
        parsedInput.layoutId,
        ctx.userId,
        parsedInput.sprayWallUuid,
      ))
    ) {
      return {
        params,
        searchParams,
        userId: undefined,
        _cachedClimbs: [],
        _cachedHasMore: false,
        _cachedTotalCount: 0,
      };
    }

    // MoonBoard and Woods data changes under the search, so keep GraphQL search
    // results uncached for both. Other boards can still use Redis when the query
    // is anonymous and has no user-specific filters.
    //
    // Woods used to be cacheable because its catalog was a read-only static
    // import. It now has a create path (#4750, this change), so a cached
    // anonymous search would keep serving a page that doesn't contain the climb
    // the setter just published — the same staleness MoonBoard's creation/import
    // flows cause.
    const hasUserSpecificFilters = USER_SPECIFIC_SEARCH_PARAMS.some(
      (param) => !!searchParams[param as keyof typeof searchParams],
    );
    // Spray joins MoonBoard and Woods as uncacheable, for a different reason: the
    // cache key is the board config, NOT the viewer, so one owner's page of their
    // own private wall would be served to the next caller who asked for that
    // layout. A per-viewer key would work and is not worth it for a wall with a
    // handful of climbers.
    const isCacheableBoard =
      parsedInput.boardName !== 'moonboard' && parsedInput.boardName !== 'woods' && parsedInput.boardName !== 'spray';

    // Only resolve userId when user-specific filters are active — otherwise the query
    // results are identical to anonymous and can be served from Redis cache.
    const userId = ctx.isAuthenticated && hasUserSpecificFilters ? ctx.userId : undefined;

    // Return context for field resolvers - queries are executed lazily per field
    // Personal progress filters now use boardsesh_ticks table with NextAuth user ID
    const isCacheable = !hasUserSpecificFilters && isCacheableBoard;
    return {
      params,
      searchParams,
      userId,
      _isCacheable: isCacheable,
      _isPopularPageCacheable: isPopularPageCacheable(parsedInput.boardName, searchParams, isCacheable),
    };
  },

  /**
   * Get setter usernames with climb counts for autocomplete in the search drawer.
   */
  setterStats: async (
    _: unknown,
    { input }: { input: SetterStatsInput },
    ctx: ConnectionContext,
  ): Promise<SetterStat[]> => {
    await applyRateLimit(ctx, 60, 'setter-stats');
    const validated = validateInput(SetterStatsInputSchema, input, 'input');
    if (validated.onlyFollowedAuthors) requireAuthenticated(ctx);

    if (!isValidBoardName(validated.boardName)) {
      throw new Error(`Invalid board name: ${validated.boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // Parse setIds from comma-separated string (same pattern as searchClimbs)
    const setIds = validated.setIds
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    const params: ParsedBoardRouteParameters = {
      board_name: validated.boardName,
      layout_id: validated.layoutId,
      size_id: validated.sizeId,
      set_ids: setIds,
      angle: validated.angle,
    };

    // Otherwise this hands back the usernames and per-setter climb counts of every
    // private spray wall's crew, to anyone who walks the layout-id sequence.
    if (
      isSprayBoardType(validated.boardName) &&
      !(await sprayLayoutIsReadable(validated.boardName, validated.layoutId, ctx.userId))
    ) {
      return [];
    }

    // `crossAngleStats` is the list's "Other angles" opt-in. Without it a Woods
    // setter is counted only for the browsed angle's climbs, the same restriction
    // the list applies (#5642); every other board ignores it. Nothing caches this
    // resolver, so the flag needs no cache-key entry.
    const rows = await getSetterStats(
      dbRead,
      params,
      validated.search,
      validated.onlyFollowedAuthors ? ctx.userId! : undefined,
      { crossAngleStats: validated.crossAngleStats },
    );

    return rows.map((row) => ({
      setterUsername: row.setter_username,
      climbCount: row.climb_count,
    }));
  },

  /**
   * Get a specific climb by UUID
   */
  climb: async (
    _: unknown,
    {
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      climbUuid,
    }: {
      boardName: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      angle: number;
      climbUuid: string;
    },
    ctx: ConnectionContext,
  ) => {
    // Validate board name
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // Validate all parameters
    if (layoutId <= 0) throw new Error('Invalid layoutId: must be positive');
    if (sizeId <= 0) throw new Error('Invalid sizeId: must be positive');
    // Aurora boards support negative tilt (e.g. -5°); mobile sends the live board angle here.
    if (angle < -90 || angle > 90) throw new Error('Invalid angle: must be between -90 and 90');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (DEBUG) logger.info('[climb] Fetching:', { boardName, layoutId, sizeId, setIds, angle, climbUuid });

    // A climb uuid is a 122-bit secret, so this is not an enumeration — but it is
    // the path a SHARED LINK takes, and a link that escaped once would otherwise
    // keep serving a private wall's climb forever. The wall's visibility decides,
    // not the possession of the uuid.
    if (isSprayBoardType(boardName) && !(await sprayLayoutIsReadable(boardName, layoutId, ctx?.userId))) {
      return null;
    }

    const climb = await getClimbByUuid({
      board_name: boardName,
      layout_id: layoutId,
      size_id: sizeId,
      angle,
      climb_uuid: climbUuid,
    });

    return climb;
  },

  /**
   * One entry per angle the climb has been sent at, from the live stats table.
   *
   * The name is historical. This used to return up to twelve months of weekly
   * and daily snapshots from `board_climb_stats_history` — a mean of 1,320
   * scattered rows per call, 2.9 s cold on a popular Kilter climb — and every
   * live caller (the mobile play drawer's grade bars, crowd label and angle
   * sheet) kept only the newest row per angle and threw the rest away. The web
   * chart that drew the series was dead code and is gone. Reading the current
   * row per angle gives those callers the same shape with fresher numbers, in
   * about 1 ms and ~18 buffers through the stats primary key.
   *
   * `ascensionist_count > 0` is the snapshot writer's own filter, so an angle
   * nobody has sent never appeared here and still does not. `createdAt` is the
   * stats row's `updated_at`: the moment these numbers were current, which is
   * what the old snapshot timestamp meant too.
   */
  climbStatsHistory: async (
    _: unknown,
    { boardName, climbUuid }: { boardName: string; climbUuid: string },
    ctx: ConnectionContext,
  ) => {
    // Its own bucket, at the same 60/min as climbStatsForAngles: the drawer
    // keys it on climbUuid and caches it for five minutes, so this only bites a
    // scraper walking uuids through an unauthenticated resolver.
    await applyRateLimit(ctx, 60, 'climb-stats-history');
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    const rows = await db
      .select({
        angle: dbSchema.boardClimbStats.angle,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
        displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
        updatedAt: dbSchema.boardClimbStats.updatedAt,
      })
      .from(dbSchema.boardClimbStats)
      .where(
        and(
          eq(dbSchema.boardClimbStats.boardType, boardName),
          eq(dbSchema.boardClimbStats.climbUuid, climbUuid),
          gt(dbSchema.boardClimbStats.ascensionistCount, 0),
          // The same rule `climbStatsForAngles` carries: a retained uuid must not
          // keep buying the ascent, quality and grade numbers of a climb on a
          // wall that has since gone private. This resolver is unauthenticated,
          // so the viewer is whatever the socket carries and usually null. A
          // no-op on the other eight board types.
          sprayReferenceVisibilityCondition(
            { boardType: dbSchema.boardClimbStats.boardType, climbUuid: dbSchema.boardClimbStats.climbUuid },
            ctx?.userId,
          ),
        ),
      )
      .orderBy(asc(dbSchema.boardClimbStats.angle));

    return rows.map(({ updatedAt, ...row }) => ({ ...row, createdAt: updatedAt.toISOString() }));
  },

  /**
   * Get current per-angle stats from the live board_climb_stats table.
   * Replaces the uncached REST endpoint /api/v1/[board]/climb-stats/[uuid].
   */
  climbStatsForAngles: async (
    _: unknown,
    { boardName, climbUuid }: { boardName: string; climbUuid: string },
    ctx: ConnectionContext,
  ) => {
    // 60/min/identity. The angle drawer keys on climbUuid and caches 5 min
    // client-side, so this sits well above interactive cadence while capping
    // a scraper hammering the (previously uncached) stats endpoint.
    await applyRateLimit(ctx, 60, 'climb-stats-for-angles');
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // This query is the reconciliation read for optimistic live stats. Use the
    // primary so a reconnect immediately after saveTick cannot replace a newer
    // optimistic floor with replica-lagged numbers.
    const rows = await db
      .select({
        angle: dbSchema.boardClimbStats.angle,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
        displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
        faUsername: dbSchema.boardClimbStats.faUsername,
        faAt: dbSchema.boardClimbStats.faAt,
        // The schema's historical Drizzle mapping uses JS number mode. Cast in
        // PostgreSQL so revisions above MAX_SAFE_INTEGER reach the client intact.
        syncSeq: sql<string>`${dbSchema.boardClimbStats.syncSeq}::text`,
      })
      .from(dbSchema.boardClimbStats)
      .where(
        and(
          eq(dbSchema.boardClimbStats.boardType, boardName),
          eq(dbSchema.boardClimbStats.climbUuid, climbUuid),
          // Numbers, but not ONLY numbers: a spray climb's stats row carries the
          // setter's grade and `fa_username`, and it is seeded at creation — so
          // anyone who kept a uuid could keep reading them after the wall went
          // private. The epic rule is that a private wall shows a non-principal
          // nothing, so the reference predicate rides here too (empty result, no
          // error). A no-op on the other eight board types.
          sprayReferenceVisibilityCondition(
            { boardType: dbSchema.boardClimbStats.boardType, climbUuid: dbSchema.boardClimbStats.climbUuid },
            ctx?.userId,
          ),
        ),
      )
      .orderBy(asc(dbSchema.boardClimbStats.angle));

    return rows.map((row) => ({
      ...row,
      // Mirror the REST endpoint: round display difficulty to a grade id and label it.
      difficulty: row.displayDifficulty == null ? null : getGradeLabel(Math.round(row.displayDifficulty)),
      syncSeq: row.syncSeq,
    }));
  },

  /**
   * Batch form of climbStatsForAngles for mount/reconnect/post-ack repair.
   * It deliberately shares the legacy resolver's limiter bucket: switching
   * clients from N single reads to one batch must not create a second budget.
   */
  climbStatsForClimbs: async (
    _: unknown,
    { boardName, climbUuids }: { boardName: string; climbUuids: string[] },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'climb-stats-for-angles');
    validateInput(BoardNameSchema, boardName, 'boardName');
    const validatedClimbUuids = validateInput(ClimbStatsForClimbsUuidsSchema, climbUuids, 'climbUuids');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    const uniqueClimbUuids = [...new Set(validatedClimbUuids)];
    // This is one physical primary query for the whole batch. Empty climbs are
    // represented by the absence of rows; the client records cooldowns from
    // the requested UUID list rather than inferring them from this response.
    const rows = await db
      .select({
        climbUuid: dbSchema.boardClimbStats.climbUuid,
        angle: dbSchema.boardClimbStats.angle,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
        displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
        faUsername: dbSchema.boardClimbStats.faUsername,
        faAt: dbSchema.boardClimbStats.faAt,
        syncSeq: sql<string>`${dbSchema.boardClimbStats.syncSeq}::text`,
      })
      .from(dbSchema.boardClimbStats)
      .where(
        and(
          eq(dbSchema.boardClimbStats.boardType, boardName),
          inArray(dbSchema.boardClimbStats.climbUuid, uniqueClimbUuids),
          // Same rule as `climbStatsForAngles`: the row carries the setter grade
          // and `fa_username`, so a retained uuid must not outlive the wall's
          // visibility.
          sprayReferenceVisibilityCondition(
            { boardType: dbSchema.boardClimbStats.boardType, climbUuid: dbSchema.boardClimbStats.climbUuid },
            ctx?.userId,
          ),
        ),
      )
      .orderBy(asc(dbSchema.boardClimbStats.climbUuid), asc(dbSchema.boardClimbStats.angle));

    return rows.map((row) => ({
      ...row,
      difficulty: row.displayDifficulty == null ? null : getGradeLabel(Math.round(row.displayDifficulty)),
      syncSeq: row.syncSeq,
    }));
  },

  /**
   * Get the Boardsesh grade for a climb at one angle from board_climb_grades
   * (written by the nightly refresh-climb-grades job). Returns null when no row
   * exists for that climb+angle (e.g. MoonBoard, or too few ascents).
   */
  boardseshGrade: async (
    _: unknown,
    { boardName, climbUuid, angle }: { boardName: string; climbUuid: string; angle: number },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 60, 'boardsesh-grade');
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    const [row] = await dbRead
      .select({
        localGrade: dbSchema.boardClimbGrades.localGrade,
        universalGrade: dbSchema.boardClimbGrades.universalGrade,
        gradeLow: dbSchema.boardClimbGrades.gradeLow,
        gradeHigh: dbSchema.boardClimbGrades.gradeHigh,
        confidence: dbSchema.boardClimbGrades.confidence,
        ascensionistCount: dbSchema.boardClimbGrades.ascensionistCount,
        modelVersion: dbSchema.boardClimbGrades.modelVersion,
        computedAt: dbSchema.boardClimbGrades.computedAt,
        contentGrade: dbSchema.boardClimbEmbeddings.contentPrior,
      })
      .from(dbSchema.boardClimbGrades)
      .leftJoin(
        dbSchema.boardClimbEmbeddings,
        and(
          eq(dbSchema.boardClimbEmbeddings.boardType, dbSchema.boardClimbGrades.boardType),
          eq(dbSchema.boardClimbEmbeddings.climbUuid, dbSchema.boardClimbGrades.climbUuid),
          eq(dbSchema.boardClimbEmbeddings.angle, dbSchema.boardClimbGrades.angle),
        ),
      )
      .where(
        and(
          eq(dbSchema.boardClimbGrades.boardType, boardName),
          eq(dbSchema.boardClimbGrades.climbUuid, climbUuid),
          eq(dbSchema.boardClimbGrades.angle, angle),
          // `board_climb_grades` carries no spray rows today — the nightly model
          // runs over CROWD_MEAN_BOARDS only — so this predicate is closing the
          // gap ahead of the day spray joins that list, not a live leak. Both
          // readers are unauthenticated, and the row is a grade band with an
          // ascent count, which is exactly what the wall's privacy covers.
          sprayReferenceVisibilityCondition(
            { boardType: dbSchema.boardClimbGrades.boardType, climbUuid: dbSchema.boardClimbGrades.climbUuid },
            ctx?.userId,
          ),
        ),
      )
      .limit(1);

    return row ?? null;
  },

  /**
   * Get the Boardsesh grade for a climb at every computed angle from
   * board_climb_grades (written by the nightly refresh-climb-grades job).
   * Returns one entry per angle ordered ascending, or an empty list when no
   * rows exist for the climb (e.g. MoonBoard, or too few ascents).
   */
  boardseshGradesForAngles: async (
    _: unknown,
    { boardName, climbUuid }: { boardName: string; climbUuid: string },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 60, 'boardsesh-grades-for-angles');
    // BoardNameSchema is z.enum(SUPPORTED_BOARDS), so validateInput already
    // rejects any unsupported board — no extra isValidBoardName guard needed.
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    const rows = await dbRead
      .select({
        angle: dbSchema.boardClimbGrades.angle,
        localGrade: dbSchema.boardClimbGrades.localGrade,
        universalGrade: dbSchema.boardClimbGrades.universalGrade,
        gradeLow: dbSchema.boardClimbGrades.gradeLow,
        gradeHigh: dbSchema.boardClimbGrades.gradeHigh,
        confidence: dbSchema.boardClimbGrades.confidence,
        ascensionistCount: dbSchema.boardClimbGrades.ascensionistCount,
        modelVersion: dbSchema.boardClimbGrades.modelVersion,
        computedAt: dbSchema.boardClimbGrades.computedAt,
        contentGrade: dbSchema.boardClimbEmbeddings.contentPrior,
      })
      .from(dbSchema.boardClimbGrades)
      .leftJoin(
        dbSchema.boardClimbEmbeddings,
        and(
          eq(dbSchema.boardClimbEmbeddings.boardType, dbSchema.boardClimbGrades.boardType),
          eq(dbSchema.boardClimbEmbeddings.climbUuid, dbSchema.boardClimbGrades.climbUuid),
          eq(dbSchema.boardClimbEmbeddings.angle, dbSchema.boardClimbGrades.angle),
        ),
      )
      .where(
        and(
          eq(dbSchema.boardClimbGrades.boardType, boardName),
          eq(dbSchema.boardClimbGrades.climbUuid, climbUuid),
          // `board_climb_grades` carries no spray rows today — the nightly model
          // runs over CROWD_MEAN_BOARDS only — so this predicate is closing the
          // gap ahead of the day spray joins that list, not a live leak. Both
          // readers are unauthenticated, and the row is a grade band with an
          // ascent count, which is exactly what the wall's privacy covers.
          sprayReferenceVisibilityCondition(
            { boardType: dbSchema.boardClimbGrades.boardType, climbUuid: dbSchema.boardClimbGrades.climbUuid },
            ctx?.userId,
          ),
        ),
      )
      .orderBy(asc(dbSchema.boardClimbGrades.angle));

    return rows;
  },
};
