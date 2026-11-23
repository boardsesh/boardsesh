import { and, eq, inArray, ne, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardModerationActorRole, DirectoryReport, NewBoardModerationEvent } from '@boardsesh/db/schema';
import type { DirectoryReportOutcome, DirectoryReportResolverRole } from '@boardsesh/directory-moderation';
import { db } from '../../../../db/client';
import { captureBackendEvent } from '../../../../services/analytics/posthog';
import { viewerGymManagerRole, communityActorRole } from '../board-moderation-events';
import { getUserCommunityRoles } from '../roles';
import {
  analyticsActorFor,
  isSystemOwner,
  loadBoardFacts,
  loadGymFacts,
  resolverRoleForActor,
  WAITING_STATUSES,
  type DirectoryExecutor,
} from './core';
import { sendDirectoryNotices, type PendingDirectoryNotice } from './notices';

// ============================================
// Directory reports: closing them
// ============================================
//
// A report closes when someone acts on what it is about, in the same
// transaction as the action (docs/product/directory-reports.md, "Closing a
// report"):
//
// | Action                                             | Closes                          | As       |
// |----------------------------------------------------|---------------------------------|----------|
// | An edit that changes setup, name, place or angle   | `wrong_setup` on the board      | fixed    |
// | The board comes off a gym (staff or its creator)   | the board's reports at that gym | removed  |
// | The board is deleted                               | every report on the board       | deleted  |
// | Staff put a removed board back on their gym        | `relist_request` for that gym   | fixed    |
// | The merge tool folds the board into another        | every report on the board       | merged   |
// | `resolveDirectoryReport`                            | that report                     | its outcome |
//
// A timer-only edit (`updateBoard { boardUuid, timerName }`) changes no setup
// field, so it closes nothing. Every close tells the reporters, and every staff
// action on a climber's board tells its creator (notices.ts).

/** `updateBoard` fields whose change fixes a "set up wrong" report. */
export const REPORT_FIXING_BOARD_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'layoutId',
  'sizeId',
  'setIds',
  'angle',
  'isAngleAdjustable',
  'locationName',
  'latitude',
  'longitude',
]);

/** Spray wall mutations that are themselves a setup change: a new photo or hold set goes live. */
const REPORT_FIXING_MUTATIONS: ReadonlySet<string> = new Set(['commitSprayWallVersion', 'publishSprayWallVersion']);

export type ReportResolution = {
  outcome: DirectoryReportOutcome;
  /** The person who closed it; null for the system. */
  resolvedBy: string | null;
  role: DirectoryReportResolverRole;
  note?: string | null;
};

/**
 * Close every waiting report `where` selects, tell its reporters, and count it.
 * Reports already closed are left as they are, so every caller is idempotent.
 */
export async function resolveWaitingReports(
  executor: DirectoryExecutor,
  where: SQL,
  resolution: ReportResolution,
): Promise<DirectoryReport[]> {
  const now = new Date();
  const resolved = await executor
    .update(dbSchema.directoryReports)
    .set({
      status: resolution.outcome,
      resolvedAt: now,
      resolvedBy: resolution.resolvedBy,
      resolvedByRole: resolution.role,
      resolutionNote: resolution.note ?? null,
    })
    .where(and(where, inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES])))
    .returning();
  if (resolved.length === 0) return [];

  for (const report of resolved) {
    captureBackendEvent('Board Report Resolved', {
      properties: {
        targetKind: report.targetKind,
        reason: report.reason,
        outcome: resolution.outcome,
        resolvedBy: resolution.role,
        hoursOpen: Math.round(((now.getTime() - report.createdAt.getTime()) / 3_600_000) * 10) / 10,
      },
    });
  }
  await notifyReporters(executor, resolved, resolution.resolvedBy);
  return resolved;
}

