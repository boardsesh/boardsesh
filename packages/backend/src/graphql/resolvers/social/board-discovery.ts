import { and, asc, countDistinct, desc, eq, exists, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { BoardDiscoveryBoard, ConnectionContext } from '@boardsesh/shared-schema';
import { boardseshTicks, gyms, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub';
import { logger } from '../../../utils/logger';
import { BoardDiscoveryInputSchema } from '../../../validation/schemas';
import { applyRateLimit, validateInput } from '../shared/helpers';

/** Anonymous discovery is deliberately stricter than owner-aware board search. */
export const boardDiscoveryQueries = {
  boardDiscovery: async (
    _: unknown,
    { input }: { input?: unknown },
    ctx: ConnectionContext,
  ): Promise<BoardDiscoveryBoard[]> => {
    await applyRateLimit(ctx, 60, 'boardDiscovery');
    const { gymUuid, limit } = validateInput(BoardDiscoveryInputSchema, input ?? {}, 'input');
    const uniqueClimbers = countDistinct(boardseshTicks.userId);
    const boards = await db
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
        uniqueClimbers,
      })
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
      .where(
        and(
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
        ),
      )
      .groupBy(userBoards.id, gyms.id)
      .orderBy(desc(uniqueClimbers), asc(userBoards.uuid))
      .limit(limit);

    return Promise.all(
      boards.flatMap((board) => {
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
