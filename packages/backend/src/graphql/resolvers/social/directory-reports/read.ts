import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { DirectoryReport as DirectoryReportRow } from '@boardsesh/db/schema';
import { rolesGrantAdmin, type CommunityRoleScope } from '@boardsesh/community-roles';
import {
  isOpenDirectoryReportStatus,
  RECENTLY_RESOLVED_DAYS,
  reportEscalatesAt,
  type DirectoryReportStatus,
  type DirectoryReportTargetKind,
} from '@boardsesh/directory-moderation';
import type { DirectoryReport, DirectoryReportViewerRole } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { canAccessResource, resourceAccessCondition } from '../../../../services/privacy';
import {
  loadBoardFacts,
  loadGymFacts,
  viewerGymStaffing,
  WAITING_STATUSES,
  type BoardFacts,
  type DirectoryExecutor,
  type ViewerGymStaffing,
} from './core';
import { readSetupSnapshot, toBoardSetup } from './setup-snapshot';
import { getUserCommunityRoles } from '../roles';

// ============================================
// Directory reports: who reads them
// ============================================
//
// (docs/product/directory-reports.md, "Who sees a report")
//
// - The board's creator: every report on their board but their own relist
//   requests, which go to the gym.
// - Gym staff: reports routed to `gym_staff` for a gym they own, administer or
//   edit (the gym the board was at when reported, or the gym reported). Owners
//   and admins may close them; editors read only.
// - Global admins: everything. A report in the admin queue (routed there, or
//   escalated) is closed by a global admin only; the creator and staff read it.
//
// Reporters are anonymous to everyone but global admins, who see who reported
// each note. A board report also needs the board to be readable by the viewer:
// staff do not learn about a private board through its reports.

export type ReportViewer = {
  userId: string;
  isAdmin: boolean;
  staffing: ViewerGymStaffing;
};

/** The gym a report concerns, for staff: the board's gym at report time, or the gym reported. */
export function reportGymId(report: Pick<DirectoryReportRow, 'targetKind' | 'gymId' | 'gymIdAtReport'>): number | null {
  return report.targetKind === 'board' ? report.gymIdAtReport : report.gymId;
}

/** Why this viewer can read this report, or null when they can't. */
export function viewerRoleFor(
  report: Pick<DirectoryReportRow, 'targetKind' | 'gymId' | 'gymIdAtReport' | 'reason' | 'routedTo'>,
  board: Pick<BoardFacts, 'ownerId'> | undefined,
  viewer: ReportViewer,
): DirectoryReportViewerRole | null {
  if (report.targetKind === 'board' && board?.ownerId === viewer.userId && report.reason !== 'relist_request') {
    return 'creator';
  }
  const gymId = reportGymId(report);
  if (report.routedTo.includes('gym_staff') && gymId != null && viewer.staffing.staffed.has(gymId)) return 'gym_staff';
  if (viewer.isAdmin) return 'admin';
  return null;
}

/**
 * Whether a report is in the admin queue: routed there when it opened (a synced
 * board nobody runs, "wrong gym or place", which can be a home address) or
 * escalated since. Only a global admin closes such a report by hand; its creator
 * and the gym's staff read it, and the creator's own unlink leaves it open.
 */
export function isInAdminQueue(report: Pick<DirectoryReportRow, 'routedTo' | 'status'>): boolean {
  return report.status === 'escalated' || report.routedTo.includes('admin');
}

/**
 * Whether this viewer may close this report: global admins any waiting report
 * with any outcome; the creator and the gym's owner or admins, as kept, one that
 * is not in the admin queue.
 */
export function viewerCanResolve(
  report: Pick<DirectoryReportRow, 'targetKind' | 'gymId' | 'gymIdAtReport' | 'status' | 'routedTo'>,
  role: DirectoryReportViewerRole,
  viewer: ReportViewer,
): boolean {
  if (!isOpenDirectoryReportStatus(report.status)) return false;
  return viewerHasReportResolutionAccess(report, role, viewer);
}

