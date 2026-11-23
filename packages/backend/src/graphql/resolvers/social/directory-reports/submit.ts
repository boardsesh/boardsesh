import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as dbSchema from '@boardsesh/db/schema';
import type { DirectoryReport } from '@boardsesh/db/schema';
import {
  normalizeReportNote,
  reportNoteProblem,
  routeBoardReport,
  routeGymReport,
  type BoardReportReason,
  type DirectoryReportReason,
  type GymReportReason,
  type DirectoryReportRecipient,
  type DirectoryReportRouting,
} from '@boardsesh/directory-moderation';
import { db } from '../../../../db/client';
import { captureBackendEvent } from '../../../../services/analytics/posthog';
import { canAccessBoard } from '../../../../services/privacy';
import { gymVisibleCondition } from '../gym-visibility';
import { isBoardHeldOffGym } from '../board-moderation-events';
import {
  gymManagerIds,
  isSystemOwner,
  loadGymFacts,
  WAITING_STATUSES,
  type BoardFacts,
  type DirectoryExecutor,
  type GymFacts,
} from './core';
import { sendDirectoryNotices, type PendingDirectoryNotice } from './notices';

// ============================================
// Directory reports: filing one
// ============================================
//
// `reportBoard` / `reportGym` (docs/product/directory-reports.md, "Filing a
// report"). The join semantics are `reportClimb`'s: the first reporter opens
// the report, later reporters on the same target and reason join it, and a
// second report from the same climber is `already_reported` and writes nothing.

export type SubmitStatus = 'created' | 'added' | 'already_reported';

export type FiledReport = {
  status: SubmitStatus;
  report: DirectoryReport;
  otherReporterCount: number;
};

type ReportTarget = { kind: 'board'; board: BoardFacts } | { kind: 'gym'; gym: GymFacts };

type FileReportInput = {
  reporterId: string;
  target: ReportTarget;
  reason: DirectoryReportReason;
  /** Board reports: the gym the report concerns (the board's, or the removal gym for relist_request). */
  gymIdAtReport: number | null;
  duplicateOfBoardId: number | null;
  duplicateOfGymId: number | null;
  note: string | null;
  routing: DirectoryReportRouting;
};

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

function boardNotFound(): GraphQLError {
  return new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
}

function gymNotFound(): GraphQLError {
  return new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
}

/** The trimmed note, or a refusal worded for the report sheet. */
export function checkedReportNote(reason: string, rawNote: string | null | undefined): string | null {
  const problem = reportNoteProblem(reason, rawNote);
  if (problem === 'too_long') throw badInput('Keep the note under 500 characters.');
  if (problem === 'required' || problem === 'too_short') {
    throw badInput('Tell them what is wrong in at least 10 characters.');
  }
  return normalizeReportNote(rawNote);
}

/** A live board the reporter can read, by its uuid (the link they hold). */
async function loadReadableBoard(boardUuid: string, viewerId: string): Promise<BoardFacts | undefined> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      name: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      ownerId: dbSchema.userBoards.ownerId,
      gymId: dbSchema.userBoards.gymId,
      deletedAt: dbSchema.userBoards.deletedAt,
      mergedIntoBoardUuid: dbSchema.userBoards.mergedIntoBoardUuid,
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.uuid, boardUuid),
        isNull(dbSchema.userBoards.deletedAt),
        isNull(dbSchema.userBoards.mergedIntoBoardUuid),
      ),
    )
    .limit(1);
  if (!board || !(await canAccessBoard(board.uuid, viewerId, board.uuid))) return undefined;
  return board;
}

/** A live, unmerged gym the reporter can see, by uuid. */
async function loadVisibleGym(gymUuid: string, viewerId: string): Promise<GymFacts | undefined> {
  const [row] = await db
    .select({ id: dbSchema.gyms.id })
    .from(dbSchema.gyms)
    .where(
      and(
        eq(dbSchema.gyms.uuid, gymUuid),
        isNull(dbSchema.gyms.deletedAt),
        isNull(dbSchema.gyms.mergedIntoGymId),
        gymVisibleCondition(dbSchema.gyms, viewerId),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  return (await loadGymFacts([row.id])).get(row.id);
}

/**
 * The gym a `relist_request` asks to be put back on: the gym in the board's
 * latest staff removal, while that removal still holds it off and the gym is
 * live. Null when the board has no such removal.
 */
async function relistGymFor(board: BoardFacts): Promise<GymFacts | null> {
  const [latest] = await db
    .select({
      action: dbSchema.boardModerationEvents.action,
      actorRole: dbSchema.boardModerationEvents.actorRole,
      gymId: dbSchema.boardModerationEvents.gymId,
    })
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.boardId, board.id),
        inArray(dbSchema.boardModerationEvents.action, ['removed_from_gym', 'relinked']),
      ),
    )
    .orderBy(desc(dbSchema.boardModerationEvents.id))
    .limit(1);
  if (!latest || latest.action !== 'removed_from_gym' || latest.actorRole === 'board_owner' || latest.gymId == null) {
    return null;
  }
  if (!(await isBoardHeldOffGym(board.id, latest.gymId))) return null;
  const gym = (await loadGymFacts([latest.gymId])).get(latest.gymId);
  return gym && gym.deletedAt === null ? gym : null;
}

