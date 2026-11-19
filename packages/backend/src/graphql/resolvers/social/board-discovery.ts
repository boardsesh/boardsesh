import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BoardDiscoveryBoard, BoardDiscoveryClimb, ConnectionContext } from '@boardsesh/shared-schema';
import { boardClimbAliases, boardClimbs, boardseshTicks, gyms, sprayWalls, userBoards } from '@boardsesh/db/schema';
import {
  contentVisibilityCondition,
  holdIntegrityCondition,
  playlistBoardScopeConditions,
  publicClimbCondition,
  resourceAccessCondition,
  resourceLocationCondition,
  retiredByResetCondition,
  sprayClimbVisibilityCondition,
} from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub';
import { logger } from '../../../utils/logger';
import { readThroughRedis } from '../../../utils/redis-read-through';
import { BoardDiscoveryInputSchema } from '../../../validation/schemas';
import { applyRateLimit, validateInput } from '../shared/helpers';

/**
 * How many ranked boards the cache keeps. The resolver hands out at most 12
 * (`BoardDiscoveryInputSchema`), so 40 leaves room for boards that turn private,
 * get deleted or lose their gym's slug inside one cache window.
 */
export const BOARD_DISCOVERY_RANKING_SIZE = 40;

/**
 * Fifteen minutes, the owner-approved staleness for climber counts on a
 * marketing rail. Visibility is not cached: it is re-checked on every request.
 */
export const BOARD_DISCOVERY_CACHE_TTL_SECONDS = 15 * 60;

type RankedBoard = { boardId: number; uniqueClimbers: number };

export function boardDiscoveryCacheKey(gymUuid: string | undefined): string {
  return `board-discovery:v1:${gymUuid ?? 'all'}`;
}

/**
 * Everything that makes a board eligible for anonymous discovery. The ranking
 * applies it so the cached top 40 are boards that were public when ranked; the
 * per-request read applies it again, so a board that went private, was deleted
 * or had its spray wall hidden disappears at once rather than after the TTL.
 */
function discoverableBoardConditions(gymUuid: string | undefined): SQL | undefined {
  return and(
    eq(userBoards.isPublic, true),
    eq(userBoards.isUnlisted, false),
    eq(userBoards.hideLocation, false),
    resourceAccessCondition('board', userBoards.uuid, null, { allowUnlistedLink: false }),
    resourceLocationCondition(userBoards.uuid, null),
    isNull(userBoards.deletedAt),
    isNull(userBoards.mergedIntoBoardUuid),
    isNotNull(userBoards.slug),
    ne(userBoards.slug, ''),
    eq(gyms.isPublic, true),
    eq(gyms.isListed, true),
    isNull(gyms.deletedAt),
    isNull(gyms.mergedIntoGymId),
    isNotNull(gyms.slug),
    ne(gyms.slug, ''),
    // Unlike owner-aware search, public discovery has no owner escape.
    // Moderation-hidden photos must not leak through board metadata either.
    or(
      ne(userBoards.boardType, 'spray'),
      exists(
        db
          .select({ id: sprayWalls.id })
          .from(sprayWalls)
          .where(
            and(
              eq(sprayWalls.boardUuid, userBoards.uuid),
              isNull(sprayWalls.deletedAt),
              isNull(sprayWalls.hiddenAt),
              // A wall a reset replaced must not outrank its successor.
              isNull(sprayWalls.archivedAt),
              isNotNull(sprayWalls.currentVersionId),
            ),
          ),
      ),
    ),
    gymUuid ? eq(gyms.uuid, gymUuid) : undefined,
  );
}

/**
 * The expensive half: distinct send/flash climbers per board. It walks
 * `boardsesh_ticks_board_user_idx` end to end and fetches a heap row per tick
 * (~62k buffers, 160 ms warm on the replica), and the answer moves by a climber
 * or two an hour, so it is cached.
 */
