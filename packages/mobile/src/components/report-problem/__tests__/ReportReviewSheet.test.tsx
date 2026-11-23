// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DirectoryReport, UserBoard } from '@boardsesh/shared-schema';
import { ReportReviewSheet } from '../ReportReviewSheet';

const state = vi.hoisted(() => ({ reports: [] as DirectoryReport[] }));
const resolveAsync = vi.hoisted(() => vi.fn());
const refreshReads = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
    i18n: { resolvedLanguage: 'en-US', language: 'en-US' },
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header }: { children: ReactNode; header: ReactNode }) =>
    createElement('div', null, header, children),
}));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  insetGroupedRowStyles: { row: {}, leading: {}, text: {} },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: { children: ReactNode; onPress: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, children),
}));
vi.mock('../../tick', () => ({
  TickNoteField: ({ value, onChangeText }: { value: string; onChangeText: (next: string) => void }) =>
    createElement('textarea', {
      'data-testid': 'reply',
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', secondaryLabel: '#666' }, brandColors: { error: '#f00' } }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  dismissManagedSheetAndWait: () => Promise.resolve({ status: 'dismissed' }),
}));
vi.mock('../../../hooks/use-unsaved-sheet-guard', () => ({
  useUnsavedSheetGuard: ({ onClose }: { onClose: () => void }) => ({
    requestClose: onClose,
    enablePanDownToClose: true,
  }),
}));
vi.mock('../../../lib/graphql/hooks/use-directory-reports', () => ({
  useBoardReports: () => ({ data: state.reports, isLoading: false, isError: false }),
  useResolveDirectoryReport: () => ({ mutateAsync: resolveAsync }),
  useRefreshBoardReportReads: () => refreshReads,
}));

function report(overrides: Partial<DirectoryReport>): DirectoryReport {
  return {
    uuid: 'r1',
    targetKind: 'board',
    reason: 'wrong_setup',
    status: 'open',
    routedTo: ['creator'],
    reporterCount: 2,
    notes: [{ note: 'The angle is 45 not 40', createdAt: '2026-11-20T10:00:00.000Z', reporter: null }],
    createdAt: '2026-11-20T10:00:00.000Z',
    escalatesAt: '2026-12-04T10:00:00.000Z',
    viewerRole: 'creator',
    viewerIsReporter: false,
    viewerCanResolve: true,
    ...overrides,
  };
}

const board = {
  uuid: 'board-1',
  name: 'Crux Kilter',
  ownerId: 'alex',
  gymUuid: 'gym-1',
  gymName: 'Crux',
  canEdit: true,
  canDelete: true,
  canRemoveFromGym: true,
} as UserBoard;

beforeEach(() => {
  state.reports = [report({})];
  resolveAsync.mockReset();
  resolveAsync.mockResolvedValue({});
  refreshReads.mockReset();
  showToast.mockReset();
});

describe('ReportReviewSheet', () => {
  it('shows each reason with its count and the notes, never a name', () => {
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(
      screen.getByText('reportReview.reasonCount{"reason":"report.boardReasons.wrongSetup","count":2}'),
    ).toBeTruthy();
    expect(screen.getByText('“The angle is 45 not 40”')).toBeTruthy();
    expect(screen.getByTestId('report-review-footnote').textContent).toMatch(/^reportReview\.teamDate/);
  });

  it.each(['fix', 'remove', 'delete'] as const)(
    'closes, then hands %s to the host once the sheet is gone',
    async (action) => {
      const onClose = vi.fn();
      const onAction = vi.fn();
      const screen = render(
        <ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={onAction} />,
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId(`report-review-${action}`));
        fireEvent.click(screen.getByTestId(`report-review-${action}`));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledWith(action, board);
    },
  );

  it('offers only what the board allows', () => {
    const screen = render(
      <ReportReviewSheet
        board={{ ...board, canDelete: false, canRemoveFromGym: false }}
        viewerUserId="alex"
        onClose={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('report-review-delete')).toBeNull();
    expect(screen.queryByTestId('report-review-remove')).toBeNull();
    expect(screen.getByTestId('report-review-fix')).toBeTruthy();
  });

  it('keeps it as it is: closes every report the viewer may close, with the note', async () => {
    state.reports = [report({ uuid: 'r1' }), report({ uuid: 'r2', reason: 'gone' })];
    const onClose = vi.fn();
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTestId('report-review-keep'));
    fireEvent.change(screen.getByTestId('reply'), { target: { value: ' We reset it last week. ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sheet-top-bar-trailing'));
    });
    expect(resolveAsync.mock.calls.map(([input]) => input)).toEqual([
      { reportUuid: 'r1', outcome: 'kept', note: 'We reset it last week.' },
      { reportUuid: 'r2', outcome: 'kept', note: 'We reset it last week.' },
    ]);
    expect(showToast).toHaveBeenCalledWith('reportReview.keptToast', 'success');
    expect(onClose).toHaveBeenCalled();
    expect(refreshReads).toHaveBeenCalledWith('board-1');
  });

  it('says how many closed when only some did, stays open, and re-reads the reports', async () => {
    state.reports = [
      report({ uuid: 'r1' }),
      report({ uuid: 'r2', reason: 'gone' }),
      report({ uuid: 'r3', reason: 'duplicate' }),
    ];
    resolveAsync.mockImplementation(async ({ reportUuid }: { reportUuid: string }) => {
      if (reportUuid === 'r2') throw new Error('closed elsewhere');
      return {};
    });
    const onClose = vi.fn();
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTestId('report-review-keep'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sheet-top-bar-trailing'));
    });
    // Every report was tried: one failure stops none of the others.
    expect(resolveAsync.mock.calls.map(([input]) => input.reportUuid)).toEqual(['r1', 'r2', 'r3']);
    expect(screen.getByTestId('report-review-keep-error').textContent).toBe(
      'reportReview.keepPartial{"count":2,"total":3}',
    );
    expect(showToast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(refreshReads).toHaveBeenCalledWith('board-1');
  });

  it('says it did not go through when none closed', async () => {
    state.reports = [report({ uuid: 'r1' }), report({ uuid: 'r2', reason: 'gone' })];
    resolveAsync.mockRejectedValue(new Error('offline'));
    const onClose = vi.fn();
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTestId('report-review-keep'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sheet-top-bar-trailing'));
    });
    expect(screen.getByTestId('report-review-keep-error').textContent).toBe('reportReview.keepError');
    expect(onClose).not.toHaveBeenCalled();
    expect(refreshReads).toHaveBeenCalledWith('board-1');
  });

  it('leaves a report with the team read-only, and says so', () => {
    state.reports = [report({ status: 'escalated', viewerCanResolve: false })];
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByTestId('report-review-keep')).toBeNull();
    expect(screen.getByTestId('report-review-footnote').textContent).toBe('reportReview.teamLooking');
  });

  it('says when nothing is open anymore', () => {
    state.reports = [report({ status: 'fixed', resolvedAt: '2026-11-21T10:00:00.000Z' })];
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByTestId('report-review-empty')).toBeTruthy();
  });
});