/** Validate a `reportBoard` call and route it. Throws the error the reporter should read. */
export async function prepareBoardReport(
  reporterId: string,
  input: { boardUuid: string; reason: BoardReportReason; duplicateOfBoardUuid?: string | null; note?: string | null },
): Promise<FileReportInput> {
  const board = await loadReadableBoard(input.boardUuid, reporterId);
  if (!board) throw boardNotFound();
  const note = checkedReportNote(input.reason, input.note);
  const viewerIsCreator = board.ownerId === reporterId;

  if (input.reason === 'relist_request') {
    if (!viewerIsCreator) {
      throw new GraphQLError('Only the climber who added this board can ask for it to be listed again.', {
        extensions: { code: 'FORBIDDEN' },
      });
    }
    if (board.gymId != null) throw badInput('This board is on a gym already.');
    const gym = await relistGymFor(board);
    if (!gym) throw badInput("This board wasn't taken off a gym by its staff.");
    return {
      reporterId,
      target: { kind: 'board', board },
      reason: input.reason,
      gymIdAtReport: gym.id,
      duplicateOfBoardId: null,
      duplicateOfGymId: null,
      note,
      routing: routeBoardReport({
        reason: input.reason,
        boardOwnedBySystem: isSystemOwner(board.ownerId),
        viewerIsCreator,
        hasGym: true,
        gymListingState: gym.listingState,
      }),
    };
  }

  let duplicateOfBoardId: number | null = null;
  if (input.duplicateOfBoardUuid) {
    if (input.reason !== 'duplicate') throw badInput('Only a "listed twice" report names another board.');
    if (input.duplicateOfBoardUuid === board.uuid) throw badInput("A board can't be listed twice as itself.");
    const duplicate = await loadReadableBoard(input.duplicateOfBoardUuid, reporterId);
    if (!duplicate) throw badInput('The other board was not found.');
    duplicateOfBoardId = duplicate.id;
  }

  const gym = board.gymId != null ? ((await loadGymFacts([board.gymId])).get(board.gymId) ?? null) : null;
  const liveGym = gym && gym.deletedAt === null ? gym : null;
  return {
    reporterId,
    target: { kind: 'board', board },
    reason: input.reason,
    gymIdAtReport: liveGym?.id ?? null,
    duplicateOfBoardId,
    duplicateOfGymId: null,
    note,
    routing: routeBoardReport({
      reason: input.reason,
      boardOwnedBySystem: isSystemOwner(board.ownerId),
      viewerIsCreator,
      hasGym: liveGym !== null,
      gymListingState: liveGym?.listingState ?? null,
    }),
  };
}

/** Validate a `reportGym` call and route it. Throws the error the reporter should read. */
export async function prepareGymReport(
  reporterId: string,
  input: {
    gymUuid: string;
    reason: GymReportReason;
    duplicateOfGymUuid?: string | null;
    note?: string | null;
  },
): Promise<FileReportInput> {
  const gym = await loadVisibleGym(input.gymUuid, reporterId);
  if (!gym) throw gymNotFound();
  const note = checkedReportNote(input.reason, input.note);
  let duplicateOfGymId: number | null = null;
  if (input.duplicateOfGymUuid) {
    if (input.reason !== 'duplicate') throw badInput('Only a "listed twice" report names another gym.');
    if (input.duplicateOfGymUuid === gym.uuid) throw badInput("A gym can't be listed twice as itself.");
    const duplicate = await loadVisibleGym(input.duplicateOfGymUuid, reporterId);
    if (!duplicate) throw badInput('The other gym was not found.');
    duplicateOfGymId = duplicate.id;
  }
  return {
    reporterId,
    target: { kind: 'gym', gym },
    reason: input.reason,
    gymIdAtReport: null,
    duplicateOfBoardId: null,
    duplicateOfGymId,
    note,
    routing: routeGymReport({ reason: input.reason, gymListingState: gym.listingState }),
  };
}

