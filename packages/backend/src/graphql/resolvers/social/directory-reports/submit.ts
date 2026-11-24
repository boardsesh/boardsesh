import { randomUUID } from 'node:crypto';
import { and, desc, eq, exists, gt, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardSetupSnapshot, DirectoryReport } from '@boardsesh/db/schema';
import type { BoardSetupInput } from '@boardsesh/shared-schema';
import {
  isBoardReportReason,
  normalizeReportNote,
  REPORT_REFILE_COOLDOWN_DAYS,
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
import { transactionWithAfterCommit } from '../../../../db/after-commit';
import { captureBackendEvent } from '../../../../services/analytics/posthog';
import { isDirectorySetupSuggestionsEnabled } from '../../../../services/directory-setup-suggestions-flag';
import { canAccessBoard, canAccessResource } from '../../../../services/privacy';
import { gymVisibleCondition } from '../gym-visibility';
import { isBoardHeldOffGym } from '../board-moderation-events';
import {
  gymManagerIds,
  isSystemOwner,
  loadGymFacts,
  lockBoardFacts,
  WAITING_STATUSES,
  type BoardFacts,
  type DirectoryExecutor,
  type GymFacts,
} from './core';
import { sendDirectoryNotices, type PendingDirectoryNotice } from './notices';
import {
  assertSuggestionDiffersNow,
  checkedSuggestedSetup,
  settleSetupSuggestion,
  suggestionMayChangeBoard,
  SuggestionNeedsChangeLock,
  type SettledSuggestion,
} from './setup-suggestion';

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
  /** What the report's suggested setup did; null when it carried none, or nothing was filed. */
  setup: SettledSuggestion | null;
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
  /**
   * A "Set up wrong" report's suggested setup (docs/product/directory-reports.md,
   * "Suggested setup"). `mayApply` is the `directory-setup-suggestions` flag,
   * read before the transaction: off, the suggestion is stored and waits.
   * `lockForChange` is the pre-check (`suggestionMayChangeBoard`): the filing
   * transaction locks the board row `FOR NO KEY UPDATE` instead of `FOR SHARE`.
   */
  suggestion?: { setup: BoardSetupSnapshot; mayApply: boolean; lockForChange: boolean } | null;
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
async function relistGymFor(board: BoardFacts, executor: DirectoryExecutor = db): Promise<GymFacts | null> {
  const [latest] = await executor
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
  if (!(await isBoardHeldOffGym(board.id, latest.gymId, executor))) return null;
  const gym = (await loadGymFacts([latest.gymId], executor)).get(latest.gymId);
  return gym && gym.deletedAt === null ? gym : null;
}

/**
 * Where a board report goes and the gym it concerns, for the board as it stands:
 * its gym, or for `relist_request` the gym whose staff removed it. Throws the
 * error the reporter should read when a relist request does not apply.
 */
async function routeBoard(
  board: BoardFacts,
  reporterId: string,
  reason: BoardReportReason,
  executor: DirectoryExecutor = db,
): Promise<Pick<FileReportInput, 'gymIdAtReport' | 'routing'>> {
  const viewerIsCreator = board.ownerId === reporterId;
  const boardOwnedBySystem = isSystemOwner(board.ownerId);
  if (reason === 'relist_request') {
    if (!viewerIsCreator) {
      throw new GraphQLError('Only the climber who added this board can ask for it to be listed again.', {
        extensions: { code: 'FORBIDDEN' },
      });
    }
    if (board.gymId != null) throw badInput('This board is on a gym already.');
    const gym = await relistGymFor(board, executor);
    if (!gym) throw badInput("This board wasn't taken off a gym by its staff.");
    return {
      gymIdAtReport: gym.id,
      routing: routeBoardReport({
        reason,
        boardOwnedBySystem,
        viewerIsCreator,
        hasGym: true,
        gymListingState: gym.listingState,
      }),
    };
  }
  const gym = board.gymId != null ? ((await loadGymFacts([board.gymId], executor)).get(board.gymId) ?? null) : null;
  const liveGym = gym && gym.deletedAt === null ? gym : null;
  return {
    gymIdAtReport: liveGym?.id ?? null,
    routing: routeBoardReport({
      reason,
      boardOwnedBySystem,
      viewerIsCreator,
      hasGym: liveGym !== null,
      gymListingState: liveGym?.listingState ?? null,
    }),
  };
}

/** Validate a `reportBoard` call and route it. Throws the error the reporter should read. */
export async function prepareBoardReport(
  reporterId: string,
  input: {
    boardUuid: string;
    reason: BoardReportReason;
    duplicateOfBoardUuid?: string | null;
    note?: string | null;
    suggestedSetup?: BoardSetupInput | null;
  },
): Promise<FileReportInput> {
  const board = await loadReadableBoard(input.boardUuid, reporterId);
  if (!board) throw boardNotFound();
  const note = checkedReportNote(input.reason, input.note);
  let suggestion: FileReportInput['suggestion'] = null;
  if (input.suggestedSetup) {
    const setup = await checkedSuggestedSetup(board, input.reason, input.suggestedSetup);
    const mayApply = await isDirectorySetupSuggestionsEnabled();
    suggestion = { setup, mayApply, lockForChange: await suggestionMayChangeBoard(board, mayApply) };
  }

  let duplicateOfBoardId: number | null = null;
  if (input.reason !== 'relist_request' && input.duplicateOfBoardUuid) {
    if (input.reason !== 'duplicate') throw badInput('Only a "listed twice" report names another board.');
    if (input.duplicateOfBoardUuid === board.uuid) throw badInput("A board can't be listed twice as itself.");
    const duplicate = await loadReadableBoard(input.duplicateOfBoardUuid, reporterId);
    if (!duplicate) throw badInput('The other board was not found.');
    duplicateOfBoardId = duplicate.id;
  }

  return {
    reporterId,
    target: { kind: 'board', board },
    reason: input.reason,
    duplicateOfBoardId,
    duplicateOfGymId: null,
    note,
    suggestion,
    ...(await routeBoard(board, reporterId, input.reason)),
  };
}

/**
 * The board report as it stands inside the filing transaction. The checks in
 * `prepareBoardReport` ran before it; the board is read again under a share
 * lock, so a delete, removal or move that committed since is seen and the next
 * one waits. A board deleted or merged since is not found, as it would be now;
 * one whose gym or owner changed is routed again.
 *
 * A suggested setup that may change the board (`lockForChange`) takes the row
 * `FOR NO KEY UPDATE` instead: it never upgrades a share lock, two climbers'
 * suggestions on one board take turns, the second reading the first's change,
 * and inserts that only reference the board (a tick, an event) don't wait on
 * it. Under that lock the reporter must still be able to read the board, as
 * `updateBoard` asks of an editor. Any suggestion must still differ from the
 * board's setup.
 */
async function boardReportUnderLock(input: FileReportInput, executor: DirectoryExecutor): Promise<FileReportInput> {
  if (input.target.kind !== 'board') return input;
  const prepared = input.target.board;
  const lockForChange = input.suggestion?.lockForChange === true;
  const board = await lockBoardFacts(prepared.id, executor, lockForChange ? 'no key update' : 'share');
  if (!board || board.deletedAt !== null || board.mergedIntoBoardUuid !== null) throw boardNotFound();
  if (
    lockForChange &&
    board.ownerId !== input.reporterId &&
    !(await canAccessResource('board', board.uuid, input.reporterId, executor))
  ) {
    throw boardNotFound();
  }
  if (input.suggestion) await assertSuggestionDiffersNow(executor, board.id, input.suggestion.setup);
  if (board.gymId === prepared.gymId && board.ownerId === prepared.ownerId) return input;
  if (!isBoardReportReason(input.reason)) return input;
  return {
    ...input,
    target: { kind: 'board', board },
    ...(await routeBoard(board, input.reporterId, input.reason, executor)),
  };
}

/**
 * A reporter whose report on this target and reason closed in the last
 * `REPORT_REFILE_COOLDOWN_DAYS` days doesn't open it again: they get
 * `already_reported` for the closed report and nothing is written. Each opening
 * reaches its people with a notice and a push, so a reporter who disagrees with
 * an outcome can't push the creator again and again. A report someone else has
 * opened since is joined as usual (null here).
 *
 * A "Set up wrong" report has two exceptions, where the setup it was closed
 * over may not be the one on the wall:
 * - A climber's suggested setup closed it (resolver role `climber`). Anyone on
 *   it may file again straight away, the climber who made the change
 *   included; the board's 24-hour limit sends a repeat suggestion to review
 *   (`RECENT_CHANGE`).
 * - A climber's setup change to the board was undone after it closed. The
 *   reporter may file again, and for 90 days a suggestion goes to review
 *   (`RECENTLY_UNDONE`).
 */
async function refusedRefile(
  executor: DirectoryExecutor,
  input: FileReportInput,
  targetCondition: SQL,
): Promise<FiledReport | null> {
  const since = new Date(Date.now() - REPORT_REFILE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const [closed] = await executor
    .select()
    .from(dbSchema.directoryReports)
    .where(
      and(
        targetCondition,
        eq(dbSchema.directoryReports.reason, input.reason),
        notInArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]),
        gt(dbSchema.directoryReports.resolvedAt, since),
        exists(
          db
            .select({ one: sql`1` })
            .from(dbSchema.directoryReportReporters)
            .where(
              and(
                eq(dbSchema.directoryReportReporters.reportId, dbSchema.directoryReports.id),
                eq(dbSchema.directoryReportReporters.reporterId, input.reporterId),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(dbSchema.directoryReports.resolvedAt))
    .limit(1);
  if (!closed) return null;
  if (closed.reason === 'wrong_setup' && closed.resolvedByRole === 'climber') return null;
  if (await setupChangeUndoneSince(executor, closed)) return null;
  const [waiting] = await executor
    .select({ id: dbSchema.directoryReports.id })
    .from(dbSchema.directoryReports)
    .where(
      and(
        targetCondition,
        eq(dbSchema.directoryReports.reason, input.reason),
        inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]),
      ),
    )
    .limit(1);
  if (waiting) return null;
  const reporterCount = await countReporters(executor, closed.id);
  return {
    status: 'already_reported',
    report: closed,
    otherReporterCount: Math.max(0, reporterCount - 1),
    setup: null,
  };
}

/** Whether a climber's setup change to this closed "Set up wrong" report's board was undone after it closed. */
async function setupChangeUndoneSince(executor: DirectoryExecutor, closed: DirectoryReport): Promise<boolean> {
  if (closed.reason !== 'wrong_setup' || closed.boardId == null || closed.resolvedAt == null) return false;
  const [undo] = await executor
    .select({ id: dbSchema.boardModerationEvents.id })
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.boardId, closed.boardId),
        eq(dbSchema.boardModerationEvents.action, 'setup_change_undone'),
        gt(dbSchema.boardModerationEvents.createdAt, closed.resolvedAt),
      ),
    )
    .limit(1);
  return undo !== undefined;
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
 * What the report's suggested setup does, once the report and the reporter's
 * row are written (setup-suggestion.ts). Null for a report without one.
 */