async function notifyReporters(
  executor: DirectoryExecutor,
  reports: readonly DirectoryReport[],
  resolvedBy: string | null,
): Promise<void> {
  const reporters = await executor
    .select({
      reportId: dbSchema.directoryReportReporters.reportId,
      reporterId: dbSchema.directoryReportReporters.reporterId,
    })
    .from(dbSchema.directoryReportReporters)
    .where(
      inArray(
        dbSchema.directoryReportReporters.reportId,
        reports.map((report) => report.id),
      ),
    );
  if (reporters.length === 0) return;
  const [boards, gyms] = await Promise.all([
    loadBoardFacts(
      reports.flatMap((report) => (report.boardId != null ? [report.boardId] : [])),
      executor,
    ),
    loadGymFacts(
      reports.flatMap((report) => (report.gymId != null ? [report.gymId] : [])),
      executor,
    ),
  ]);
  const reportById = new Map(reports.map((report) => [report.id, report]));
  const notices: PendingDirectoryNotice[] = [];
  for (const { reportId, reporterId } of reporters) {
    const report = reportById.get(reportId);
    if (!report || !reporterId || reporterId === resolvedBy) continue;
    if (report.targetKind === 'board' && report.boardId != null) {
      const board = boards.get(report.boardId);
      if (!board) continue;
      notices.push({
        recipientId: reporterId,
        type: 'board_report_resolved',
        target: { kind: 'board', boardId: board.id, boardUuid: board.uuid, ownerId: board.ownerId },
        reportId: report.id,
        gymId: report.gymIdAtReport,
      });
    } else if (report.gymId != null) {
      const gym = gyms.get(report.gymId);
      if (!gym) continue;
      notices.push({
        recipientId: reporterId,
        type: 'gym_report_resolved',
        target: { kind: 'gym', gymId: gym.id, gymUuid: gym.uuid },
        reportId: report.id,
      });
    }
  }
  await sendDirectoryNotices(executor, notices);
}

/**
 * The role someone acting on a board closes its reports in: its creator, the
 * staff of its gym (owner or admin), or anyone else with edit reach (a
 * community leader or admin), who reads as `admin`.
 */
async function boardActorResolverRole(
  executor: DirectoryExecutor,
  actorUserId: string,
  board: { ownerId: string; gymId: number | null; boardType: string },
  knownActorRole?: BoardModerationActorRole,
): Promise<DirectoryReportResolverRole> {
  if (board.ownerId === actorUserId) return 'creator';
  if (knownActorRole) return resolverRoleForActor(knownActorRole);
  if (board.gymId != null && (await viewerGymManagerRole(board.gymId, actorUserId, executor))) return 'gym_staff';
  const communityRole = communityActorRole(await getUserCommunityRoles(actorUserId, executor), [board.boardType]);
  return communityRole ? resolverRoleForActor(communityRole) : 'admin';
}

/**
 * An edit to a board, by its creator or anyone else (`recordStaffBoardEdit`
 * calls it before anything else). One that changes the setup, name, place or
 * angle closes the board's "set up wrong" reports as fixed. `fields` are the
 * fields that changed; without them, the mutation itself is the change.
 */
export async function onBoardEdited(
  executor: DirectoryExecutor,
  input: {
    actorUserId: string;
    board: { id: number; ownerId: string; gymId: number | null; boardType: string };
    mutation: string;
    fields?: readonly string[];
    actorRole?: BoardModerationActorRole;
  },
): Promise<void> {
  const fixes =
    input.fields === undefined
      ? REPORT_FIXING_MUTATIONS.has(input.mutation)
      : input.fields.some((field) => REPORT_FIXING_BOARD_FIELDS.has(field));
  if (!fixes) return;
  const waiting = await executor
    .select({ id: dbSchema.directoryReports.id })
    .from(dbSchema.directoryReports)
    .where(
      and(
        eq(dbSchema.directoryReports.boardId, input.board.id),
        eq(dbSchema.directoryReports.reason, 'wrong_setup'),
        inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]),
      ),
    )
    .limit(1);
  if (waiting.length === 0) return;
  await resolveWaitingReports(
    executor,
    and(eq(dbSchema.directoryReports.boardId, input.board.id), eq(dbSchema.directoryReports.reason, 'wrong_setup'))!,
    {
      outcome: 'fixed',
      resolvedBy: input.actorUserId,
      role: await boardActorResolverRole(executor, input.actorUserId, input.board, input.actorRole),
    },
  );
}

/**
 * A board was soft-deleted, by its creator or anyone else, in the caller's
 * transaction. Closes every report on it as deleted, tells the creator when
 * someone else deleted it, and counts the delete.
 */
export async function onBoardDeleted(
  executor: DirectoryExecutor,
  input: {
    board: { id: number; uuid: string; ownerId: string; gymId: number | null };
    actorUserId: string;
    actorRole: BoardModerationActorRole;
  },
): Promise<void> {
  const { board, actorUserId, actorRole } = input;
  captureBackendEvent('Board Deleted', { properties: { by: analyticsActorFor(actorRole) } });
  await resolveWaitingReports(executor, eq(dbSchema.directoryReports.boardId, board.id), {
    outcome: 'deleted',
    resolvedBy: actorUserId,
    role: resolverRoleForActor(actorRole),
  });
  if (actorRole !== 'board_owner' && !isSystemOwner(board.ownerId)) {
    await sendDirectoryNotices(executor, [
      {
        recipientId: board.ownerId,
        type: 'board_deleted_by_staff',
        target: { kind: 'board', boardId: board.id, boardUuid: board.uuid, ownerId: board.ownerId },
        gymId: board.gymId,
        actorRole,
      },
    ]);
  }
}

