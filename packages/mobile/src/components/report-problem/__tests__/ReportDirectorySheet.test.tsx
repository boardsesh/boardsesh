// @vitest-environment jsdom
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => async () => false }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import { ReportDirectorySheet } from '../ReportDirectorySheet';

const state = vi.hoisted(() => ({
  offline: false,
  gym: null as Partial<Gym> | null,
  gymBoards: [] as { uuid: string; name: string }[],
  boardPending: false,
  boardError: false,
}));
const boardMutate = vi.hoisted(() => vi.fn());
const gymMutate = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());
const gymBoardsArgs = vi.hoisted(() => [] as (string | null)[]);
// The report sheet's own dismissal, which the claim handoff waits for.
const dismissal = vi.hoisted(() => ({
  calls: 0,
  resolve: null as ((result: { status: 'dismissed' | 'aborted' }) => void) | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
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
vi.mock('../../TextAction', () => ({
  TextAction: ({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, label),
}));
vi.mock('../../tick', () => ({
  TickNoteField: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    accessibilityLabel: string;
  }) =>
    createElement('textarea', {
      'aria-label': accessibilityLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../../RadioGroup', () => ({
  RadioGroup: ({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string }[];
    value: string | null;
    onChange: (next: string) => void;
  }) =>
    createElement(
      'div',
      { role: 'radiogroup' },
      options.map((option) =>
        createElement('button', {
          key: option.value,
          role: 'radio',
          'aria-label': option.label,
          'aria-pressed': option.value === value,
          onClick: () => onChange(option.value),
        }),
      ),
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../hooks/use-unsaved-sheet-guard', () => ({
  useUnsavedSheetGuard: ({ onClose }: { onClose: () => void }) => ({
    requestClose: onClose,
    enablePanDownToClose: true,
  }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => 'alex' }));
vi.mock('../../../lib/analytics', () => ({ track }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useGym: (gymUuid: string | null) => ({ data: gymUuid ? state.gym : undefined }),
  useGymBoards: (gymUuid: string | null) => {
    gymBoardsArgs.push(gymUuid);
    return { data: gymUuid ? state.gymBoards : undefined };
  },
}));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  dismissManagedSheetAndWait: () => {
    dismissal.calls += 1;
    return new Promise((resolve) => {
      dismissal.resolve = resolve;
    });
  },
}));
vi.mock('../../../lib/graphql/hooks/use-directory-reports', () => ({
  useReportBoard: () => ({ mutate: boardMutate, isPending: state.boardPending, isError: state.boardError }),
  useReportGym: () => ({ mutate: gymMutate, isPending: false, isError: false }),
}));

const board = {
  uuid: 'board-1',
  name: 'Crux Kilter',
  ownerId: 'sam',
  ownerDisplayName: 'Sam',
  gymUuid: 'gym-1',
  gymName: 'Crux',
  boardType: 'kilter',
} as UserBoard;

function renderBoard(onClaim = vi.fn()) {
  return render(<ReportDirectorySheet target={{ kind: 'board', board }} onClose={vi.fn()} onClaim={onClaim} />);
}

beforeEach(() => {
  Object.assign(state, {
    offline: false,
    gym: { uuid: 'gym-1', name: 'Crux', listingState: 'RUN_BY_GYM', canClaim: false },
    gymBoards: [],
    boardPending: false,
    boardError: false,
  });
  boardMutate.mockReset();
  gymMutate.mockReset();
  track.mockReset();
  gymBoardsArgs.length = 0;
  dismissal.calls = 0;
  dismissal.resolve = null;
});

describe('ReportDirectorySheet on a board', () => {
  it('says who will see it, from the same routing the server uses', () => {
    const screen = renderBoard();
    expect(screen.getByTestId('report-problem-audience').textContent).toBe(
      'report.routeCreatorAndStaff{"name":"Sam","gym":"Crux"}',
    );
    expect(screen.getByTestId('report-problem-subject').textContent).toBe(
      'report.boardAtGym{"board":"Crux Kilter","gym":"Crux"}',
    );
  });

  it('sends the picked reason and note once, then says it went through', () => {
    const screen = renderBoard();
    const send = () => screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('report.boardReasons.wrongSetup'));
    fireEvent.change(screen.getByLabelText('report.noteLabel'), { target: { value: '  12x14 at 40  ' } });
    fireEvent.click(send());
    fireEvent.click(send());
    expect(boardMutate).toHaveBeenCalledTimes(1);
    expect(boardMutate.mock.calls[0][0]).toEqual({
      boardUuid: 'board-1',
      reason: 'wrong_setup',
      duplicateOfBoardUuid: null,
      note: '12x14 at 40',
    });
    const { onSuccess, onSettled } = boardMutate.mock.calls[0][1];
    act(() => {
      onSuccess({ status: 'added', reportUuid: 'r1', routedTo: ['creator'], otherReporterCount: 2 });
      onSettled();
    });
    expect(screen.getByTestId('report-problem-done').textContent).toBe('report.joined{"count":2}');
    expect(track).toHaveBeenCalledWith('Report Problem Sent', {
      targetKind: 'board',
      reason: 'wrong_setup',
      status: 'added',
      platform: 'android',
    });
  });

  it('shows the done line for each status', () => {
    const screen = renderBoard();
    fireEvent.click(screen.getByLabelText('report.boardReasons.gone'));
    fireEvent.click(screen.getByTestId('sheet-top-bar-trailing'));
    act(() => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'already_reported',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
      });
    });
    expect(screen.getByTestId('report-problem-done').textContent).toBe('report.alreadyReported');
    expect(screen.getByTestId('sheet-top-bar-trailing').textContent).toBe('actions.done');
  });

  it('asks which board is the same wall for Listed twice, and sends the pick', () => {
    state.gymBoards = [
      { uuid: 'board-1', name: 'Crux Kilter' },
      { uuid: 'board-2', name: 'Crux Kilter 2' },
    ];
    const screen = renderBoard();
    expect(gymBoardsArgs.every((gymUuid) => gymUuid === null)).toBe(true);
    fireEvent.click(screen.getByLabelText('report.boardReasons.duplicate'));
    // The board itself is never offered as its own duplicate.
    expect(screen.queryByLabelText('Crux Kilter')).toBeNull();
    fireEvent.click(screen.getByLabelText('Crux Kilter 2'));
    fireEvent.click(screen.getByTestId('sheet-top-bar-trailing'));
    expect(boardMutate.mock.calls[0][0]).toMatchObject({ reason: 'duplicate', duplicateOfBoardUuid: 'board-2' });
  });

  it('needs ten characters before Something else can be sent', () => {
    const screen = renderBoard();
    fireEvent.click(screen.getByLabelText('report.boardReasons.other'));
    const send = screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('report.noteRequiredLabel'), { target: { value: 'Holds moved' } });
    expect((screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers the claim on a gym nobody runs yet, and hands the gym over once this sheet is gone', async () => {
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'UNCLAIMED', canClaim: true };
    const onClaim = vi.fn();
    const screen = renderBoard(onClaim);
    fireEvent.click(screen.getByTestId('report-problem-claim'));
    fireEvent.click(screen.getByTestId('report-problem-claim'));
    // The claim sheet must not present while this one is still sliding away.
    expect(dismissal.calls).toBe(1);
    expect(onClaim).not.toHaveBeenCalled();
    await act(async () => {
      dismissal.resolve?.({ status: 'dismissed' });
    });
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onClaim).toHaveBeenCalledWith(state.gym);
  });

  it('opens no claim when the host went away during the handoff', async () => {
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'UNCLAIMED', canClaim: true };
    const onClaim = vi.fn();
    const screen = renderBoard(onClaim);
    fireEvent.click(screen.getByTestId('report-problem-claim'));
    await act(async () => {
      dismissal.resolve?.({ status: 'aborted' });
    });
    expect(onClaim).not.toHaveBeenCalled();
  });

  it('waits for a connection', () => {
    state.offline = true;
    const screen = renderBoard();
    fireEvent.click(screen.getByLabelText('report.boardReasons.gone'));
    expect((screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('report.offline')).toBeTruthy();
  });
});

describe('ReportDirectorySheet on a gym', () => {
  it('sends a gym report and words who will see it', () => {
    const gym = { uuid: 'gym-1', name: 'Crux', listingState: 'RUN_BY_GYM', canEdit: false } as Gym;
    const screen = render(<ReportDirectorySheet target={{ kind: 'gym', gym }} onClose={vi.fn()} onClaim={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('report.gymReasons.details'));
    expect(screen.getByTestId('report-problem-audience').textContent).toBe('report.routeStaff{"name":"","gym":"Crux"}');
    fireEvent.click(screen.getByTestId('sheet-top-bar-trailing'));
    expect(gymMutate.mock.calls[0][0]).toEqual({ gymUuid: 'gym-1', reason: 'wrong_details', note: null });
  });
});