/** Current resolution authority, independent of a completed receipt's lifecycle state. */
export function viewerHasReportResolutionAccess(
  report: Pick<DirectoryReportRow, 'targetKind' | 'gymId' | 'gymIdAtReport' | 'status' | 'routedTo'>,
  role: DirectoryReportViewerRole,
  viewer: ReportViewer,
): boolean {
  if (viewer.isAdmin) return true;
  if (isInAdminQueue(report)) return false;
  if (role === 'creator') return true;
  const gymId = reportGymId(report);
  return role === 'gym_staff' && gymId != null && viewer.staffing.managed.has(gymId);
}

export async function loadReportViewer(
  userId: string,
  roles: readonly CommunityRoleScope[],
  executor: DirectoryExecutor = db,
  gymIds?: readonly number[],
): Promise<ReportViewer> {
  return { userId, isAdmin: rolesGrantAdmin(roles, null), staffing: await viewerGymStaffing(userId, executor, gymIds) };
}

/** Both a resolver write and a receipt replay use the same viewer and private-board boundary. */
export async function loadReportResolutionAuthority(
  report: DirectoryReportRow,
  userId: string,
  executor: DirectoryExecutor = db,
) {
  const gymId = reportGymId(report);
  const viewer = await loadReportViewer(
    userId,
    await getUserCommunityRoles(userId, executor),
    executor,
    gymId != null ? [gymId] : [],
  );
  const board =
    report.boardId != null ? (await loadBoardFacts([report.boardId], executor)).get(report.boardId) : undefined;
  const role = viewerRoleFor(report, board, viewer);
  if (
    !role ||
    (role === 'gym_staff' &&
      report.targetKind === 'board' &&
      (!board || board.deletedAt !== null || !(await canAccessResource('board', board.uuid, userId, executor))))
  )
    return null;
  return { viewer, board, role };
}

const recentlyResolvedCutoff = () => new Date(Date.now() - RECENTLY_RESOLVED_DAYS * 24 * 60 * 60 * 1000);

/** Waiting, or closed within the recently-resolved window. */
function waitingOrRecent(): SQL {
  return or(
    inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]),
    gt(dbSchema.directoryReports.resolvedAt, recentlyResolvedCutoff()),
  )!;
}

/**
 * The GraphQL shape of these reports for this viewer, dropping any the viewer
 * cannot read (no role, or a board report on a board they cannot read). Order
 * is kept. Four batched reads, whatever the count.
 */
