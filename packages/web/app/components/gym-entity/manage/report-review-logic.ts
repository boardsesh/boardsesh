import {
  groupSuggestedSetups,
  isOpenDirectoryReportStatus,
  setupMatches,
  type CurrentBoardSetupForComparison,
  type SuggestedSetupGroup,
} from '@boardsesh/directory-moderation';
import type { DirectoryReport } from '@boardsesh/shared-schema';

/**
 * Manage gym → Boards and its "Review" dialog: which rows are reported, the
 * order they sit in, and which reports the viewer can close
 * (docs/product/directory-reports.md, "Who sees a report").
 */

/** The row carries the "Reported" chip: waiting reports this viewer can act on. */
export function hasOpenReports(board: { openReportCount?: number | null }): boolean {
  return (board.openReportCount ?? 0) > 0;
}

/** Reported boards first, each group in the server's order. */
export function sortBoardsReportedFirst<T extends { openReportCount?: number | null }>(boards: readonly T[]): T[] {
  return [...boards.filter(hasOpenReports), ...boards.filter((board) => !hasOpenReports(board))];
}

/** One waiting report as the dialog lists it. Reporter names never appear here, even for an admin. */
export type ReviewRow = {
  uuid: string;
  reason: DirectoryReport['reason'];
  reporterCount: number;
  /** What reporters said, oldest first. `key` is stable for React. A reporter who only suggested a setup said nothing. */
  notes: Array<{ key: string; text: string }>;
  /**
   * The setups reporters suggested, grouped by equal setup, the most suggested
   * first (`groupSuggestedSetups`, shared with the app's review sheet).
   */
  suggestions: SuggestedSetupGroup[];
  duplicateOfBoardName: string | null;
  /**
   * The line under the report: `team_queue` when it is in the admin queue and
   * the viewer can't close it (it closes when the team does), `escalates` while
   * it is still with the creator or staff (it moves to the team on
   * `escalatesAt`), null for a global admin reading an escalated one.
   */
  footnote: 'team_queue' | 'escalates' | null;
  escalatesAt: string;
};

export function reviewRows(reports: readonly DirectoryReport[]): ReviewRow[] {
  return reports
    .filter((report) => isOpenDirectoryReportStatus(report.status))
    .map((report) => ({
      uuid: report.uuid,
      reason: report.reason,
      reporterCount: report.reporterCount,
      notes: report.notes
        .map((note, index) => ({ key: `${note.createdAt}:${index}`, text: note.note }))
        .filter((note) => note.text.trim().length > 0),
      suggestions: groupSuggestedSetups(report.notes),
      duplicateOfBoardName: report.duplicateOfBoardName ?? null,
      // A report in the admin queue is `escalated` (routed there when it opened,
      // or open 14 days). A gym editor can't close an open one either, but the
      // owner and admins can, so that one still gets the date.
      footnote: report.status === 'open' ? 'escalates' : report.viewerCanResolve ? null : 'team_queue',
      escalatesAt: report.escalatesAt,
    }));
}

/** What "It's right as it is" closes: every waiting report the viewer may close as kept. */
export function reportsToKeep(reports: readonly DirectoryReport[]): string[] {
  return reports
    .filter((report) => isOpenDirectoryReportStatus(report.status) && report.viewerCanResolve)
    .map((report) => report.uuid);
}

/**
 * Whether the dialog shows a **Use this setup** button: the viewer may edit the
 * board, and some suggestion differs from the setup it has now (one it already
 * has reads "The board has this setup now" instead). Only then does "Fix the
 * setup" read as "Edit it yourself", the other way to fix it.
 */
export function offersUseThisSetup(
  rows: readonly Pick<ReviewRow, 'suggestions'>[],
  board: (CurrentBoardSetupForComparison & { canEdit?: boolean | null }) | null,
): boolean {
  if (!board?.canEdit) return false;
  return rows.some((row) => row.suggestions.some((group) => !setupMatches(group.setup, board)));
}