async function rankDiscoverableBoards(gymUuid: string | undefined): Promise<RankedBoard[]> {
  const uniqueClimbers = countDistinct(boardseshTicks.userId);
  return db
    .select({ boardId: userBoards.id, uniqueClimbers })
    .from(userBoards)
    .innerJoin(gyms, eq(userBoards.gymId, gyms.id))
    .leftJoin(
      boardseshTicks,
      and(
        eq(boardseshTicks.boardId, userBoards.id),
        inArray(boardseshTicks.status, ['send', 'flash']),
        isNull(boardseshTicks.kilterDetachedAt),
      ),
    )
    .where(discoverableBoardConditions(gymUuid))
    .groupBy(userBoards.id, gyms.id)
    .orderBy(desc(uniqueClimbers), asc(userBoards.uuid))
    .limit(BOARD_DISCOVERY_RANKING_SIZE);
}

type PreviewBoard = Pick<BoardDiscoveryBoard, 'boardType' | 'layoutId' | 'sizeId' | 'setIds'> & { boardId: number };

/**
 * Public send/flash records on these physical installations, never layout-wide
 * popularity. One grouped query picks the climb with the most records across
 * angles, then its most-logged angle. Repeat sends count; ties use canonical
 * climb UUID and then angle. Eligibility is applied before either ranking.
 *
 * No shared cache: tick, climb, board and gym privacy changes must take effect
 * on the next read. The caller supplies at most twelve already-selected boards.
 */
export async function loadPopularGymClimbs(
  gymUuid: string,
  boards: readonly PreviewBoard[],
): Promise<Map<number, BoardDiscoveryClimb>> {
  if (boards.length === 0 || boards.length > 12) return new Map();
  const boardScopes = boards.flatMap((board) => {
    const setTokens = board.setIds.split(',').map((token) => token.trim());
    if (setTokens.length === 0 || setTokens.some((token) => !/^\d+$/.test(token))) return [];
    const setIds = setTokens.map(Number);
    if (setIds.some((setId) => !Number.isSafeInteger(setId))) return [];
    return [
      and(
        eq(boardseshTicks.boardId, board.boardId),
        eq(boardseshTicks.boardType, board.boardType),
        eq(boardClimbs.boardType, board.boardType),
        ...playlistBoardScopeConditions({
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds,
        }),
        ...retiredByResetCondition(board.boardType, {}),
      )!,
    ];
  });
  if (boardScopes.length === 0) return new Map();

  const angleLogs = count(boardseshTicks.id);
  // Aggregate/window composition has no Drizzle builder equivalent. All SQL
  // identifiers come from the schema, not request strings.
  const climbLogs = sql<number>`sum(count(${boardseshTicks.id})) over (partition by ${boardseshTicks.boardId}, ${boardClimbs.uuid})`;
  const winners = await db
    .selectDistinctOn([boardseshTicks.boardId], {
      boardId: boardseshTicks.boardId,
      uuid: boardClimbs.uuid,
      name: boardClimbs.name,
      frames: boardClimbs.frames,
      angle: boardseshTicks.angle,
    })
    .from(boardseshTicks)
    .innerJoin(userBoards, eq(userBoards.id, boardseshTicks.boardId))
    .innerJoin(gyms, eq(gyms.id, userBoards.gymId))
    .leftJoin(
      boardClimbAliases,
      and(
        eq(boardClimbAliases.boardType, boardseshTicks.boardType),
        eq(boardClimbAliases.aliasUuid, boardseshTicks.climbUuid),
      ),
    )
    .innerJoin(
      boardClimbs,
      and(
        eq(boardClimbs.boardType, boardseshTicks.boardType),
        eq(boardClimbs.uuid, sql`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid})`),
      ),
    )
    .where(
      and(
        discoverableBoardConditions(gymUuid),
        or(...boardScopes),
        inArray(boardseshTicks.status, ['send', 'flash']),
        isNull(boardseshTicks.kilterDetachedAt),
        contentVisibilityCondition('tick', boardseshTicks.uuid, boardseshTicks.userId, null),
        publicClimbCondition(boardClimbs),
        eq(boardClimbs.isHidden, false),
        ...holdIntegrityCondition({ holdIntegrity: 'intact' }),
        sprayClimbVisibilityCondition(boardClimbs, null),
        or(eq(boardClimbs.boardType, 'moonboard'), isNotNull(boardClimbs.requiredSetIds)),
        isNotNull(boardClimbs.frames),
        ne(boardClimbs.frames, ''),
      ),
    )
    .groupBy(boardseshTicks.boardId, boardClimbs.uuid, boardseshTicks.angle)
    .orderBy(
      asc(boardseshTicks.boardId),
      desc(climbLogs),
      asc(boardClimbs.uuid),
      desc(angleLogs),
      asc(boardseshTicks.angle),
    );
  const popularClimbs = new Map<number, BoardDiscoveryClimb>();
  for (const winner of winners) {
    if (winner.boardId !== null && winner.frames) {
      popularClimbs.set(winner.boardId, {
        uuid: winner.uuid,
        name: winner.name,
        frames: winner.frames,
        angle: winner.angle,
      });
    }
  }
  return popularClimbs;
}