async function settleFiledSuggestion(
  executor: DirectoryExecutor,
  input: FileReportInput,
  report: DirectoryReport,
): Promise<SettledSuggestion | null> {
  if (input.target.kind !== 'board' || !input.suggestion) return null;
  return settleSetupSuggestion(executor, {
    actorId: input.reporterId,
    board: input.target.board,
    suggestion: input.suggestion.setup,
    mayApply: input.suggestion.mayApply,
    holdsChangeLock: input.suggestion.lockForChange,
    report,
  });
}

/** The report as it stands after a suggestion that applied closed it. */
async function reloadReport(executor: DirectoryExecutor, report: DirectoryReport): Promise<DirectoryReport> {
  const [current] = await executor
    .select()
    .from(dbSchema.directoryReports)
    .where(eq(dbSchema.directoryReports.id, report.id))
    .limit(1);
  return current ?? report;
}

/**
 * Open a report or join the waiting one, and tell the people it reaches. One
 * transaction; the partial unique index decides a race between two first
 * reporters, and the loser joins the winner's report.
 *
 * A suggested setup is stored on the reporter's row whether the report was
 * opened, joined or already theirs, and then settled (`settleFiledSuggestion`).
 * One that applies closes the report it rode on in the same transaction, so a
 * report it opened tells nobody it opened: the creator hears about the change
 * instead. A reporter already on the waiting report replaces their earlier
 * suggestion with this one: it is only ever their own row, it reaches nobody
 * new (joining is quiet), and it lets a climber whose first suggestion waited
 * on a limit try again once the limit has passed.
 */
