import { and, count, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import type { AdminBoard, AdminBoardConnection, ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { AdminBoardsInputSchema } from '../../../validation/schemas/admin-boards';
import { UUIDSchema } from '../../../validation/schemas/primitives';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { updateBoardRecord } from './boards';
import { requireAdmin } from './roles';

function adminBoardSelection() {
  return db
    .select({
      board: dbSchema.userBoards,
      ownerName: dbSchema.users.name,
      ownerDisplayName: dbSchema.userProfiles.displayName,
      gymUuid: dbSchema.gyms.uuid,
      gymName: dbSchema.gyms.name,
      gymSlug: dbSchema.gyms.slug,
    })
    .from(dbSchema.userBoards)
    .leftJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.userBoards.ownerId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.userBoards.ownerId))
    .leftJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.userBoards.gymId));
}

type AdminBoardRow = Awaited<ReturnType<typeof adminBoardSelection>>[number];

/** This projection never enters ordinary UserBoard resolvers or their caches. */
function projectAdminBoard(row: AdminBoardRow, viewerId: string): AdminBoard {
  const { board, ownerName, ownerDisplayName, gymUuid, gymName, gymSlug } = row;
  return {
    uuid: board.uuid,
    slug: board.slug,
    ownerId: board.ownerId,
    ownerDisplayName: ownerDisplayName || ownerName || null,
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    name: board.name,
    description: board.description,
    locationName: board.locationName,
    latitude: board.latitude,
    longitude: board.longitude,
    isPublic: board.isPublic,
    isUnlisted: board.isUnlisted,
    hideLocation: board.hideLocation,
    isOwned: board.isOwned,
    angle: board.angle,
    isAngleAdjustable: board.isAngleAdjustable,
    hasLeds: board.hasLeds,
    serialNumber: board.ownerId === viewerId ? board.serialNumber : null,
    timerName: board.ownerId === viewerId ? board.timerName : null,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    gymUuid,
    gymName,
    gymSlug,
    canEdit: true,
  };
}

const activeBoardCondition = () =>
  and(isNull(dbSchema.userBoards.deletedAt), isNull(dbSchema.userBoards.mergedIntoBoardUuid));

export const adminBoardQueries = {
  adminBoards: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<AdminBoardConnection> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 60, 'adminBoards');
    const { query, boardType, limit, offset } = validateInput(AdminBoardsInputSchema, input, 'input');
    const search = query
      ? or(
          ilike(dbSchema.userBoards.name, `%${query}%`),
          ilike(dbSchema.userBoards.uuid, `%${query}%`),
          ilike(dbSchema.userBoards.slug, `%${query}%`),
          ilike(dbSchema.gyms.name, `%${query}%`),
          ilike(dbSchema.gyms.slug, `%${query}%`),
        )
      : undefined;
    const condition = and(
      activeBoardCondition(),
      boardType ? eq(dbSchema.userBoards.boardType, boardType) : undefined,
      search,
    );
    const [countRows, pageRows] = await Promise.all([
      db
        .select({ count: count() })
        .from(dbSchema.userBoards)
        .leftJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.userBoards.gymId))
        .where(condition),
      adminBoardSelection()
        .where(condition)
        .orderBy(desc(dbSchema.userBoards.createdAt), desc(dbSchema.userBoards.id))
        .limit(limit + 1)
        .offset(offset),
    ]);
    return {
      boards: pageRows.slice(0, limit).map((row) => projectAdminBoard(row, ctx.userId!)),
      totalCount: Number(countRows[0]?.count ?? 0),
      hasMore: pageRows.length > limit,
    };
  },

  adminBoard: async (
    _: unknown,
    { boardUuid }: { boardUuid: unknown },
    ctx: ConnectionContext,
  ): Promise<AdminBoard | null> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 60, 'adminBoard');
    const validatedUuid = validateInput(UUIDSchema, boardUuid, 'boardUuid');
    const [row] = await adminBoardSelection()
      .where(and(activeBoardCondition(), eq(dbSchema.userBoards.uuid, validatedUuid)))
      .limit(1);
    return row ? projectAdminBoard(row, ctx.userId!) : null;
  },
};

export const adminBoardMutations = {
  adminUpdateBoard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<AdminBoard> => {
    const updated = await updateBoardRecord(input, ctx, 'admin');
    // Reuse the committed row for the mutation response; the joined context
    // lookup must not replace it with a second editor's later write.
    const [context] = await adminBoardSelection().where(eq(dbSchema.userBoards.id, updated.id)).limit(1);
    if (!context) throw new Error('Board not found');
    return projectAdminBoard({ ...context, board: updated }, ctx.userId!);
  },
};