/** Anonymous discovery is deliberately stricter than owner-aware board search. */
export const boardDiscoveryQueries = {
  boardDiscovery: async (
    _: unknown,
    { input }: { input?: unknown },
    ctx: ConnectionContext,
  ): Promise<BoardDiscoveryBoard[]> => {
    await applyRateLimit(ctx, 60, 'boardDiscovery');
    const { gymUuid, limit } = validateInput(BoardDiscoveryInputSchema, input ?? {}, 'input');

    const ranking = await readThroughRedis({
      key: boardDiscoveryCacheKey(gymUuid),
      ttlSeconds: BOARD_DISCOVERY_CACHE_TTL_SECONDS,
      label: 'BoardDiscovery',
      load: () => rankDiscoverableBoards(gymUuid),
    });
    if (ranking.length === 0) return [];

    // The cheap half, live on every request: ~40 primary-key probes (~180
    // buffers, under 1 ms) that re-apply every visibility rule to the cached ids
    // and read the board and gym metadata fresh.
    const visibleBoards = await db
      .select({
        boardId: userBoards.id,
        uuid: userBoards.uuid,
        slug: userBoards.slug,
        name: userBoards.name,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
        angle: userBoards.angle,
        gymUuid: gyms.uuid,
        gymName: gyms.name,
        gymSlug: gyms.slug,
        locationName: userBoards.locationName,
      })
      .from(userBoards)
      .innerJoin(gyms, eq(userBoards.gymId, gyms.id))
      .where(
        and(
          inArray(
            userBoards.id,
            ranking.map((ranked) => ranked.boardId),
          ),
          discoverableBoardConditions(gymUuid),
        ),
      );
    const visibleById = new Map(visibleBoards.map((board) => [board.boardId, board]));

    // Cached rank order, then the limit — the same order and cut the single
    // ranked query made when it applied LIMIT itself.
    const boards = ranking.flatMap((ranked) => {
      const board = visibleById.get(ranked.boardId);
      return board ? [{ ...board, uniqueClimbers: ranked.uniqueClimbers }] : [];
    });

    const selectedBoards = boards.slice(0, limit);
    let popularClimbs = new Map<number, BoardDiscoveryClimb>();
    if (gymUuid) {
      try {
        popularClimbs = await loadPopularGymClimbs(gymUuid, selectedBoards);
      } catch (error) {
        logger.warn('[BoardDiscovery] Popular climb preview unavailable', {
          event: 'board_discovery.popular_preview_unavailable',
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
    }

    return Promise.all(
      selectedBoards.flatMap((board) => {
        const gymSlug = board.gymSlug;
        if (!gymSlug) {
          logger.warn('[BoardDiscovery] Skipping board without a public gym slug', {
            event: 'board_discovery.missing_gym_slug',
            boardId: board.boardId,
          });
          return [];
        }
        return [
          pubsub.getBoardDiscoveryClimb(String(board.boardId)).then((currentClimb) => ({
            uuid: board.uuid,
            slug: board.slug,
            name: board.name,
            boardType: board.boardType,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
            gymUuid: board.gymUuid,
            gymName: board.gymName,
            gymSlug,
            locationName: board.locationName,
            uniqueClimbers: board.uniqueClimbers,
            currentClimb,
            popularClimb: popularClimbs.get(board.boardId) ?? null,
          })),
        ];
      }),
    );
  },
};