export async function presentReports(
  reports: readonly DirectoryReportRow[],
  viewer: ReportViewer,
): Promise<DirectoryReport[]> {
  if (reports.length === 0) return [];
  const boardIds = reports
    .flatMap((report) => [report.boardId, report.duplicateOfBoardId])
    .filter((id): id is number => id != null);
  const gymIds = reports
    .flatMap((report) => [report.gymId, report.gymIdAtReport, report.duplicateOfGymId])
    .filter((id): id is number => id != null);
  const [boards, gyms, reporters] = await Promise.all([
    loadBoardFacts(boardIds),
    loadGymFacts(gymIds),
    db
      .select({
        reportId: dbSchema.directoryReportReporters.reportId,
        reporterId: dbSchema.directoryReportReporters.reporterId,
        note: dbSchema.directoryReportReporters.note,
        suggestedSetup: dbSchema.directoryReportReporters.suggestedSetup,
        createdAt: dbSchema.directoryReportReporters.createdAt,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        name: dbSchema.users.name,
        image: dbSchema.users.image,
      })
      .from(dbSchema.directoryReportReporters)
      .leftJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.directoryReportReporters.reporterId))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.directoryReportReporters.reporterId))
      .where(
        inArray(
          dbSchema.directoryReportReporters.reportId,
          reports.map((report) => report.id),
        ),
      )
      .orderBy(asc(dbSchema.directoryReportReporters.createdAt), asc(dbSchema.directoryReportReporters.id)),
  ]);

  // Board reads: one check per distinct board the viewer neither created nor
  // reads as a global admin, for the reported board and a named duplicate.
  const readable = new Map<number, boolean>();
  const mayRead = async (boardId: number): Promise<boolean> => {
    const cached = readable.get(boardId);
    if (cached !== undefined) return cached;
    const board = boards.get(boardId);
    const allowed =
      board !== undefined &&
      board.deletedAt === null &&
      (viewer.isAdmin ||
        board.ownerId === viewer.userId ||
        (await canAccessResource('board', board.uuid, viewer.userId)));
    readable.set(boardId, allowed);
    return allowed;
  };

  const presented: DirectoryReport[] = [];
  for (const report of reports) {
    const board = report.boardId != null ? boards.get(report.boardId) : undefined;
    const role = viewerRoleFor(report, board, viewer);
    if (!role) continue;
    if (report.targetKind === 'board') {
      // A deleted board's reports stay readable to its creator and admins; staff
      // read a board report only while they can read the board.
      const boardReadable = report.boardId != null && (await mayRead(report.boardId));
      if (!boardReadable && !viewer.isAdmin && board?.ownerId !== viewer.userId) continue;
    }
    const gym = (() => {
      const gymId = reportGymId(report);
      return gymId != null ? gyms.get(gymId) : undefined;
    })();
    const duplicateBoard =
      report.duplicateOfBoardId != null && (await mayRead(report.duplicateOfBoardId))
        ? boards.get(report.duplicateOfBoardId)
        : undefined;
    const duplicateGym = report.duplicateOfGymId != null ? gyms.get(report.duplicateOfGymId) : undefined;
    const reportReporters = reporters.filter((row) => row.reportId === report.id);
    presented.push({
      uuid: report.uuid,
      targetKind: report.targetKind,
      reason: report.reason,
      status: report.status,
      routedTo: report.routedTo,
      boardUuid: board?.uuid ?? null,
      boardName: board?.name ?? null,
      boardType: board?.boardType ?? null,
      gymUuid: gym?.uuid ?? null,
      gymName: gym?.name ?? null,
      duplicateOfBoardUuid: duplicateBoard?.uuid ?? null,
      duplicateOfBoardName: duplicateBoard?.name ?? null,
      duplicateOfGymUuid: duplicateGym?.uuid ?? null,
      duplicateOfGymName: duplicateGym?.name ?? null,
      reporterCount: reportReporters.length,
      // A reporter with a note, a suggested setup or both. One who only
      // suggested a setup has an empty note, so builds that read notes alone
      // still render the row.
      notes: reportReporters.flatMap((row) => {
        const suggestedSetup = readSetupSnapshot(row.suggestedSetup);
        if (!row.note && !suggestedSetup) return [];
        return [
          {
            note: row.note ?? '',
            createdAt: row.createdAt.toISOString(),
            reporter:
              viewer.isAdmin && row.reporterId
                ? {
                    userId: row.reporterId,
                    displayName: row.displayName ?? row.name ?? null,
                    avatarUrl: row.avatarUrl ?? row.image ?? null,
                  }
                : null,
            suggestedSetup: suggestedSetup ? toBoardSetup(suggestedSetup) : null,
          },
        ];
      }),
      createdAt: report.createdAt.toISOString(),
      remindedAt: report.remindedAt?.toISOString() ?? null,
      escalatedAt: report.escalatedAt?.toISOString() ?? null,
      escalatesAt: reportEscalatesAt(report.createdAt).toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
      resolvedByRole: report.resolvedByRole ?? null,
      resolutionNote: report.resolutionNote ?? null,
      viewerRole: role,
      viewerIsReporter: reportReporters.some((row) => row.reporterId === viewer.userId),
      viewerCanResolve: viewerCanResolve(report, role, viewer),
    });
  }
  return presented;
}

/** `boardReports`: waiting and recently closed reports on one board, newest first. */
export async function boardReportsFor(
  boardUuid: string,
  userId: string,
  roles: readonly CommunityRoleScope[],
): Promise<DirectoryReport[]> {
  const [board] = await db
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.uuid, boardUuid))
    .limit(1);
  if (!board) return [];
  const reports = await db
    .select()
    .from(dbSchema.directoryReports)
    .where(and(eq(dbSchema.directoryReports.boardId, board.id), waitingOrRecent()))
    .orderBy(desc(dbSchema.directoryReports.createdAt), desc(dbSchema.directoryReports.id));
  if (reports.length === 0) return [];
  const viewer = await loadReportViewer(
    userId,
    roles,
    db,
    reports.flatMap((report) => (report.gymIdAtReport != null ? [report.gymIdAtReport] : [])),
  );
  return presentReports(reports, viewer);
}

