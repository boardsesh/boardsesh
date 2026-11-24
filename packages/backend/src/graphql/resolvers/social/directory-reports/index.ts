import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { normalizeReportNote, resolutionNoteProblem } from '@boardsesh/directory-moderation';
import { db } from '../../../../db/client';
import { isDirectoryReportsEnabled } from '../../../../services/directory-reports-flag';
import { canAccessResource } from '../../../../services/privacy';
import {
  AdminDirectoryReportsArgsSchema,
  MyDirectoryReportsToReviewArgsSchema,
  ReportBoardInputSchema,
  ReportGymInputSchema,
  ResolveDirectoryReportInputSchema,
} from '../../../../validation/schemas';
import { applyRateLimit, requireAuthenticated, validateInput } from '../../shared/helpers';
import { getUserCommunityRoles, requireAdmin } from '../roles';
import { isSystemOwner, loadBoardFacts, loadGymFacts, WAITING_STATUSES } from './core';
import { transactionWithAfterCommit } from '../../../../db/after-commit';
import { notInAdminQueue, resolveWaitingReports } from './lifecycle';
import {
  adminReportsPage,
  boardReportsFor,
  loadReportViewer,
  presentReports,
  reportGymId,
  reportsToReviewFor,
  viewerCanResolve,
  isInAdminQueue,
  viewerRoleFor,
} from './read';
import { fileReport, prepareBoardReport, prepareGymReport, type FiledReport } from './submit';

export { loadBoardReportFlags } from './read';
export { resolveReportsForMergedBoard } from './lifecycle';
export { fileReport, prepareGymReport } from './submit';

// ============================================
// Directory reports: GraphQL
// ============================================
//
// Report a problem with a board or a gym listing (docs/product/directory-reports.md).
// SDL: packages/shared-schema/src/schema/directory-reports.ts.

/** Per-minute ceiling on reports. A climber reports a board a handful of times, ever. */
const REPORT_RATE_LIMIT = 5;
/** Per-minute ceiling on closing reports, which creators, staff and admins do by hand. */
const RESOLVE_RATE_LIMIT = 30;

const DEFAULT_PAGE_SIZE = 50;

async function requireReportsEnabled(): Promise<void> {
  if (!(await isDirectoryReportsEnabled())) {
    throw new GraphQLError("Reporting a problem isn't available yet.", {
      extensions: { code: 'FEATURE_DISABLED' },
    });
  }
}

function submitResult(filed: FiledReport) {
  return {
    status: filed.status,
    reportUuid: filed.report.uuid,
    routedTo: filed.report.routedTo,
    otherReporterCount: filed.otherReporterCount,
  };
}

/** The suggested setup resolvers are not written yet (docs/product/directory-reports.md, "Suggested setup"). */
function setupSuggestionsNotImplemented(): GraphQLError {
  return new GraphQLError('Not implemented yet', { extensions: { code: 'NOT_IMPLEMENTED' } });
}

function reportNotFound(): GraphQLError {
  return new GraphQLError('Report not found', { extensions: { code: 'NOT_FOUND' } });
}

function reportClosed(): GraphQLError {
  return new GraphQLError('This report is closed already.', { extensions: { code: 'REPORT_CLOSED' } });
}

/** A waiting report this viewer reads but may not close. */
function cannotResolve(report: Parameters<typeof isInAdminQueue>[0]): GraphQLError {
  return new GraphQLError(
    isInAdminQueue(report)
      ? 'The Boardsesh team is looking at this report; it closes when they do.'
      : "Only the gym's owner or admins can close this report.",
    { extensions: { code: 'FORBIDDEN' } },
  );
}

export const directoryReportQueries = {
  boardReports: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext) => {
    if (!ctx.isAuthenticated || !ctx.userId) return [];
    await applyRateLimit(ctx, 60, 'boardReports');
    return boardReportsFor(boardUuid, ctx.userId, await getUserCommunityRoles(ctx.userId));
  },

  myDirectoryReportsToReview: async (_: unknown, args: unknown, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'myDirectoryReportsToReview');
    const validated = validateInput(MyDirectoryReportsToReviewArgsSchema, args ?? {}, 'myDirectoryReportsToReview');
    return reportsToReviewFor(ctx.userId!, await getUserCommunityRoles(ctx.userId!), {
      includeResolved: validated.includeResolved ?? false,
      first: validated.first ?? DEFAULT_PAGE_SIZE,
    });
  },

  adminDirectoryReports: async (_: unknown, args: unknown, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const validated = validateInput(AdminDirectoryReportsArgsSchema, args ?? {}, 'adminDirectoryReports');
    return adminReportsPage(ctx.userId!, await getUserCommunityRoles(ctx.userId!), {
      status: validated.status ?? 'escalated',
      targetKind: validated.targetKind ?? null,
      first: validated.first ?? DEFAULT_PAGE_SIZE,
      after: validated.after ?? null,
    });
  },

  // TODO(setup-suggest PR1 resolver agent): list setup_changed_by_climber events, newest first.
  adminBoardSetupChanges: async (_: unknown, _args: unknown, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    throw setupSuggestionsNotImplemented();
  },
};

