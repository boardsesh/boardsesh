import { isOpenDirectoryReportStatus } from '@boardsesh/directory-moderation';
import type { DirectoryReport, DirectoryReportOutcome } from '@boardsesh/shared-schema';

/**
 * The admin queue's actions at `/admin/board-reports`, as plain data: what each
 * button does, in order, and how the report closes
 * (docs/product/directory-reports.md, "Closing a report").
 *
 * A delete or a removal closes the report on the server as it happens
 * (`lifecycle.ts`), so the `resolve` step that follows usually finds it closed
 * already; the panel treats that as done. It is there for the cases the hooks
 * don't reach, and so every action leaves the report closed with the outcome
 * the admin meant. Hiding a gym from search closes nothing on its own, so its
 * `resolve` is what closes the report.
 */

export type AdminReportAction = 'delete_board' | 'remove_from_gym' | 'hide_gym' | 'keep';

export type AdminReportStep =
  | { kind: 'delete_board'; boardUuid: string }
  | { kind: 'detach_board'; gymUuid: string; boardUuid: string }
  | { kind: 'hide_gym'; gymUuid: string }
  | { kind: 'resolve'; reportUuid: string; outcome: DirectoryReportOutcome; note: string | null };

/** How each action closes the report. */
export function outcomeForAdminAction(action: AdminReportAction): DirectoryReportOutcome {
  switch (action) {
    case 'delete_board':
      return 'deleted';
    case 'remove_from_gym':
    case 'hide_gym':
      return 'removed';
    case 'keep':
      return 'kept';
  }
}

/**
 * The actions a report offers, in the order the row shows them. None for a
 * closed report or one the viewer can't close.
 *
 * - Board: delete it, remove it from the gym it was reported at, or keep it.
 *   A relist request (a creator asking to be put back) is kept or left: the
 *   board is not at the gym, so there is nothing to remove.
 * - Gym: hide it from search, or keep it. Merging is the duplicate-gyms tool's
 *   job; the row links there for a "listed twice" report.
 */
export function adminActionsFor(
  report: Pick<DirectoryReport, 'status' | 'viewerCanResolve' | 'targetKind' | 'reason' | 'boardUuid' | 'gymUuid'>,
): AdminReportAction[] {
  if (!isOpenDirectoryReportStatus(report.status) || !report.viewerCanResolve) return [];
  if (report.targetKind === 'gym') return report.gymUuid ? ['hide_gym', 'keep'] : ['keep'];
  if (!report.boardUuid) return ['keep'];
  const actions: AdminReportAction[] = ['delete_board'];
  if (report.gymUuid && report.reason !== 'relist_request') actions.push('remove_from_gym');
  actions.push('keep');
  return actions;
}

/** The steps behind one action, or null when the report can't take it. */
export function planAdminAction(
  report: Pick<
    DirectoryReport,
    'uuid' | 'status' | 'viewerCanResolve' | 'targetKind' | 'reason' | 'boardUuid' | 'gymUuid'
  >,
  action: AdminReportAction,
  note: string | null = null,
): AdminReportStep[] | null {
  if (!adminActionsFor(report).includes(action)) return null;
  const resolve: AdminReportStep = {
    kind: 'resolve',
    reportUuid: report.uuid,
    outcome: outcomeForAdminAction(action),
    note: action === 'keep' ? note : null,
  };
  switch (action) {
    case 'delete_board':
      return report.boardUuid ? [{ kind: 'delete_board', boardUuid: report.boardUuid }, resolve] : null;
    case 'remove_from_gym':
      return report.boardUuid && report.gymUuid
        ? [{ kind: 'detach_board', gymUuid: report.gymUuid, boardUuid: report.boardUuid }, resolve]
        : null;
    case 'hide_gym':
      return report.gymUuid ? [{ kind: 'hide_gym', gymUuid: report.gymUuid }, resolve] : null;
    case 'keep':
      return [resolve];
  }
}

/**
 * The queue's order: reports routed to the team when they opened (a synced
 * board nobody runs, a wrong place, most gym reports) ahead of those that
 * waited 14 days with a creator or staff, each group oldest first as the server
 * sent it. Closed reports keep the server's newest-first order.
 */
export function orderAdminReports<T extends Pick<DirectoryReport, 'status' | 'routedTo'>>(reports: readonly T[]): T[] {
  const routedToTeam = (report: T) => isOpenDirectoryReportStatus(report.status) && report.routedTo.includes('admin');
  return [...reports.filter(routedToTeam), ...reports.filter((report) => !routedToTeam(report))];
}

/** Whole days a report has been open at `now`, for the age column. */
export function reportAgeDays(createdAt: string, now: Date): number {
  const elapsed = now.getTime() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(elapsed / (24 * 60 * 60 * 1000)));
}
