import { and, asc, countDistinct, desc, eq, exists, inArray, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { BoardDiscoveryBoard, ConnectionContext } from '@boardsesh/shared-schema';
import { boardseshTicks, gyms, sprayWalls, userBoards } from '@boardsesh/db/schema';
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
    isNull(userBoards.deletedAt),
    isNull(userBoards.mergedIntoBoardUuid),
    isNotNull(userBoards.slug),
    ne(userBoards.slug, ''),
    eq(gyms.isPublic, true),
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

    return Promise.all(
      boards.slice(0, limit).flatMap((board) => {
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
          })),
        ];
      }),
    );
  },
};
