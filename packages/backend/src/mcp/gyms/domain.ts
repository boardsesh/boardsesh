import { and, count, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { GraphQLError, graphql } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as tables from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { isDatabaseLeakError } from '../../graphql/mask-error';
import {
  enrichGym,
  userCanEditGym,
  userCanGrantGymAccess,
  userCanAdminGym,
  managedGymPredicate,
  resolveCanonicalGymByUuid,
  viewerCanSeeGym,
} from '../../graphql/resolvers/social/gyms';
import { canAccessResource } from '../../services/privacy';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
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

/**
 * First-party board writers may lock the board before a gym. MCP already holds
 * the gym, so it must never wait for a board held by that inverse lock order.
 */
async function lockBoardWithoutWaiting<Result>(work: () => PromiseLike<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (getPostgresErrorCode(error) !== '55P03') throw error;
    throw new GraphQLError('This board is changing. Retry the same action in a moment.', {
      extensions: { code: 'CONFLICT' },
    });
  }
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

export async function resolveGymForTool(
  gymUuid: string,
  userId: string,
  management = true,
  lock = false,
  authority: 'edit' | 'grant' | 'admin' = 'edit',
) {
  let gym = await resolveCanonicalGymByUuid(gymUuid);
  if (gym && lock) {
    const [locked] = await db
      .select()
      .from(tables.gyms)
      .where(and(eq(tables.gyms.id, gym.id), isNull(tables.gyms.deletedAt), isNull(tables.gyms.mergedIntoGymId)))
      // Serialize gym changes without blocking foreign-key checks for follows,
      // reports or new boards that reference this gym.
      .for('no key update');
    if (!locked) throw notFound();
    gym = locked;
  }
  if (!gym) throw notFound();
  const accessOptions = { lock };
  if (management) {
    const canManage =
      authority === 'grant' ? userCanGrantGymAccess : authority === 'admin' ? userCanAdminGym : userCanEditGym;
    if (!(await canManage(gym, userId, db, accessOptions))) {
      if (!(await viewerCanSeeGym(gym, userId, db, accessOptions))) throw notFound();
      throw new GraphQLError('Not authorized to edit this gym', { extensions: { code: 'FORBIDDEN' } });
    }
  } else if (!(await viewerCanSeeGym(gym, userId, db, accessOptions))) throw notFound();
  return gym;
}

export async function assertBoardInGym(
  boardUuid: string,
  gymId: number,
  userId: string,
  allowDeleted = false,
): Promise<void> {
  const query = () =>
    db
      .select({ uuid: tables.userBoards.uuid, deletedAt: tables.userBoards.deletedAt })
      .from(tables.userBoards)
      .where(
        and(
          eq(tables.userBoards.uuid, boardUuid),
          eq(tables.userBoards.gymId, gymId),
          allowDeleted ? undefined : isNull(tables.userBoards.deletedAt),
        ),
      )
      .limit(1);
  const [before] = await query();
  if (
    !before ||
    (!(allowDeleted && before.deletedAt !== null) && !(await canAccessResource('board', boardUuid, userId)))
  )
    throw notFound();
  const [board] = await lockBoardWithoutWaiting(() => query().for('share', { noWait: true }));
  if (!board || (!(allowDeleted && board.deletedAt !== null) && !(await canAccessResource('board', boardUuid, userId))))
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

/** Only receipt replays need these checks; first executions use the resolver's own guard. */
export async function assertGymReplayPermission(
  name: string,
  arguments_: GymOperationArguments,
  gym: { id: number; uuid: string },
  context: ConnectionContext,
): Promise<void> {
  const userId = context.userId!;
  if (['update_gym_board', 'apply_reported_board_setup', 'delete_gym_board'].includes(name)) {
    const [board] = await db
      .select()
      .from(tables.userBoards)
      .where(and(eq(tables.userBoards.uuid, String(arguments_.boardUuid)), eq(tables.userBoards.gymId, gym.id)))
      .limit(1);
    if (!board) throw notFound();
    const { requireBoardDeleteAccess, requireBoardEditAccess } = await import('../../graphql/resolvers/social/boards');
    if (name === 'delete_gym_board') await requireBoardDeleteAccess(userId, board, db, { deletedReceiptReplay: true });
    else await requireBoardEditAccess(context, board);
  } else if (name === 'update_gym_comment' || name === 'delete_gym_comment') {
    const [comment] = await db
      .select({ userId: tables.comments.userId })
      .from(tables.comments)
      .where(eq(tables.comments.uuid, String(arguments_.commentUuid)))
      .limit(1);
    if (!comment && name === 'delete_gym_comment') return;
    if (!comment) throw notFound();
    const { requireCommentAuthor } = await import('../../graphql/resolvers/social/comments');
    requireCommentAuthor(comment, userId, name === 'delete_gym_comment' ? 'delete' : 'edit');
  } else if (name === 'keep_reported_gym_board') {
    const [report] = await db
      .select()
      .from(tables.directoryReports)
      .where(eq(tables.directoryReports.uuid, String(arguments_.reportUuid)))
      .limit(1);
    if (!report) throw notFound();
    const { loadReportResolutionAuthority, viewerHasReportResolutionAccess } =
      await import('../../graphql/resolvers/social/directory-reports/read');
    const authority = await loadReportResolutionAuthority(report, userId);
    if (!authority) throw notFound();
    if (!viewerHasReportResolutionAccess(report, authority.role, authority.viewer))
      throw new GraphQLError('Not authorized to resolve this report', { extensions: { code: 'FORBIDDEN' } });
  }
}

/** A creator unlinks their own board; staff detachment also freezes relinking/sync. */
export async function authorizeGymBoardRemoval(gymUuid: string, boardUuid: string, userId: string, replay: boolean) {
  const gym = await resolveGymForTool(gymUuid, userId, true, true);
  if (!(await canAccessResource('board', boardUuid, userId))) throw notFound();
  const [board] = await lockBoardWithoutWaiting(() =>
    db
      .select({ ownerId: tables.userBoards.ownerId, gymId: tables.userBoards.gymId })
      .from(tables.userBoards)
      .where(
        and(
          eq(tables.userBoards.uuid, boardUuid),
          isNull(tables.userBoards.deletedAt),
          or(eq(tables.userBoards.gymId, gym.id), replay ? isNull(tables.userBoards.gymId) : undefined),
        ),
      )
      .limit(1)
      .for('update', { noWait: true }),
  );
  if (
    !board ||
    (board.gymId !== gym.id && !(replay && board.gymId === null)) ||
    !(await canAccessResource('board', boardUuid, userId))
  )
    throw notFound();
  if (replay && board.ownerId !== userId) {
    const { requireBoardDetachmentAccess } = await import('../../graphql/resolvers/social/gym-stray-boards');
    await requireBoardDetachmentAccess(board, userId);
  }
  return { gym, ownBoard: board.ownerId === userId };
}

export async function assertReportInGym(reportUuid: string, gymId: number, userId: string): Promise<void> {
  const [report] = await db
    .select({ uuid: tables.directoryReports.uuid, boardId: tables.directoryReports.boardId })
    .from(tables.directoryReports)
    .where(
      and(
        eq(tables.directoryReports.uuid, reportUuid),
        eq(tables.directoryReports.targetKind, 'board'),
        or(eq(tables.directoryReports.gymId, gymId), eq(tables.directoryReports.gymIdAtReport, gymId)),
      ),
    )
    .limit(1)
    .for('share');
  const boardId = report?.boardId;
  if (boardId == null) throw notFound();
  const [before] = await db
    .select({ uuid: tables.userBoards.uuid })
    .from(tables.userBoards)
    .where(and(eq(tables.userBoards.id, boardId), isNull(tables.userBoards.deletedAt)))
    .limit(1);
  if (!before || !(await canAccessResource('board', before.uuid, userId))) throw notFound();
  const [board] = await lockBoardWithoutWaiting(() =>
    db
      .select({ uuid: tables.userBoards.uuid })
      .from(tables.userBoards)
      .where(and(eq(tables.userBoards.id, boardId), isNull(tables.userBoards.deletedAt)))
      .limit(1)
      .for('share', { noWait: true }),
  );
  if (!board || !(await canAccessResource('board', board.uuid, userId))) throw notFound();
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
