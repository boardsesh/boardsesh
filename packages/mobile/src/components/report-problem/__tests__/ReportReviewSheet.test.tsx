// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { DirectoryReport, UserBoard } from '@boardsesh/shared-schema';
import { ReportReviewSheet } from '../ReportReviewSheet';
import { MAX_SUGGESTED_SETUPS_SHOWN } from '../report-review-model';

const state = vi.hoisted(() => ({ reports: [] as DirectoryReport[], setupSuggestions: false }));
const resolveAsync = vi.hoisted(() => vi.fn());
const refreshReads = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const updateBoardAsync = vi.hoisted(() => vi.fn());
const applyChangedBoard = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
// What the sheet last told the unsaved guard.
const guardArgs = vi.hoisted(() => [] as { busy: boolean }[]);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
    i18n: { resolvedLanguage: 'en-US', language: 'en-US' },
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children, testID }: { children: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
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
// A disabled row says so with aria-disabled and still hands a tap to onPress,
// so a test can show the handler itself refuses (a tap that landed before the
// row re-rendered disabled).
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'aria-disabled': disabled ? 'true' : undefined, 'data-testid': testID },
      children,
    ),
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
  useUnsavedSheetGuard: (args: { onClose: () => void; busy: boolean }) => {
    guardArgs.push(args);
    return { requestClose: args.onClose, enablePanDownToClose: true };
  },
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    disabled,
    testID,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) => createElement('button', { type: 'button', onClick: onPress, disabled, 'data-testid': testID }, title),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useUpdateBoard: () => ({ mutateAsync: updateBoardAsync }) }));