export const directoryReportMutations = {
  reportBoard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await requireReportsEnabled();
    await applyRateLimit(ctx, REPORT_RATE_LIMIT, 'reportBoard');
    const validated = validateInput(ReportBoardInputSchema, input, 'input');
    const prepared = await prepareBoardReport(ctx.userId!, validated);
    return submitResult(await fileReport(prepared));
  },

  reportGym: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await requireReportsEnabled();
    await applyRateLimit(ctx, REPORT_RATE_LIMIT, 'reportGym');
    const validated = validateInput(ReportGymInputSchema, input, 'input');
    const prepared = await prepareGymReport(ctx.userId!, validated);
    return submitResult(await fileReport(prepared));
  },

  /**
   * Close a report. The board's creator and the staff it went to (owner or
   * admin) close it as kept. A global admin closes anything with any outcome,
   * once they have taken the action: removed and deleted are checked against
   * the board or gym as it is now.
   */
  resolveDirectoryReport: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RESOLVE_RATE_LIMIT, 'resolveDirectoryReport');
    const validated = validateInput(ResolveDirectoryReportInputSchema, input, 'input');
    if (resolutionNoteProblem(validated.note)) {
      throw new GraphQLError('Keep the note under 500 characters.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const userId = ctx.userId!;

    const [report] = await db
      .select()
      .from(dbSchema.directoryReports)
      .where(eq(dbSchema.directoryReports.uuid, validated.reportUuid))
      .limit(1);
    if (!report) throw reportNotFound();
    const gymId = reportGymId(report);
    const viewer = await loadReportViewer(
      userId,
      await getUserCommunityRoles(userId),
      db,
      gymId != null ? [gymId] : [],
    );
    const board = report.boardId != null ? (await loadBoardFacts([report.boardId])).get(report.boardId) : undefined;
    const role = viewerRoleFor(report, board, viewer);
    if (!role) throw reportNotFound();
    // Staff act on a board report only while they can read the board.
    if (
      role === 'gym_staff' &&
      report.targetKind === 'board' &&
      (!board || board.deletedAt !== null || !(await canAccessResource('board', board.uuid, userId)))
    ) {
      throw reportNotFound();
    }
    if (!(WAITING_STATUSES as readonly string[]).includes(report.status)) throw reportClosed();
    if (!viewerCanResolve(report, role, viewer)) throw cannotResolve(report);
    if (validated.outcome !== 'kept' && !viewer.isAdmin) {
      throw new GraphQLError('Fix, remove or delete the board itself; the report closes when you do.', {
        extensions: { code: 'FORBIDDEN' },
      });
    }
    await assertOutcomeTaken(report, board, validated.outcome);

    // The checks above read the report before this write, and the sweep can
    // move it to the admin queue in between. The creator and staff close it only
    // while the write still finds it out of that queue.
    const resolved = await transactionWithAfterCommit((tx) =>
      resolveWaitingReports(
        tx,
        and(eq(dbSchema.directoryReports.id, report.id), viewer.isAdmin ? undefined : notInAdminQueue())!,
        {
          outcome: validated.outcome,
          resolvedBy: userId,
          role: role === 'creator' ? 'creator' : role === 'gym_staff' ? 'gym_staff' : 'admin',
          note: normalizeReportNote(validated.note),
        },
      ),
    );
    if (resolved.length === 0) {
      const [current] = await db
        .select({ status: dbSchema.directoryReports.status, routedTo: dbSchema.directoryReports.routedTo })
        .from(dbSchema.directoryReports)
        .where(eq(dbSchema.directoryReports.id, report.id))
        .limit(1);
      if (current && (WAITING_STATUSES as readonly string[]).includes(current.status)) throw cannotResolve(current);
      throw reportClosed();
    }
    const [presented] = await presentReports(resolved, viewer);
    if (!presented) throw reportNotFound();
    return presented;
  },

  // TODO(setup-suggest PR1 resolver agent): compare-and-set undo of a setup_changed_by_climber event.
  undoBoardSetupChange: async (_: unknown, _args: { eventId: string }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    throw setupSuggestionsNotImplemented();
  },
};

/**
 * An admin closing a report as removed or deleted says that happened; check
 * it did. A board report: the board is deleted, or no longer at the reported
 * gym. A gym report: the gym is deleted, or hidden from the directory.
 */
async function assertOutcomeTaken(
  report: typeof dbSchema.directoryReports.$inferSelect,
  board: { deletedAt: Date | null; gymId: number | null; ownerId: string } | undefined,
  outcome: string,
): Promise<void> {
  if (outcome !== 'removed' && outcome !== 'deleted') return;
  const notYet = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
  if (report.targetKind === 'board') {
    if (!board) return;
    if (outcome === 'deleted' && board.deletedAt === null) {
      throw notYet('Delete the board first; then close the report as deleted.');
    }
    if (
      outcome === 'removed' &&
      board.deletedAt === null &&
      board.gymId !== null &&
      board.gymId === report.gymIdAtReport
    ) {
      throw notYet(
        isSystemOwner(board.ownerId)
          ? 'Delete this synced board first; then close the report.'
          : 'Remove the board from the gym first; then close the report as removed.',
      );
    }
    return;
  }
  if (report.gymId == null) return;
  const gym = (await loadGymFacts([report.gymId])).get(report.gymId);
  if (!gym) return;
  if (outcome === 'deleted' && gym.deletedAt === null) throw notYet('Delete the gym first; then close the report.');
  if (outcome === 'removed' && gym.deletedAt === null && gym.isListed && gym.isPublic) {
    throw notYet('Hide the gym from the directory first; then close the report as removed.');
  }
}