/**
 * SQL twin of the board read in `presentReports`, for staff: a gym report, or
 * a board report on a live board the viewer can read (`canAccessResource`).
 */
function staffReadsTarget(viewerId: string): SQL {
  return or(
    eq(dbSchema.directoryReports.targetKind, 'gym'),
    exists(
      db
        .select({ one: sql`1` })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.id, dbSchema.directoryReports.boardId),
            isNull(dbSchema.userBoards.deletedAt),
            resourceAccessCondition('board', dbSchema.userBoards.uuid, viewerId),
          ),
        ),
    ),
  )!;
}

/**
 * `myDirectoryReportsToReview`: reports about boards the viewer created and
 * reports routed to the staff of gyms they run. Waiting first, oldest first;
 * then, with `includeResolved`, those closed recently, newest first.
 */
export async function reportsToReviewFor(
  userId: string,
  roles: readonly CommunityRoleScope[],
  options: { includeResolved: boolean; first: number },
): Promise<DirectoryReport[]> {
  const viewer = await loadReportViewer(userId, roles);
  const staffedGymIds = [...viewer.staffing.staffed];
  const ownBoards = db
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.ownerId, userId));
  const asCreator = and(
    eq(dbSchema.directoryReports.targetKind, 'board'),
    inArray(dbSchema.directoryReports.boardId, ownBoards),
    ne(dbSchema.directoryReports.reason, 'relist_request'),
  );
  const asStaff =
    staffedGymIds.length > 0
      ? and(
          sql`${dbSchema.directoryReports.routedTo} @> ARRAY['gym_staff']::directory_report_recipient[]`,
          or(
            inArray(dbSchema.directoryReports.gymIdAtReport, staffedGymIds),
            inArray(dbSchema.directoryReports.gymId, staffedGymIds),
          ),
          // `presentReports` drops a board report on a board staff can't read;
          // leave it out here too, before the limit, so it doesn't take a slot.
          viewer.isAdmin ? undefined : staffReadsTarget(userId),
        )
      : undefined;
  const waiting = inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]);
  const reports = await db
    .select()
    .from(dbSchema.directoryReports)
    .where(and(asStaff ? or(asCreator, asStaff) : asCreator, options.includeResolved ? waitingOrRecent() : waiting))
    .orderBy(
      sql`CASE WHEN ${dbSchema.directoryReports.status} IN ('open', 'escalated') THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${dbSchema.directoryReports.status} IN ('open', 'escalated') THEN ${dbSchema.directoryReports.createdAt} END ASC`,
      desc(dbSchema.directoryReports.resolvedAt),
      asc(dbSchema.directoryReports.id),
    )
    .limit(options.first);
  return presentReports(reports, viewer);
}

