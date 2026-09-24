import { and, asc, count, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { canAttributeTickToBoard, requiredSetIdsForMoonBoard, type TickClimbIdentity } from '@boardsesh/board-config';
import { resolveCanonicalClimbUuid } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { MyBoardsInputSchema, UUIDSchema } from '../../../validation/schemas';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { listableSprayWallCondition } from '../board/spray-wall-listing';

type TickBoardDb = Parameters<typeof resolveCanonicalClimbUuid>[0];

export async function findTickClimb(database: TickBoardDb, boardType: string, climbUuid: string) {
  const canonicalUuid = await resolveCanonicalClimbUuid(database, boardType, climbUuid);
  const [climb] = await database
    .select({
      boardType: schema.boardClimbs.boardType,
      layoutId: schema.boardClimbs.layoutId,
      compatibleSizeIds: schema.boardClimbs.compatibleSizeIds,
      requiredSetIds: schema.boardClimbs.requiredSetIds,
      frames: schema.boardClimbs.frames,
    })
    .from(schema.boardClimbs)
    .where(and(eq(schema.boardClimbs.uuid, canonicalUuid), eq(schema.boardClimbs.boardType, boardType)))
    .limit(1);
  if (!climb) return null;
  return {
    ...climb,
    requiredSetIds: [
      ...new Set([
        ...(climb.requiredSetIds ?? []),
        ...(climb.boardType === 'moonboard' ? requiredSetIdsForMoonBoard(climb.layoutId, climb.frames ?? '') : []),
      ]),
    ],
  };
}

export async function tickBoardFitsClimb(database: TickBoardDb, boardId: number, climb: TickClimbIdentity | null) {
  const [board] = await database
    .select()
    .from(schema.userBoards)
    .where(and(eq(schema.userBoards.id, boardId), isNull(schema.userBoards.deletedAt)))
    .limit(1);
  return board && canAttributeTickToBoard(climb, board) ? board : null;
}

const boardProjection = {
  uuid: schema.userBoards.uuid,
  name: schema.userBoards.name,
  boardType: schema.userBoards.boardType,
  layoutId: schema.userBoards.layoutId,
  sizeId: schema.userBoards.sizeId,
  setIds: schema.userBoards.setIds,
};

export const tickBoardQueries = {
  tickBoardOptions: async (
    _: unknown,
    { tickUuid, limit, offset }: { tickUuid: string; limit?: number; offset?: number },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    validateInput(UUIDSchema, tickUuid, 'tickUuid');
    const page = validateInput(MyBoardsInputSchema, { limit, offset }, 'input');
    const userId = ctx.userId!;
    const [tick] = await db
      .select()
      .from(schema.boardseshTicks)
      .where(and(eq(schema.boardseshTicks.uuid, tickUuid), eq(schema.boardseshTicks.userId, userId)))
      .limit(1);
    if (!tick) throw new GraphQLError('Tick not found', { extensions: { code: 'TICK_NOT_FOUND' } });

    const [currentBoard] =
      tick.boardId == null
        ? []
        : await db
            .select(boardProjection)
            .from(schema.userBoards)
            .where(
              and(
                eq(schema.userBoards.id, tick.boardId),
                or(eq(schema.userBoards.ownerId, userId), eq(schema.userBoards.isPublic, true)),
                isNull(schema.userBoards.deletedAt),
              ),
            )
            .limit(1);
    const climb = await findTickClimb(db, tick.boardType, tick.climbUuid);
    if (!climb) return { currentBoard: currentBoard ?? null, boards: [], totalCount: 0, hasMore: false };

    // Array containment cannot be expressed by Drizzle's scalar predicates.
    const requiredSets = climb.requiredSetIds ?? [];
    const compatibleSizes = climb.compatibleSizeIds ?? [];
    const conditions = and(
      isNull(schema.userBoards.deletedAt),
      or(eq(schema.userBoards.ownerId, userId), eq(schema.userBoards.isPublic, true)),
      listableSprayWallCondition(userId),
      or(
        eq(schema.userBoards.ownerId, userId),
        isNotNull(schema.boardFollows.boardUuid),
        isNotNull(schema.userBoardActivity.pinnedAt),
        isNotNull(schema.userBoardActivity.lastUsedAt),
        // Drizzle's optional predicates omit undefined branches when composing OR.
        tick.boardId == null ? undefined : eq(schema.userBoards.id, tick.boardId),
      ),
      eq(schema.userBoards.boardType, climb.boardType),
      eq(schema.userBoards.layoutId, climb.layoutId),
      compatibleSizes.length
        ? sql`${schema.userBoards.sizeId} = ANY(ARRAY[${sql.join(
            compatibleSizes.map((sizeId) => sql`${sizeId}`),
            sql`, `,
          )}]::int[])`
        : undefined,
      requiredSets.length
        ? sql`ARRAY[${sql.join(
            requiredSets.map((setId) => sql`${setId}`),
            sql`, `,
          )}]::int[] <@ string_to_array(${schema.userBoards.setIds}, ',')::int[]`
        : undefined,
    );
    const joined = () =>
      db
        .select({ ...boardProjection, totalCount: sql<number>`count(*) over()` })
        .from(schema.userBoards)
        .leftJoin(
          schema.boardFollows,
          and(eq(schema.boardFollows.boardUuid, schema.userBoards.uuid), eq(schema.boardFollows.userId, userId)),
        )
        .leftJoin(
          schema.userBoardActivity,
          and(
            eq(schema.userBoardActivity.boardUuid, schema.userBoards.uuid),
            eq(schema.userBoardActivity.userId, userId),
          ),
        );
    const boards = await joined()
      .where(conditions)
      .orderBy(
        sql`${schema.userBoardActivity.pinnedAt} IS NULL`,
        asc(schema.userBoardActivity.pinnedAt),
        sql`${schema.userBoardActivity.lastUsedAt} DESC NULLS LAST`,
        desc(schema.userBoards.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    // The count is needed even for an offset beyond the last page.
    const [countRow] = boards.length
      ? []
      : await db
          .select({ totalCount: count() })
          .from(schema.userBoards)
          .leftJoin(
            schema.boardFollows,
            and(eq(schema.boardFollows.boardUuid, schema.userBoards.uuid), eq(schema.boardFollows.userId, userId)),
          )
          .leftJoin(
            schema.userBoardActivity,
            and(
              eq(schema.userBoardActivity.boardUuid, schema.userBoards.uuid),
              eq(schema.userBoardActivity.userId, userId),
            ),
          )
          .where(conditions);
    const totalCount = Number(boards[0]?.totalCount ?? countRow?.totalCount ?? 0);
    return {
      currentBoard: currentBoard ?? null,
      boards,
      totalCount,
      hasMore: page.offset + boards.length < totalCount,
    };
  },
};
