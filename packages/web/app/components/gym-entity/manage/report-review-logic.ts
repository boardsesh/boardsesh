import { isOpenDirectoryReportStatus } from '@boardsesh/directory-moderation';
import { normaliseSetIds } from '@boardsesh/board-config';
import type { BoardSetup, DirectoryReport, DirectoryReportNote, UpdateBoardInput } from '@boardsesh/shared-schema';

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
  /** The setups reporters suggested, grouped by equal setup ({@link groupSuggestedSetups}). */
  suggestions: SetupSuggestionGroup[];
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

/** Climbers who suggested the same setup ("2 climbers suggested …"). */
export type SetupSuggestionGroup = {
  /** The setup in canonical form; also the React key ({@link setupKey}). */
  key: string;
  setup: BoardSetup;
  count: number;
};

/** One string per setup: sets in `normaliseSetIds` order, a null angle the same as none. */
export function setupKey(setup: BoardSetup): string {
  return [setup.layoutId, setup.sizeId, normaliseSetIds(setup.setIds), setup.angle ?? ''].join(':');
}

/**
 * The setups a report's reporters suggested, one group per equal setup, the
 * most suggested first (ties by who suggested first). Reporters stay
 * anonymous: a group is a count.
 */
export function groupSuggestedSetups(notes: readonly DirectoryReportNote[]): SetupSuggestionGroup[] {
  const groups = new Map<string, SetupSuggestionGroup>();
  for (const note of notes) {
    const suggested = note.suggestedSetup;
    if (!suggested) continue;
    const key = setupKey(suggested);
    const group = groups.get(key);
    if (group) group.count += 1;
    else {
      groups.set(key, {
        key,
        setup: {
          layoutId: suggested.layoutId,
          sizeId: suggested.sizeId,
          setIds: normaliseSetIds(suggested.setIds),
          angle: suggested.angle ?? null,
        },
        count: 1,
      });
    }
  }
  // Map keeps insertion order, so a stable sort leaves equal counts oldest first.
  return [...groups.values()].sort((first, second) => second.count - first.count);
}

/**
 * Whether the board already has this setup, so Use this setup would change
 * nothing. The angle counts only when the suggestion carries one (a board that
 * doesn't tilt).
 */
export function boardHasSetup(
  board: { layoutId: number; sizeId: number; setIds: string; angle: number },
  setup: BoardSetup,
): boolean {
  return (
    board.layoutId === setup.layoutId &&
    board.sizeId === setup.sizeId &&
    normaliseSetIds(board.setIds) === normaliseSetIds(setup.setIds) &&
    (setup.angle == null || board.angle === setup.angle)
  );
}

/**
 * Use this setup: the `updateBoard` input that gives the board the suggested
 * layout, size, sets and, for a board that doesn't tilt, angle. The server
 * closes the board's "Set up wrong" reports as fixed when it saves.
 */
export function setupUpdateInput(boardUuid: string, setup: BoardSetup): UpdateBoardInput {
  return {
    boardUuid,
    layoutId: setup.layoutId,
    sizeId: setup.sizeId,
    setIds: normaliseSetIds(setup.setIds),
    ...(setup.angle == null ? {} : { angle: setup.angle }),
  };
}