export async function fileReport(prepared: FileReportInput): Promise<FiledReport> {
  let filed: FiledReport;
  try {
    filed = await fileReportOnce(prepared);
  } catch (error) {
    // The pre-check said the suggestion couldn't change the board, and under
    // the lock it can: file again, with the row locked to change it. Nothing
    // was written; the first transaction rolled back.
    if (!(error instanceof SuggestionNeedsChangeLock) || !prepared.suggestion) throw error;
    filed = await fileReportOnce({ ...prepared, suggestion: { ...prepared.suggestion, lockForChange: true } });
  }

  captureBackendEvent('Board Report Submitted', {
    properties: {
      targetKind: filed.report.targetKind,
      reason: filed.report.reason,
      status: filed.status,
      routedTo: filed.report.routedTo.join(','),
    },
  });
  if (filed.setup && prepared.target.kind === 'board') {
    captureBackendEvent('Board Setup Suggested', {
      properties: {
        outcome: filed.setup.outcome,
        reason: filed.setup.reviewReason,
        boardType: prepared.target.board.boardType,
        gymState: filed.setup.gymState,
      },
    });
  }
  return filed;
}

/** One filing transaction (`fileReport`). */
async function fileReportOnce(prepared: FileReportInput): Promise<FiledReport> {
  const suggestedSetup = prepared.suggestion?.setup ?? null;
  return transactionWithAfterCommit(async (tx): Promise<FiledReport> => {
    const input = await boardReportUnderLock(prepared, tx);
    const targetColumns =
      input.target.kind === 'board'
        ? { boardId: input.target.board.id, gymId: null }
        : { boardId: null, gymId: input.target.gym.id };
    const targetCondition =
      input.target.kind === 'board'
        ? eq(dbSchema.directoryReports.boardId, input.target.board.id)
        : eq(dbSchema.directoryReports.gymId, input.target.gym.id);

    const refused = await refusedRefile(tx, input, targetCondition);
    if (refused) return refused;

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
          .values({ reportId: created.id, reporterId: input.reporterId, note: input.note, suggestedSetup });
        const setup = await settleFiledSuggestion(tx, input, created);
        const report =
          setup?.outcome === 'APPLIED' ? await reloadReport(tx, created) : await notifyNewReport(tx, input, created);
        return { status: 'created' as const, report, otherReporterCount: 0, setup };
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
        .values({ reportId: waiting.id, reporterId: input.reporterId, note: input.note, suggestedSetup })
        .onConflictDoNothing({
          target: [dbSchema.directoryReportReporters.reportId, dbSchema.directoryReportReporters.reporterId],
          where: sql`${dbSchema.directoryReportReporters.reporterId} IS NOT NULL`,
        })
        .returning({ id: dbSchema.directoryReportReporters.id });
      if (joined.length === 0 && suggestedSetup) {
        await tx
          .update(dbSchema.directoryReportReporters)
          .set({ suggestedSetup })
          .where(
            and(
              eq(dbSchema.directoryReportReporters.reportId, waiting.id),
              eq(dbSchema.directoryReportReporters.reporterId, input.reporterId),
            ),
          );
      }
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
      const setup = await settleFiledSuggestion(tx, input, report);
      return {
        status: joined.length > 0 ? ('added' as const) : ('already_reported' as const),
        report: setup?.outcome === 'APPLIED' ? await reloadReport(tx, report) : report,
        otherReporterCount: Math.max(0, reporterCount - 1),
        setup,
      };
    }
    throw new GraphQLError("Your report didn't go through. Try again.", {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
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
