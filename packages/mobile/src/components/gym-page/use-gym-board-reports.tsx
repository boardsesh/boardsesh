// Report a problem and See reports for the gym page's board rows: the report
// sheet (through the shared `useReportProblemHost`) and the report review sheet,
// both mounted inside the gym page's route (the in-tree opener rule,
// docs/mobile/mobile-sheets-vs-routes.md).
//
// Neither decides who may see its row: the shared board menu draws Report a
// problem, Reported and See reports from the row's flags
// (`boardCardReportAction`), and the menu hook checks again when one runs.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { ReportReviewSheet, type ReportReviewAction } from '../report-problem/ReportReviewSheet';
import { useReportProblemHost } from '../report-problem/use-report-problem';

export type GymBoardReportsOptions = {
  /** The gym's boards as the page last read them, so an open review shows the latest read. */
  boards: readonly UserBoard[];
  viewerId: string | undefined;
  /** Fix, Remove from gym or Delete, picked in the review sheet once it has slid away. */
  onReviewAction: (action: ReportReviewAction, board: UserBoard) => void;
};

export type GymBoardReports = {
  openReport: (board: UserBoard) => void;
  openReview: (board: UserBoard) => void;
  /** Mount this in the gym page's route. */
  sheets: ReactNode;
};

export function useGymBoardReports({ boards, viewerId, onReviewAction }: GymBoardReportsOptions): GymBoardReports {
  const reportHost = useReportProblemHost();
  const openReportForTarget = reportHost.openReport;
  const openReport = useCallback(
    (board: UserBoard) => openReportForTarget({ kind: 'board', board }),
    [openReportForTarget],
  );

  // The board the review opened with is held here, not read from the list: a
  // board that leaves the list mid-review (a refetch after another staff
  // member removed it) must not tear down the sheet being read. While the board
  // is still listed, the sheet shows the latest read of it.
  const [reviewBoard, setReviewBoard] = useState<UserBoard | null>(null);
  const openReview = useCallback((board: UserBoard) => setReviewBoard(board), []);
  const closeReview = useCallback(() => setReviewBoard(null), []);
  const shownReviewBoard = useMemo(
    () => (reviewBoard ? (boards.find((board) => board.uuid === reviewBoard.uuid) ?? reviewBoard) : null),
    [boards, reviewBoard],
  );

  const reportSheet = reportHost.sheet;
  const sheets = useMemo(
    () => (
      <>
        {reportSheet}
        {shownReviewBoard ? (
          <ReportReviewSheet
            key={shownReviewBoard.uuid}
            board={shownReviewBoard}
            viewerUserId={viewerId ?? null}
            onClose={closeReview}
            onAction={onReviewAction}
          />
        ) : null}
      </>
    ),
    [reportSheet, shownReviewBoard, viewerId, closeReview, onReviewAction],
  );

  return useMemo(() => ({ openReport, openReview, sheets }), [openReport, openReview, sheets]);
}