/**
 * Every board moderation event, as it is recorded (`recordBoardModerationEvent`):
 *
 * - `removed_from_gym`: closes the board's reports filed while it was at that
 *   gym as removed, tells the creator when someone else removed it, and counts
 *   the removal. A creator's own unlink is recorded as an event by
 *   `board_owner`, so it closes them the same way.
 * - `relinked`: closes the creator's request to be put back on that gym as fixed.
 * - `edited_by_staff`: tells the creator.
 * - `deleted`: nothing here; `onBoardDeleted` runs for every delete, the
 *   creator's own included, which records no event.
 */
export async function onBoardModerationEvent(
  executor: DirectoryExecutor,
  event: NewBoardModerationEvent,
): Promise<void> {
  if (event.action === 'deleted') return;
  const boards = await loadBoardFacts([event.boardId], executor);
  const board = boards.get(event.boardId);
  if (!board) return;
  const actorUserId = event.actorUserId ?? null;
  const isStaff = event.actorRole !== 'board_owner';
  const creatorHears = isStaff && !isSystemOwner(board.ownerId) && actorUserId !== board.ownerId;
  const target = { kind: 'board' as const, boardId: board.id, boardUuid: board.uuid, ownerId: board.ownerId };

  if (event.action === 'removed_from_gym') {
    captureBackendEvent('Board Removed From Gym', { properties: { by: analyticsActorFor(event.actorRole) } });
    if (event.gymId != null) {
      await resolveWaitingReports(
        executor,
        and(
          eq(dbSchema.directoryReports.boardId, board.id),
          eq(dbSchema.directoryReports.gymIdAtReport, event.gymId),
          ne(dbSchema.directoryReports.reason, 'relist_request'),
        )!,
        { outcome: 'removed', resolvedBy: actorUserId, role: resolverRoleForActor(event.actorRole) },
      );
    }
    if (creatorHears) {
      await sendDirectoryNotices(executor, [
        {
          recipientId: board.ownerId,
          type: 'board_removed_from_gym',
          target,
          gymId: event.gymId ?? null,
          actorRole: event.actorRole,
        },
      ]);
    }
    return;
  }

  if (event.action === 'relinked') {
    if (event.gymId == null) return;
    await resolveWaitingReports(
      executor,
      and(
        eq(dbSchema.directoryReports.boardId, board.id),
        eq(dbSchema.directoryReports.gymIdAtReport, event.gymId),
        eq(dbSchema.directoryReports.reason, 'relist_request'),
      )!,
      { outcome: 'fixed', resolvedBy: actorUserId, role: resolverRoleForActor(event.actorRole) },
    );
    return;
  }

  if (event.action === 'edited_by_staff' && creatorHears) {
    await sendDirectoryNotices(executor, [
      {
        recipientId: board.ownerId,
        type: 'board_edited_by_staff',
        target,
        gymId: event.gymId ?? board.gymId,
        actorRole: event.actorRole,
      },
    ]);
  }
}

/**
 * The board merge tool's hand-off (docs/product/directory-reports.md, "Board
 * merge tool"). Call it in the merge's transaction once `boardId` has been
 * folded into `survivorBoardId`: every waiting report on the merged board, and
 * every "listed twice" report on the survivor that named the merged board,
 * closes as merged, and their reporters are told. Returns how many closed.
 */
export async function resolveReportsForMergedBoard(
  boardId: number,
  survivorBoardId: number,
  executor: DirectoryExecutor = db,
): Promise<number> {
  const auto = { outcome: 'merged', resolvedBy: null, role: 'auto' } as const;
  const onMerged = await resolveWaitingReports(executor, eq(dbSchema.directoryReports.boardId, boardId), auto);
  const onSurvivor = await resolveWaitingReports(
    executor,
    and(
      eq(dbSchema.directoryReports.boardId, survivorBoardId),
      eq(dbSchema.directoryReports.reason, 'duplicate'),
      eq(dbSchema.directoryReports.duplicateOfBoardId, boardId),
    )!,
    auto,
  );
  return onMerged.length + onSurvivor.length;
}
