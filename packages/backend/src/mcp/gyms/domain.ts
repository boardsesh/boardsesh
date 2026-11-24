import { and, count, desc, eq, exists, inArray, isNull, ne, or } from 'drizzle-orm';
import { GraphQLError, graphql } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as tables from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { isDatabaseLeakError } from '../../graphql/mask-error';
import {
  enrichGym,
  requireGymEditAccess,
  requireGymGrantAccess,
  requireGymOwnerOrAdmin,
  resolveCanonicalGymByUuid,
  viewerCanSeeGym,
} from '../../graphql/resolvers/social/gyms';
import { canAccessResource } from '../../services/privacy';
import { gymMcpDocuments, type GymMcpDocumentName } from './documents';

export type GymToolResult = Record<string, unknown>;
export type GymOperationArguments = Record<string, unknown>;
export type GymToolExecutor = (
  document: GymMcpDocumentName,
  variables: GymOperationArguments,
  context: ConnectionContext,
) => Promise<GymToolResult>;

function notFound(): GraphQLError {
  return new GraphQLError('The gym or item is unavailable.', { extensions: { code: 'NOT_FOUND' } });
}

/** Only committed, fixed server documents reach GraphQL; callers cannot supply query text. */
export const executeGymDocument: GymToolExecutor = async (document, variables, context) => {
  const { schema } = await import('../../graphql/index');
  const result = await graphql({
    schema,
    source: gymMcpDocuments[document],
    variableValues: variables,
    contextValue: context,
  });
  if (result.errors?.length) {
    const failure = result.errors[0]!;
    if (isDatabaseLeakError(failure)) {
      throw new GraphQLError('The gym action could not be completed. Try again.', {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }
    // graphql() catches resolver failures. Throw again so the enclosing OAuth
    // transaction rolls back the action AND its idempotency receipt.
    throw failure;
  }
  return result.data ?? {};
};

export async function resolveGymForTool(gymUuid: string, userId: string, management = true, lock = false) {
  const gym = await resolveCanonicalGymByUuid(gymUuid);
  if (gym && lock) {
    const [locked] = await db
      .select({ uuid: tables.gyms.uuid })
      .from(tables.gyms)
      .where(and(eq(tables.gyms.id, gym.id), isNull(tables.gyms.deletedAt), isNull(tables.gyms.mergedIntoGymId)))
      .for('update');
    if (!locked) throw notFound();
    // Gym ownership, a staff membership, and a covering community role are
    // independent authorities. Hold each live row until the action commits,
    // including against legacy membership removals that do not lock the gym.
    await db
      .select({ id: tables.gymMembers.id })
      .from(tables.gymMembers)
      .where(and(eq(tables.gymMembers.gymId, gym.id), eq(tables.gymMembers.userId, userId)))
      .for('share');
    await db
      .select({ userId: tables.communityRoles.userId })
      .from(tables.communityRoles)
      .where(eq(tables.communityRoles.userId, userId))
      .for('share');
  }
  if (!gym || !(await viewerCanSeeGym(gym, userId))) throw notFound();
  if (management) await requireGymEditAccess(gym.uuid, userId);
  return gym;
}

export async function assertBoardInGym(
  boardUuid: string,
  gymId: number,
  userId: string,
  allowDeleted = false,
): Promise<void> {
  const [board] = await db
    .select({ uuid: tables.userBoards.uuid, deletedAt: tables.userBoards.deletedAt })
    .from(tables.userBoards)
    .where(
      and(
        eq(tables.userBoards.uuid, boardUuid),
        eq(tables.userBoards.gymId, gymId),
        allowDeleted ? undefined : isNull(tables.userBoards.deletedAt),
      ),
    )
    .limit(1)
    .for('share');
  if (!board) throw notFound();
  if (!(allowDeleted && board.deletedAt !== null) && !(await canAccessResource('board', boardUuid, userId)))
    throw notFound();
}

export async function assertKioskInGym(kioskUuid: string, gymId: number, allowDeleted = false): Promise<void> {
  const [kiosk] = await db
    .select({ uuid: tables.gymKiosks.uuid })
    .from(tables.gymKiosks)
    .where(
      and(
        eq(tables.gymKiosks.uuid, kioskUuid),
        eq(tables.gymKiosks.gymId, gymId),
        allowDeleted ? undefined : isNull(tables.gymKiosks.deletedAt),
      ),
    )
    .limit(1)
    .for('share');
  if (!kiosk) throw notFound();
}

export async function assertCommentInGym(commentUuid: string, gymUuid: string, allowMissing = false): Promise<void> {
  const [comment] = await db
    .select({ uuid: tables.comments.uuid, entityType: tables.comments.entityType, entityId: tables.comments.entityId })
    .from(tables.comments)
    .where(eq(tables.comments.uuid, commentUuid))
    .limit(1)
    .for('share');
  if (!comment && allowMissing) return;
  if (!comment || comment.entityType !== 'gym' || comment.entityId !== gymUuid) throw notFound();
}

/** Replays retain the same current action authority, including after a role change. */
export async function assertGymActionPermission(
  name: string,
  arguments_: GymOperationArguments,
  gym: { id: number; uuid: string },
  context: ConnectionContext,
  replay: boolean,
): Promise<void> {
  const userId = context.userId!;
  if (name === 'grant_gym_edit_access' || name === 'revoke_gym_edit_access') {
    await requireGymGrantAccess(gym.uuid, userId);
  } else if (name === 'remove_gym_member' || name === 'group_gym_reporting_boards') {
    await requireGymOwnerOrAdmin(gym.uuid, userId);
  } else if (['update_gym_board', 'apply_reported_board_setup', 'delete_gym_board'].includes(name)) {
    const [board] = await db
      .select()
      .from(tables.userBoards)
      .where(and(eq(tables.userBoards.uuid, String(arguments_.boardUuid)), eq(tables.userBoards.gymId, gym.id)))
      .limit(1);
    if (!board) throw notFound();
    const { requireBoardDeleteAccess, requireBoardEditAccess } = await import('../../graphql/resolvers/social/boards');
    if (name !== 'delete_gym_board') await requireBoardEditAccess(context, board);
    else if (replay && board.deletedAt !== null) {
      if (board.ownerId === userId) return;
      const { SYSTEM_BOARD_OWNER_ID } = await import('@boardsesh/shared-schema');
      if (board.ownerId === SYSTEM_BOARD_OWNER_ID) {
        try {
          await requireGymOwnerOrAdmin(gym.uuid, userId);
        } catch {
          const { requireAdmin } = await import('../../graphql/resolvers/social/roles');
          await requireAdmin(context);
        }
      } else {
        const { requireAdmin } = await import('../../graphql/resolvers/social/roles');
        await requireAdmin(context);
      }
    } else await requireBoardDeleteAccess(userId, board);
  } else if (name === 'update_gym_comment' || name === 'delete_gym_comment') {
    const [comment] = await db
      .select({ userId: tables.comments.userId })
      .from(tables.comments)
      .where(eq(tables.comments.uuid, String(arguments_.commentUuid)))
      .limit(1);
    if (!comment && replay && name === 'delete_gym_comment') return;
    if (!comment || comment.userId !== userId) {
      throw new GraphQLError('You can only change your own comments.', { extensions: { code: 'FORBIDDEN' } });
    }
  } else if (name === 'keep_reported_gym_board') {
    const [report] = await db
      .select({ boardId: tables.directoryReports.boardId })
      .from(tables.directoryReports)
      .where(eq(tables.directoryReports.uuid, String(arguments_.reportUuid)))
      .limit(1);
    if (!report?.boardId) throw notFound();
    const [board] = await db
      .select({ ownerId: tables.userBoards.ownerId, uuid: tables.userBoards.uuid })
      .from(tables.userBoards)
      .where(eq(tables.userBoards.id, report.boardId))
      .limit(1);
    if (!board || !(await canAccessResource('board', board.uuid, userId))) throw notFound();
    if (board.ownerId !== userId) {
      try {
        await requireGymOwnerOrAdmin(gym.uuid, userId);
      } catch {
        const { requireAdmin } = await import('../../graphql/resolvers/social/roles');
        await requireAdmin(context);
      }
    }
  }
}

/** A creator unlinks their own board; staff detachment also freezes relinking/sync. */
export async function authorizeGymBoardRemoval(gymUuid: string, boardUuid: string, userId: string, replay: boolean) {
  const gym = await resolveGymForTool(gymUuid, userId, true, true);
  const [board] = await db
    .select({ ownerId: tables.userBoards.ownerId, gymId: tables.userBoards.gymId })
    .from(tables.userBoards)
    .where(and(eq(tables.userBoards.uuid, boardUuid), isNull(tables.userBoards.deletedAt)))
    .limit(1);
  if (
    !board ||
    (board.gymId !== gym.id && !(replay && board.gymId === null)) ||
    !(await canAccessResource('board', boardUuid, userId))
  )
    throw notFound();
  return { gym, ownBoard: board.ownerId === userId };
}

export async function assertReportInGym(reportUuid: string, gymId: number): Promise<void> {
  const [report] = await db
    .select({ uuid: tables.directoryReports.uuid })
    .from(tables.directoryReports)
    .where(
      and(
        eq(tables.directoryReports.uuid, reportUuid),
        or(eq(tables.directoryReports.gymId, gymId), eq(tables.directoryReports.gymIdAtReport, gymId)),
      ),
    )
    .limit(1)
    .for('share');
  if (!report) throw notFound();
}

/** Membership alone is insufficient: apply every management predicate BEFORE LIMIT/OFFSET. */
export function managedGymPredicate(userId: string) {
  const staff = db
    .select({ gymId: tables.gymMembers.gymId })
    .from(tables.gymMembers)
    .where(and(eq(tables.gymMembers.userId, userId), inArray(tables.gymMembers.role, ['admin', 'editor'])));
  const coveringRole = db
    .select({ userId: tables.communityRoles.userId })
    .from(tables.communityRoles)
    .where(
      and(
        eq(tables.communityRoles.userId, userId),
        inArray(tables.communityRoles.role, ['admin', 'community_leader']),
        or(
          isNull(tables.communityRoles.boardType),
          exists(
            db
              .select({ id: tables.userBoards.id })
              .from(tables.userBoards)
              .where(
                and(
                  eq(tables.userBoards.gymId, tables.gyms.id),
                  isNull(tables.userBoards.deletedAt),
                  eq(tables.userBoards.boardType, tables.communityRoles.boardType),
                ),
              ),
          ),
        ),
      ),
    );
  return and(
    isNull(tables.gyms.deletedAt),
    isNull(tables.gyms.mergedIntoGymId),
    or(eq(tables.gyms.ownerId, userId), inArray(tables.gyms.id, staff), exists(coveringRole)),
  );
}

export async function listManagedGyms(userId: string, limit: number, offset: number): Promise<GymToolResult> {
  const predicate = managedGymPredicate(userId);
  const [countRows, gymRows] = await Promise.all([
    db.select({ total: count() }).from(tables.gyms).where(predicate),
    db
      .select()
      .from(tables.gyms)
      .where(predicate)
      .orderBy(desc(tables.gyms.createdAt), tables.gyms.id)
      .limit(limit)
      .offset(offset),
  ]);
  const gyms = await Promise.all(
    gymRows.map(async (gym) => {
      const enriched = await enrichGym(gym, userId);
      return {
        uuid: enriched.uuid,
        slug: enriched.slug,
        name: enriched.name,
        myRole: enriched.myRole,
        canEdit: enriched.canEdit,
        canGrantAccess: enriched.canGrantAccess,
        boardCount: enriched.boardCount,
        memberCount: enriched.memberCount,
      };
    }),
  );
  const totalCount = Number(countRows[0]?.total ?? 0);
  return { gyms, totalCount, hasMore: offset + gyms.length < totalCount };
}

/** Own boards only, before pagination; followed boards cannot be linked as the caller's. */
export async function listLinkableBoards(
  userId: string,
  gymId: number,
  limit: number,
  offset: number,
): Promise<GymToolResult> {
  const predicate = and(
    eq(tables.userBoards.ownerId, userId),
    isNull(tables.userBoards.deletedAt),
    or(isNull(tables.userBoards.gymId), ne(tables.userBoards.gymId, gymId)),
  );
  const [countRows, boards] = await Promise.all([
    db.select({ total: count() }).from(tables.userBoards).where(predicate),
    db
      .select({
        uuid: tables.userBoards.uuid,
        name: tables.userBoards.name,
        boardType: tables.userBoards.boardType,
        layoutId: tables.userBoards.layoutId,
        sizeId: tables.userBoards.sizeId,
        setIds: tables.userBoards.setIds,
        angle: tables.userBoards.angle,
      })
      .from(tables.userBoards)
      .where(predicate)
      .orderBy(tables.userBoards.id)
      .limit(limit)
      .offset(offset),
  ]);
  const totalCount = Number(countRows[0]?.total ?? 0);
  return { boards, totalCount, hasMore: offset + boards.length < totalCount };
}