/** The admin queue's page cursor: the last row's creation time (ms) and id. */
function encodeCursor(report: Pick<DirectoryReportRow, 'createdAt' | 'id'>): string {
  return `${report.createdAt.getTime()}_${report.id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: number } {
  const [createdAtMs, id] = cursor.split('_');
  return { createdAt: new Date(Number(createdAtMs)), id: Number(id) };
}

/**
 * `adminDirectoryReports`: one status (default escalated), waiting ones oldest
 * first so the queue is worked from the top, closed ones newest first.
 */
export async function adminReportsPage(
  userId: string,
  roles: readonly CommunityRoleScope[],
  options: {
    status: DirectoryReportStatus;
    targetKind: DirectoryReportTargetKind | null;
    first: number;
    after: string | null;
  },
): Promise<{ reports: DirectoryReport[]; nextCursor: string | null }> {
  const ascending = isOpenDirectoryReportStatus(options.status);
  const cursor = options.after ? decodeCursor(options.after) : null;
  const after = cursor
    ? ascending
      ? or(
          gt(dbSchema.directoryReports.createdAt, cursor.createdAt),
          and(eq(dbSchema.directoryReports.createdAt, cursor.createdAt), gt(dbSchema.directoryReports.id, cursor.id)),
        )
      : or(
          lt(dbSchema.directoryReports.createdAt, cursor.createdAt),
          and(eq(dbSchema.directoryReports.createdAt, cursor.createdAt), lt(dbSchema.directoryReports.id, cursor.id)),
        )
    : undefined;
  const rows = await db
    .select()
    .from(dbSchema.directoryReports)
    .where(
      and(
        eq(dbSchema.directoryReports.status, options.status),
        options.targetKind ? eq(dbSchema.directoryReports.targetKind, options.targetKind) : undefined,
        after,
      ),
    )
    .orderBy(
      ascending ? asc(dbSchema.directoryReports.createdAt) : desc(dbSchema.directoryReports.createdAt),
      ascending ? asc(dbSchema.directoryReports.id) : desc(dbSchema.directoryReports.id),
    )
    .limit(options.first + 1);
  const page = rows.slice(0, options.first);
  const viewer: ReportViewer = {
    userId,
    isAdmin: rolesGrantAdmin(roles, null),
    staffing: { managed: new Set(), staffed: new Set() },
  };
  return {
    reports: await presentReports(page, viewer),
    nextCursor: rows.length > options.first ? encodeCursor(page[page.length - 1]) : null,
  };
}

export type BoardReportFlags = { openReportCount: number | null; viewerHasOpenReport: boolean | null };

/**
 * `UserBoard.openReportCount` and `viewerHasOpenReport` for a list of boards:
 * one read of the waiting reports, one of where the viewer is staff. A count
 * is set for the board's creator, a global admin, staff of the board's gym and
 * staff a waiting report was routed to; null for everyone else.
 */
export async function loadBoardReportFlags(
  boards: ReadonlyArray<{ id: number; ownerId: string; gymId: number | null }>,
  viewerId: string | undefined,
  viewerRoles: readonly CommunityRoleScope[],
): Promise<Map<number, BoardReportFlags>> {
  const flags = new Map<number, BoardReportFlags>();
  if (!viewerId) {
    for (const board of boards) flags.set(board.id, { openReportCount: null, viewerHasOpenReport: null });
    return flags;
  }
  if (boards.length === 0) return flags;
  const reports = await db
    .select({
      boardId: dbSchema.directoryReports.boardId,
      reason: dbSchema.directoryReports.reason,
      routedTo: dbSchema.directoryReports.routedTo,
      gymIdAtReport: dbSchema.directoryReports.gymIdAtReport,
      viewerIsReporter: exists(
        db
          .select({ one: sql`1` })
          .from(dbSchema.directoryReportReporters)
          .where(
            and(
              eq(dbSchema.directoryReportReporters.reportId, dbSchema.directoryReports.id),
              eq(dbSchema.directoryReportReporters.reporterId, viewerId),
            ),
          ),
      ),
    })
    .from(dbSchema.directoryReports)
    .where(
      and(
        isNotNull(dbSchema.directoryReports.boardId),
        inArray(
          dbSchema.directoryReports.boardId,
          boards.map((board) => board.id),
        ),
        inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]),
      ),
    );
  const isAdmin = rolesGrantAdmin(viewerRoles, null);
  const gymIds = [
    ...boards.flatMap((board) => (board.gymId != null ? [board.gymId] : [])),
    ...reports.flatMap((report) => (report.gymIdAtReport != null ? [report.gymIdAtReport] : [])),
  ];
  const staffing = isAdmin
    ? { managed: new Set<number>(), staffed: new Set<number>() }
    : await viewerGymStaffing(viewerId, db, gymIds);
  for (const board of boards) {
    const boardReports = reports.filter((report) => report.boardId === board.id);
    const isCreator = board.ownerId === viewerId;
    const visible = boardReports.filter(
      (report) =>
        isAdmin ||
        (isCreator && report.reason !== 'relist_request') ||
        (report.routedTo.includes('gym_staff') &&
          report.gymIdAtReport != null &&
          staffing.staffed.has(report.gymIdAtReport)),
    );
    const reviewer =
      isAdmin || isCreator || (board.gymId != null && staffing.staffed.has(board.gymId)) || visible.length > 0;
    flags.set(board.id, {
      openReportCount: reviewer ? visible.length : null,
      viewerHasOpenReport: boardReports.some((report) => report.viewerIsReporter === true),
    });
  }
  return flags;
}