vi.mock('../../../lib/boards/use-apply-changed-board', () => ({ useApplyChangedBoard: () => applyChangedBoard }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useDirectorySetupSuggestionsEnabled: () => state.setupSuggestions,
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

// Kilter Original 12×12 with kickboard, Bolt Ons and Screw Ons: real catalogue ids.
const board = {
  uuid: 'board-1',
  name: 'Crux Kilter',
  ownerId: 'alex',
  gymUuid: 'gym-1',
  gymName: 'Crux',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  isAngleAdjustable: true,
  canEdit: true,
  canDelete: true,
  canRemoveFromGym: true,
} as UserBoard;

beforeEach(() => {
  state.reports = [report({})];
  state.setupSuggestions = false;
  updateBoardAsync.mockReset();
  applyChangedBoard.mockReset();
  applyChangedBoard.mockResolvedValue(undefined);
  confirm.mockReset();
  resolveAsync.mockReset();
  resolveAsync.mockResolvedValue({});
  refreshReads.mockReset();
  showToast.mockReset();
  guardArgs.length = 0;
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

describe('ReportReviewSheet with suggested setups', () => {
  const suggestion = (layoutId: number, sizeId: number, setIds: string, createdAt: string) => ({
    note: '',
    createdAt,
    reporter: null,
    suggestedSetup: { layoutId, sizeId, setIds, angle: null },
  });

  beforeEach(() => {
    state.setupSuggestions = true;
    state.reports = [
      report({
        reporterCount: 3,
        notes: [
          // Same setup twice, sets in another order: one group of 2.
          suggestion(1, 10, '20', '2026-11-20T10:00:00.000Z'),
          suggestion(1, 10, '20', '2026-11-21T10:00:00.000Z'),
          suggestion(1, 7, '1,20', '2026-11-22T10:00:00.000Z'),
          // What the board already has: nothing to use.
          suggestion(1, 10, '20,1', '2026-11-22T11:00:00.000Z'),
          { note: 'The angle is 45 not 40', createdAt: '2026-11-19T10:00:00.000Z', reporter: null },
        ],
      }),
      // Only "Set up wrong" reports carry a setup to use.
      report({ uuid: 'r2', reason: 'gone', notes: [suggestion(8, 17, '26,27', '2026-11-23T10:00:00.000Z')] }),
    ];
  });

  it('groups equal setups, most suggested first, and keeps only written notes as notes', () => {
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    const lines = [...screen.getByTestId('report-review-suggestions').querySelectorAll('span')].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      'mobile.setupSuggestion.suggestedHeading',
      'mobile.setupSuggestion.suggested{"count":2,"setup":"Original · 12×12 with kickboard · Square · Screw Ons"}',
      'mobile.setupSuggestion.suggested{"count":1,"setup":"Original · 12×14 · Commercial · Bolt Ons, Screw Ons"}',
    ]);
    expect(screen.queryByText('“”')).toBeNull();
    expect(screen.getByText('“The angle is 45 not 40”')).toBeTruthy();
    expect(screen.getByTestId('report-review-fix').textContent).toContain('mobile.setupSuggestion.editYourself');
  });

  it('Use this setup saves that setup on the board, then closes', async () => {
    const updated = { ...board, setIds: '20' };
    updateBoardAsync.mockResolvedValue(updated);
    const onClose = vi.fn();
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('report-review-use-setup-1:10:20:'));
    });
    expect(updateBoardAsync).toHaveBeenCalledTimes(1);
    expect(updateBoardAsync).toHaveBeenCalledWith({ boardUuid: 'board-1', layoutId: 1, sizeId: 10, setIds: '20' });
    expect(applyChangedBoard).toHaveBeenCalledWith(updated);
    expect(refreshReads).toHaveBeenCalledWith('board-1');
    expect(showToast).toHaveBeenCalledWith('reportReview.fixedToast', 'success');
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before saving a setup the owner already has elsewhere, then saves it anyway', async () => {
    const duplicate = {
      response: {
        errors: [
          {
            extensions: {
              code: 'BOARD_DUPLICATE_CONFIG',
              existingBoardUuid: 'board-2',
              existingBoardName: 'Home Kilter',
            },
          },
        ],
      },
    };
    updateBoardAsync.mockRejectedValueOnce(duplicate).mockResolvedValueOnce(board);
    confirm.mockResolvedValue(true);
    const onClose = vi.fn();
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('report-review-use-setup-1:7:1,20:'));
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'mobile.edit.duplicate.title',
        message: 'mobile.edit.duplicate.body{"name":"Home Kilter"}',
        confirmLabel: 'mobile.edit.duplicate.saveAnyway',
      }),
    );
    expect(updateBoardAsync.mock.calls.map(([input]) => input)).toEqual([
      { boardUuid: 'board-1', layoutId: 1, sizeId: 7, setIds: '1,20' },
      { boardUuid: 'board-1', layoutId: 1, sizeId: 7, setIds: '1,20', allowDuplicateConfig: true },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open and says so when the save fails, or the climber keeps the board as it is', async () => {
    updateBoardAsync.mockRejectedValueOnce(new Error('offline'));
    const onClose = vi.fn();
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('report-review-use-setup-1:10:20:'));
    });
    expect(screen.getByTestId('report-review-use-setup-error').textContent).toBe('reportReview.keepError');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps a swipe from dropping a Use this setup save in flight', async () => {
    let finish: (board: UserBoard) => void = () => undefined;
    updateBoardAsync.mockImplementation(
      () =>
        new Promise<UserBoard>((resolve) => {
          finish = resolve;
        }),
    );
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(guardArgs.at(-1)?.busy).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId('report-review-use-setup-1:10:20:'));
    });
    expect(guardArgs.at(-1)?.busy).toBe(true);
    await act(async () => {
      finish(board);
    });
    expect(guardArgs.at(-1)?.busy).toBe(false);
  });

  it('lists the five most suggested setups, then one line for the rest', () => {
    // Seven distinct setups: the angle tells them apart. Angle 55 was suggested
    // twice, so it leads; the others follow newest first.
    const angled = (angle: number, createdAt: string) => ({
      ...suggestion(1, 10, '1,20', createdAt),
      suggestedSetup: { layoutId: 1, sizeId: 10, setIds: '1,20', angle },
    });
    state.reports = [
      report({
        reporterCount: 8,
        notes: [
          angled(20, '2026-11-10T10:00:00.000Z'),
          angled(25, '2026-11-11T10:00:00.000Z'),
          angled(30, '2026-11-12T10:00:00.000Z'),
          angled(35, '2026-11-13T10:00:00.000Z'),
          angled(45, '2026-11-14T10:00:00.000Z'),
          angled(50, '2026-11-15T10:00:00.000Z'),
          angled(55, '2026-11-08T10:00:00.000Z'),
          angled(55, '2026-11-09T10:00:00.000Z'),
        ],
      }),
    ];
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    const useButtons = [
      ...screen.getByTestId('report-review-suggestions').querySelectorAll('[data-testid^="report-review-use-setup-"]'),
    ].map((button) => button.getAttribute('data-testid'));
    expect(MAX_SUGGESTED_SETUPS_SHOWN).toBe(5);
    expect(useButtons).toEqual([
      'report-review-use-setup-1:10:1,20:55',
      'report-review-use-setup-1:10:1,20:50',
      'report-review-use-setup-1:10:1,20:45',
      'report-review-use-setup-1:10:1,20:35',
      'report-review-use-setup-1:10:1,20:30',
    ]);
    expect(screen.getByTestId('report-review-other-suggestions').textContent).toBe(
      'mobile.setupSuggestion.otherSuggested{"count":2}',
    );
  });

  it('adds no count line when every suggestion has a row', () => {
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByTestId('report-review-suggestions')).toBeTruthy();
    expect(screen.queryByTestId('report-review-other-suggestions')).toBeNull();
  });

  it('holds every other answer while a Use this setup save is in flight', async () => {
    let fail: (error: Error) => void = () => undefined;
    updateBoardAsync.mockImplementation(
      () =>
        new Promise<UserBoard>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const onClose = vi.fn();
    const onAction = vi.fn();
    const screen = render(
      <ReportReviewSheet board={board} viewerUserId="alex" onClose={onClose} onAction={onAction} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('report-review-use-setup-1:10:20:'));
    });
    const competing = ['fix', 'remove', 'delete', 'keep'].map((action) =>
      screen.getByTestId(`report-review-${action}`),
    );
    for (const row of competing) expect(row.getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByTestId('report-review-use-setup-1:7:1,20:') as HTMLButtonElement).disabled).toBe(true);

    // A tap that lands anyway does nothing: no host action, no keep step.
    await act(async () => {
      for (const row of competing) fireEvent.click(row);
    });
    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reply')).toBeNull();
    expect(resolveAsync).not.toHaveBeenCalled();
    expect(updateBoardAsync).toHaveBeenCalledTimes(1);

    // Once the save ends, the answers are back.
    await act(async () => {
      fail(new Error('offline'));
    });
    expect(screen.getByTestId('report-review-keep').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(screen.getByTestId('report-review-keep'));
    expect(screen.getByTestId('reply')).toBeTruthy();
  });

  it('keeps "Fix the setup" when no suggestion is left to use', () => {
    // Every suggestion is what the board already has.
    state.reports = [report({ notes: [suggestion(1, 10, '20,1', '2026-11-22T11:00:00.000Z')] })];
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByTestId('report-review-suggestions')).toBeNull();
    expect(screen.getByTestId('report-review-fix').textContent).toContain('reportReview.fix');
  });

  it('shows the suggestions without Use this setup to a viewer who cannot edit the board', () => {
    const screen = render(
      <ReportReviewSheet
        board={{ ...board, canEdit: false }}
        viewerUserId="sam"
        onClose={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId('report-review-suggestions')).toBeTruthy();
    expect(screen.queryByTestId('report-review-use-setup-1:10:20:')).toBeNull();
    expect(screen.queryByTestId('report-review-fix')).toBeNull();
  });

  it('shows no suggestions while the flag is off', () => {
    state.setupSuggestions = false;
    const screen = render(<ReportReviewSheet board={board} viewerUserId="alex" onClose={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByTestId('report-review-suggestions')).toBeNull();
    expect(screen.getByTestId('report-review-fix').textContent).toContain('reportReview.fix');
  });
});