/** The people a new report reaches, by account, minus the reporter. */
async function recipientUserIds(
  executor: DirectoryExecutor,
  input: FileReportInput,
  routedTo: readonly DirectoryReportRecipient[],
): Promise<{ creatorIds: string[]; staffIds: string[] }> {
  const creatorIds: string[] = [];
  if (routedTo.includes('creator') && input.target.kind === 'board') {
    const { ownerId } = input.target.board;
    if (!isSystemOwner(ownerId) && ownerId !== input.reporterId) creatorIds.push(ownerId);
  }
  let staffIds: string[] = [];
  if (routedTo.includes('gym_staff')) {
    const staffGymId = input.target.kind === 'board' ? input.gymIdAtReport : input.target.gym.id;
    if (staffGymId != null) {
      staffIds = (await gymManagerIds(staffGymId, executor)).filter(
        (userId) => userId !== input.reporterId && !creatorIds.includes(userId),
      );
    }
  }
  return { creatorIds, staffIds };
}

async function countReporters(executor: DirectoryExecutor, reportId: number): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.directoryReportReporters)
    .where(eq(dbSchema.directoryReportReporters.reportId, reportId));
  return row?.count ?? 0;
}

/**
 * Open a report or join the waiting one, and tell the people it reaches. One
 * transaction; the partial unique index decides a race between two first
 * reporters, and the loser joins the winner's report.
 */
