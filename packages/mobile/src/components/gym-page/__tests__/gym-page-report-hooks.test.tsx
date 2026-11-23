// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';

// The gym page's two report seams: the gym's own row (`useGymReportAction`,
// over the shared `useReportProblem`) and the board rows' report and review
// sheets (`useGymBoardReports`, over the shared host and review sheet).

type ReviewProps = { board: UserBoard; viewerUserId: string | null; onClose: () => void };

const reportHost = vi.hoisted(() => ({ openReport: vi.fn(), isOpen: false }));
const useReportProblemMock = vi.hoisted(() => vi.fn());
const reviewCapture = vi.hoisted(() => ({ latest: null as ReviewProps | null }));

vi.mock('../../report-problem/use-report-problem', () => ({
  useReportProblem: useReportProblemMock,
  useReportProblemHost: () => ({
    openReport: reportHost.openReport,
    isOpen: reportHost.isOpen,
    sheet: createElement('div', { 'data-testid': 'report-host-sheet' }),
  }),
}));
vi.mock('../../report-problem/ReportReviewSheet', () => ({
  ReportReviewSheet: (props: ReviewProps) => {
    reviewCapture.latest = props;
    return createElement('div', { 'data-testid': `review-${props.board.uuid}` }, props.board.name);
  },
}));

import { useGymReportAction } from '../use-gym-report-action';
import { useGymBoardReports } from '../use-gym-board-reports';

function board(uuid: string, name = 'Kilter'): UserBoard {
  return { uuid, name, boardType: 'kilter', ownerId: 'creator-1' } as unknown as UserBoard;
}

beforeEach(() => {
  vi.clearAllMocks();
  reviewCapture.latest = null;
  useReportProblemMock.mockReturnValue(null);
});

describe('useGymReportAction', () => {
  it("asks the shared report hook about the page's gym, and hands back its answer", () => {
    const action = { open: vi.fn(), sheet: null };
    useReportProblemMock.mockReturnValue(action);
    const gym = { uuid: 'gym-1', name: 'Crux', canEdit: false } as unknown as Gym;
    const { result } = renderHook(() => useGymReportAction(gym));
    expect(useReportProblemMock).toHaveBeenLastCalledWith({ target: { kind: 'gym', gym } });
    expect(result.current).toBe(action);
  });

  it('asks about nothing before the gym loads', () => {
    renderHook(() => useGymReportAction(null));
    expect(useReportProblemMock).toHaveBeenLastCalledWith({ target: null });
  });
});

describe('useGymBoardReports', () => {
  const hostCapture: { reports: ReturnType<typeof useGymBoardReports> | null } = { reports: null };
  const onReviewAction = vi.fn();
  function Host({ boards, viewerId }: { boards: UserBoard[]; viewerId?: string }) {
    const reports = useGymBoardReports({ boards, viewerId, onReviewAction });
    hostCapture.reports = reports;
    return createElement('div', null, reports.sheets as ReactNode);
  }

  it("opens the shared report sheet for a board row, mounted in the page's tree", () => {
    const kilter = board('b1');
    render(createElement(Host, { boards: [kilter] }));
    expect(screen.getByTestId('report-host-sheet')).toBeTruthy();
    act(() => hostCapture.reports?.openReport(kilter));
    expect(reportHost.openReport).toHaveBeenCalledWith({ kind: 'board', board: kilter });
  });

  it('shows the review on the latest read of the board, for the signed-in viewer', () => {
    const { rerender } = render(createElement(Host, { boards: [board('b1', 'Kilter')], viewerId: 'staff-1' }));
    act(() => hostCapture.reports?.openReview(board('b1', 'Kilter')));
    expect(screen.getByTestId('review-b1').textContent).toBe('Kilter');
    expect(reviewCapture.latest?.viewerUserId).toBe('staff-1');

    rerender(createElement(Host, { boards: [board('b1', 'Kilter 40°')], viewerId: 'staff-1' }));
    expect(screen.getByTestId('review-b1').textContent).toBe('Kilter 40°');
  });

  it('keeps the review up when its board leaves the list, until the sheet closes', () => {
    const { rerender } = render(createElement(Host, { boards: [board('b1')] }));
    act(() => hostCapture.reports?.openReview(board('b1')));
    rerender(createElement(Host, { boards: [] }));
    expect(screen.getByTestId('review-b1')).toBeTruthy();
    expect(reviewCapture.latest?.viewerUserId).toBeNull();

    act(() => reviewCapture.latest?.onClose());
    expect(screen.queryByTestId('review-b1')).toBeNull();
  });
});