export async function fileReport(input: FileReportInput): Promise<FiledReport> {
  const filed = await db.transaction(async (tx) => {
    const targetColumns =
      input.target.kind === 'board'
        ? { boardId: input.target.board.id, gymId: null }
        : { boardId: null, gymId: input.target.gym.id };
    const targetCondition =
      input.target.kind === 'board'
        ? eq(dbSchema.directoryReports.boardId, input.target.board.id)
        : eq(dbSchema.directoryReports.gymId, input.target.gym.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      const escalateNow = input.routing.escalateNow;
      const [created] = await tx
        .insert(dbSchema.directoryReports)
        .values({
          uuid: randomUUID(),
          targetKind: input.target.kind,
          ...targetColumns,
          gymIdAtReport: input.target.kind === 'board' ? input.gymIdAtReport : null,
          reason: input.reason,
          duplicateOfBoardId: input.duplicateOfBoardId,
          duplicateOfGymId: input.duplicateOfGymId,
          status: escalateNow ? 'escalated' : 'open',
          routedTo: [...input.routing.recipients],
          createdAt: now,
          escalatedAt: escalateNow ? now : null,
        })
        // The predicate names the partial unique index it infers, word for word
        // with `directory_reports_open_{board,gym}_reason_idx`; the two move together.
        .onConflictDoNothing({
          target:
            input.target.kind === 'board'
              ? [dbSchema.directoryReports.boardId, dbSchema.directoryReports.reason]
              : [dbSchema.directoryReports.gymId, dbSchema.directoryReports.reason],
          where:
            input.target.kind === 'board'
              ? sql`${dbSchema.directoryReports.boardId} IS NOT NULL AND ${dbSchema.directoryReports.status} IN ('open', 'escalated')`
              : sql`${dbSchema.directoryReports.gymId} IS NOT NULL AND ${dbSchema.directoryReports.status} IN ('open', 'escalated')`,
        })
        .returning();

      if (created) {
        await tx
          .insert(dbSchema.directoryReportReporters)
          .values({ reportId: created.id, reporterId: input.reporterId, note: input.note });
        const report = await notifyNewReport(tx, input, created);
        return { status: 'created' as const, report, otherReporterCount: 0 };
      }

      const [waiting] = await tx
        .select()
        .from(dbSchema.directoryReports)
        .where(
          and(
            targetCondition,
            eq(dbSchema.directoryReports.reason, input.reason),
            inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]),
          ),
        )
        .limit(1)
        .for('update');
      // Closed between the insert and this read: open a fresh one.
      if (!waiting) continue;

      const joined = await tx
        .insert(dbSchema.directoryReportReporters)
        .values({ reportId: waiting.id, reporterId: input.reporterId, note: input.note })
        .onConflictDoNothing({
          target: [dbSchema.directoryReportReporters.reportId, dbSchema.directoryReportReporters.reporterId],
          where: sql`${dbSchema.directoryReportReporters.reporterId} IS NOT NULL`,
        })
        .returning({ id: dbSchema.directoryReportReporters.id });
      let report = waiting;
      // A later reporter can name the other board or gym the first one didn't.
      if (
        joined.length > 0 &&
        ((waiting.duplicateOfBoardId == null && input.duplicateOfBoardId != null) ||
          (waiting.duplicateOfGymId == null && input.duplicateOfGymId != null))
      ) {
        [report] = await tx
          .update(dbSchema.directoryReports)
          .set({
            duplicateOfBoardId: waiting.duplicateOfBoardId ?? input.duplicateOfBoardId,
            duplicateOfGymId: waiting.duplicateOfGymId ?? input.duplicateOfGymId,
          })
          .where(eq(dbSchema.directoryReports.id, waiting.id))
          .returning();
      }
      const reporterCount = await countReporters(tx, waiting.id);
      return {
        status: joined.length > 0 ? ('added' as const) : ('already_reported' as const),
        report,
        otherReporterCount: Math.max(0, reporterCount - 1),
      };
    }
    throw new GraphQLError("Your report didn't go through. Try again.", {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  captureBackendEvent('Board Report Submitted', {
    properties: {
      targetKind: filed.report.targetKind,
      reason: filed.report.reason,
      status: filed.status,
      routedTo: filed.report.routedTo.join(','),
    },
  });
  return filed;
}

/**
 * Tell the creator and gym staff a new report reached them: one notice per
 * person per report (later reporters join quietly). A report routed to people
 * who turn out to be nobody (a gym whose only staff member is the reporter)
 * goes to the admin queue at once instead.
 */
async function notifyNewReport(
  executor: DirectoryExecutor,
  input: FileReportInput,
  report: DirectoryReport,
): Promise<DirectoryReport> {
  const { creatorIds, staffIds } = await recipientUserIds(executor, input, report.routedTo);
  if (creatorIds.length === 0 && staffIds.length === 0 && !report.routedTo.includes('admin')) {
    const now = new Date();
    const [escalated] = await executor
      .update(dbSchema.directoryReports)
      .set({ status: 'escalated', escalatedAt: now, routedTo: [...report.routedTo, 'admin'] })
      .where(eq(dbSchema.directoryReports.id, report.id))
      .returning();
    return escalated;
  }
  const notices: PendingDirectoryNotice[] = [...creatorIds, ...staffIds].map((recipientId) =>
    input.target.kind === 'board'
      ? {
          recipientId,
          type: 'board_report_opened',
          target: {
            kind: 'board',
            boardId: input.target.board.id,
            boardUuid: input.target.board.uuid,
            ownerId: input.target.board.ownerId,
          },
          reportId: report.id,
          gymId: report.gymIdAtReport,
          push: true,
        }
      : {
          recipientId,
          type: 'gym_report_opened',
          target: { kind: 'gym', gymId: input.target.gym.id, gymUuid: input.target.gym.uuid },
          reportId: report.id,
        },
  );
  await sendDirectoryNotices(executor, notices);
  return report;
}

/**
 * Who a waiting report's seven-day reminder goes to: the same people the
 * opening notice reached, as they stand now.
 */
export async function reminderRecipients(
  executor: DirectoryExecutor,
  report: DirectoryReport,
  board: BoardFacts | undefined,
  gym: GymFacts | undefined,
): Promise<string[]> {
  const reporters = await executor
    .select({ reporterId: dbSchema.directoryReportReporters.reporterId })
    .from(dbSchema.directoryReportReporters)
    .where(eq(dbSchema.directoryReportReporters.reportId, report.id));
  const reporterIds = new Set(reporters.flatMap((row) => (row.reporterId ? [row.reporterId] : [])));
  const recipients = new Set<string>();
  if (report.routedTo.includes('creator') && board && !isSystemOwner(board.ownerId)) recipients.add(board.ownerId);
  if (report.routedTo.includes('gym_staff')) {
    const staffGymId = report.targetKind === 'board' ? report.gymIdAtReport : (gym?.id ?? null);
    if (staffGymId != null) for (const userId of await gymManagerIds(staffGymId, executor)) recipients.add(userId);
  }
  return [...recipients].filter((userId) => !reporterIds.has(userId));
}

/**
 * The older `reportGymDuplicate` path (an email to the team) also files a
 * "listed twice" directory report, so reports from app builds that predate
 * `reportGym` reach the admin queue too. The caller has already checked both
 * gyms. Not gated on the `directory-reports` flag: the report goes to the
 * admin queue only, and sends no notice while the flag is off.
 */
export async function fileLegacyGymDuplicateReport(input: {
  reporterId: string;
  gymId: number;
  duplicateGymId: number;
  note: string | null | undefined;
}): Promise<FiledReport | null> {
  const gyms = await loadGymFacts([input.gymId, input.duplicateGymId]);
  const gym = gyms.get(input.gymId);
  if (!gym) return null;
  const note = normalizeReportNote(input.note);
  return fileReport({
    reporterId: input.reporterId,
    target: { kind: 'gym', gym },
    reason: 'duplicate',
    gymIdAtReport: null,
    duplicateOfBoardId: null,
    duplicateOfGymId: gyms.has(input.duplicateGymId) ? input.duplicateGymId : null,
    note: note && note.length > 500 ? note.slice(0, 500) : note,
    routing: routeGymReport({ reason: 'duplicate', gymListingState: gym.listingState }),
  });
}
