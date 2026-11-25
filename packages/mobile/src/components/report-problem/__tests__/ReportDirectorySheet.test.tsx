// @vitest-environment jsdom
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => async () => false }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardSetupReviewReason, Gym, UserBoard } from '@boardsesh/shared-schema';
import { ReportDirectorySheet } from '../ReportDirectorySheet';

const state = vi.hoisted(() => ({
  offline: false,
  gym: null as Partial<Gym> | null,
  gymBoards: [] as { uuid: string; name: string }[],
  boardPending: false,
  boardError: false,
  setupSuggestions: false,
  activeBoard: null as Partial<UserBoard> | null,
}));
// "Climb it now": the cache write and the bind, in the order they ran.
const calls = vi.hoisted(() => [] as string[]);
const activate = vi.hoisted(() => vi.fn());
const applyChangedBoard = vi.hoisted(() => vi.fn());
const boardMutate = vi.hoisted(() => vi.fn());
const gymMutate = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());
const gymBoardsArgs = vi.hoisted(() => [] as (string | null)[]);
const fetchBoard = vi.hoisted(() => vi.fn());
const activateOptions = vi.hoisted(() => [] as unknown[]);
// The last `dirty` the sheet handed its discard guard.
const guard = vi.hoisted(() => ({ dirty: false }));
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
  View: ({ children, testID }: { children: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
// Each menu row as buttons, one per action, so a test picks by label.
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    label,
    actions,
    onSelectIndex,
  }: {
    label: string;
    actions: { label: string; selected?: boolean; disabled?: boolean }[];
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'div',
      { 'data-value': label },
      actions.map((action, index) =>
        createElement('button', {
          key: action.label,
          type: 'button',
          'aria-label': action.label,
          'aria-pressed': action.selected === true,
          disabled: action.disabled === true,
          onClick: () => onSelectIndex(index),
        }),
      ),
    ),
}));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  insetGroupedRowStyles: { row: {}, leading: {}, text: {} },
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    testID,
    disabled,
    loading,
  }: {
    title: string;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
    loading?: boolean;
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'data-testid': testID, disabled, 'aria-busy': loading === true },
      title,
    ),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useDirectorySetupSuggestionsEnabled: () => state.setupSuggestions,
  useFeatureFlag: () => undefined,
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard }),
}));
vi.mock('../../../lib/boards/use-activate-board', () => ({
  useActivateBoard: (options: unknown) => {
    activateOptions.push(options);
    return activate;
  },
}));
vi.mock('../../../lib/boards/use-apply-changed-board', () => ({
  useApplyChangedBoard: () => applyChangedBoard,
  boardKeepingLocalAngle: (board: UserBoard, active: UserBoard | null) =>
    active?.uuid === board.uuid && board.isAngleAdjustable ? { ...board, angle: active.angle } : board,
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
  useUnsavedSheetGuard: ({ onClose, dirty }: { onClose: () => void; dirty: boolean }) => {
    guard.dirty = dirty;
    return { requestClose: onClose, enablePanDownToClose: true };
  },
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => 'alex' }));
vi.mock('../../../lib/analytics', () => ({ track }));
vi.mock('../../../lib/graphql/hooks', () => ({
  fetchBoardByUuid: fetchBoard,
  useGym: (gymUuid: string | null) => ({ data: gymUuid ? (state.gym ?? undefined) : undefined }),
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

// Kilter Original 12×12 with kickboard, Bolt Ons and Screw Ons: real catalogue ids.
const board = {
  uuid: 'board-1',
  name: 'Crux Kilter',
  ownerId: 'sam',
  ownerDisplayName: 'Sam',
  gymUuid: 'gym-1',
  gymName: 'Crux',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  isAngleAdjustable: true,
} as UserBoard;

function renderBoard(onClaim = vi.fn(), target: UserBoard = board, onClose = vi.fn()) {
  return render(<ReportDirectorySheet target={{ kind: 'board', board: target }} onClose={onClose} onClaim={onClaim} />);
}

beforeEach(() => {
  Object.assign(state, {
    offline: false,
    gym: { uuid: 'gym-1', name: 'Crux', listingState: 'RUN_BY_GYM', canClaim: false },
    gymBoards: [],
    boardPending: false,
    boardError: false,
    setupSuggestions: false,
    activeBoard: null,
  });
  calls.length = 0;
  activate.mockReset();
  activate.mockImplementation(async () => {
    calls.push('activate');
  });
  applyChangedBoard.mockReset();
  applyChangedBoard.mockImplementation(async () => {
    calls.push('apply');
  });
  boardMutate.mockReset();
  gymMutate.mockReset();
  track.mockReset();
  gymBoardsArgs.length = 0;
  fetchBoard.mockReset();
  activateOptions.length = 0;
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
      hadSuggestion: false,
      setupOutcome: null,
    });
  });

  it('keeps the plain note field on Set up wrong while the setup flag is off', () => {
    const screen = renderBoard();
    fireEvent.click(screen.getByLabelText('report.boardReasons.wrongSetup'));
    expect(screen.queryByTestId('setup-suggestion-fields')).toBeNull();
    // Today's rule: a note is optional, so Send is ready without one.
    expect((screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement).disabled).toBe(false);
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
    const onClose = vi.fn();
    const screen = renderBoard(onClaim, board, onClose);
    fireEvent.click(screen.getByTestId('report-problem-claim'));
    await act(async () => {
      dismissal.resolve?.({ status: 'aborted' });
    });
    expect(onClaim).not.toHaveBeenCalled();
    // Still done with: a host waiting on the report must never hang.
    expect(onClose).toHaveBeenCalledTimes(1);
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

describe('ReportDirectorySheet suggesting the setup', () => {
  const send = (screen: ReturnType<typeof renderBoard>) =>
    screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement;
  const row = (screen: ReturnType<typeof renderBoard>, name: string) =>
    within(screen.getByTestId(`setup-suggestion-${name}`));
  const value = (screen: ReturnType<typeof renderBoard>, name: string) =>
    screen.getByTestId(`setup-suggestion-${name}`).querySelector('[data-value]')?.getAttribute('data-value');

  beforeEach(() => {
    state.setupSuggestions = true;
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'UNCLAIMED', canClaim: false };
  });

  function openWrongSetup(target: UserBoard = board) {
    const screen = renderBoard(vi.fn(), target);
    fireEvent.click(screen.getByLabelText('report.boardReasons.wrongSetup'));
    return screen;
  }

  it("opens on the board's setup, and keeps Send off until something differs", () => {
    const screen = openWrongSetup();
    expect(value(screen, 'layout')).toBe('Original');
    expect(value(screen, 'size')).toBe('12×12 with kickboard · Square');
    expect(value(screen, 'holds')).toBe('Bolt Ons, Screw Ons');
    // The board tilts, so its angle is not part of the setup.
    expect(screen.queryByTestId('setup-suggestion-angle')).toBeNull();
    expect(send(screen).disabled).toBe(true);
    expect(screen.getByTestId('report-problem-setup-hint').textContent).toBe('mobile.setupSuggestion.unchangedHint');
    fireEvent.click(row(screen, 'size').getByLabelText('12×14 · Commercial'));
    expect(send(screen).disabled).toBe(false);
    expect(screen.queryByTestId('report-problem-setup-hint')).toBeNull();
  });

  it('reads "Choose" for holds the catalogue does not list, and opens unchanged', () => {
    const screen = openWrongSetup({ ...board, setIds: '999' } as UserBoard);
    expect(value(screen, 'holds')).toBe('mobile.setupSuggestion.choose');
    expect(send(screen).disabled).toBe(true);
    fireEvent.click(row(screen, 'holds').getByLabelText('Bolt Ons'));
    expect(value(screen, 'holds')).toBe('Bolt Ons');
    expect(send(screen).disabled).toBe(false);
  });

  it('resets the size and holds when the layout changes', () => {
    const screen = openWrongSetup();
    fireEvent.click(row(screen, 'holds').getByLabelText('Screw Ons'));
    expect(value(screen, 'holds')).toBe('Bolt Ons');
    fireEvent.click(row(screen, 'layout').getByLabelText('Homewall'));
    // Homewall's default size, with every set of it.
    expect(value(screen, 'size')).toBe('7×10 · Full Ride');
    expect(value(screen, 'holds')).toBe('Mainline, Auxiliary');
  });

  it('never leaves the board without holds', () => {
    const screen = openWrongSetup();
    fireEvent.click(row(screen, 'holds').getByLabelText('Screw Ons'));
    const last = row(screen, 'holds').getByLabelText('Bolt Ons') as HTMLButtonElement;
    expect(last.disabled).toBe(true);
    fireEvent.click(last);
    expect(value(screen, 'holds')).toBe('Bolt Ons');
  });

  it('takes a long enough note instead of a changed setup', () => {
    const screen = openWrongSetup();
    fireEvent.change(screen.getByLabelText('report.noteLabel'), { target: { value: 'Short' } });
    expect(send(screen).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('report.noteLabel'), { target: { value: 'The kicker is gone' } });
    expect(send(screen).disabled).toBe(false);
    fireEvent.click(send(screen));
    expect(boardMutate.mock.calls[0][0]).toEqual({
      boardUuid: 'board-1',
      reason: 'wrong_setup',
      duplicateOfBoardUuid: null,
      note: 'The kicker is gone',
    });
  });

  it('offers the angle on a board that does not tilt, and sends it', () => {
    const moon = {
      ...board,
      boardType: 'moonboard',
      layoutId: 2,
      sizeId: 1,
      setIds: '2,3,4',
      angle: 40,
      isAngleAdjustable: false,
    } as UserBoard;
    const screen = openWrongSetup(moon);
    expect(value(screen, 'angle')).toBe('40°');
    fireEvent.click(row(screen, 'angle').getByLabelText('25°'));
    fireEvent.click(send(screen));
    expect(boardMutate.mock.calls[0][0].suggestedSetup).toEqual({ layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 25 });
  });

  it('says what happens to a changed setup, from the gym', () => {
    const screen = openWrongSetup();
    fireEvent.click(row(screen, 'holds').getByLabelText('Screw Ons'));
    expect(screen.getByTestId('report-problem-audience').textContent).toBe(
      'mobile.setupSuggestion.previewEveryone{"gym":"Crux"}',
    );
  });

  it("asks the gym's staff first at a gym that runs itself", () => {
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'RUN_BY_GYM', canClaim: false };
    const screen = openWrongSetup();
    fireEvent.click(row(screen, 'holds').getByLabelText('Screw Ons'));
    expect(screen.getByTestId('report-problem-audience').textContent).toBe(
      'mobile.setupSuggestion.previewStaff{"gym":"Crux"}',
    );
  });

  it("shows no line under Send for a changed setup while the board's gym is unknown", () => {
    state.gym = null;
    const screen = openWrongSetup();
    // Unchanged, the report's routing line still says who reads it.
    expect(screen.getByTestId('report-problem-audience')).toBeTruthy();
    fireEvent.click(row(screen, 'holds').getByLabelText('Screw Ons'));
    expect(screen.queryByTestId('report-problem-audience')).toBeNull();
  });

  const applied = { ...board, layoutId: 8, sizeId: 17, setIds: '26,27', angle: 30 } as UserBoard;

  function sendHomewall() {
    const screen = openWrongSetup();
    fireEvent.click(row(screen, 'layout').getByLabelText('Homewall'));
    fireEvent.click(send(screen));
    expect(boardMutate.mock.calls[0][0]).toEqual({
      boardUuid: 'board-1',
      reason: 'wrong_setup',
      duplicateOfBoardUuid: null,
      note: null,
      suggestedSetup: { layoutId: 8, sizeId: 17, setIds: '26,27', angle: null },
    });
    return screen;
  }

  it('applies for everyone, then Climb it now binds the returned board once the sheet is gone', async () => {
    const screen = sendHomewall();
    act(() => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: applied,
      });
    });
    expect(track).toHaveBeenCalledWith(
      'Report Problem Sent',
      expect.objectContaining({
        hadSuggestion: true,
        setupOutcome: 'APPLIED',
      }),
    );
    // The board's reads take the new setup straight away.
    expect(applyChangedBoard).toHaveBeenCalledWith(applied);
    expect(screen.getByTestId('report-problem-done-title').textContent).toBe('mobile.setupSuggestion.appliedTitle');
    expect(screen.getByTestId('report-problem-done').textContent).toBe(
      'mobile.setupSuggestion.appliedBody{"gym":"Crux","setup":"Homewall · 7×10 · Full Ride · Mainline, Auxiliary"}',
    );
    calls.length = 0;
    applyChangedBoard.mockClear();

    fireEvent.click(screen.getByTestId('report-problem-climb-now'));
    fireEvent.click(screen.getByTestId('report-problem-climb-now'));
    expect(track).toHaveBeenCalledWith('Board Setup Climbed Now', {
      boardType: 'kilter',
      gymListingState: 'UNCLAIMED',
    });
    expect(dismissal.calls).toBe(1);
    expect(activate).not.toHaveBeenCalled();
    await act(async () => {
      dismissal.resolve?.({ status: 'dismissed' });
    });
    // The board's reads took the new setup when it arrived: the bind is the only write.
    expect(calls).toEqual(['activate']);
    expect(applyChangedBoard).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(applied);
    // A board picked from a report names no box the In range slot holds.
    expect(activateOptions.at(-1)).toEqual({ returnTo: '/(tabs)/climbs', recognizesHeldBox: false });
  });

  it("keeps the climber's own angle when the board is the one they are on", async () => {
    state.activeBoard = { ...board, angle: 50 };
    const screen = sendHomewall();
    act(() => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: applied,
      });
    });
    fireEvent.click(screen.getByTestId('report-problem-climb-now'));
    await act(async () => {
      dismissal.resolve?.({ status: 'dismissed' });
    });
    expect(activate).toHaveBeenCalledWith({ ...applied, angle: 50 });
  });

  it('reads the board again when the change committed without it, and waits to offer Climb it now', async () => {
    let resolveFetch: (fresh: UserBoard | null) => void = () => undefined;
    fetchBoard.mockImplementation(
      () =>
        new Promise<UserBoard | null>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const screen = sendHomewall();
    act(() => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: null,
      });
    });
    expect(fetchBoard).toHaveBeenCalledWith('board-1');
    // Still the applied step, worded from what was sent until the board arrives.
    expect(screen.getByTestId('report-problem-done-title').textContent).toBe('mobile.setupSuggestion.appliedTitle');
    expect(screen.getByTestId('report-problem-done').textContent).toBe(
      'mobile.setupSuggestion.appliedBody{"gym":"Crux","setup":"Homewall · 7×10 · Full Ride · Mainline, Auxiliary"}',
    );
    const waiting = screen.getByTestId('report-problem-climb-now') as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(waiting);
    expect(dismissal.calls).toBe(0);

    await act(async () => {
      resolveFetch(applied);
    });
    expect(applyChangedBoard).toHaveBeenCalledWith(applied);
    const ready = screen.getByTestId('report-problem-climb-now') as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    await act(async () => {
      dismissal.resolve?.({ status: 'dismissed' });
    });
    expect(activate).toHaveBeenCalledWith(applied);
  });

  it.each([
    ['the read fails', () => fetchBoard.mockRejectedValue(new Error('offline'))],
    ['the board is gone', () => fetchBoard.mockResolvedValue(null)],
  ])('keeps the applied line and drops Climb it now when %s', async (_case, arrange) => {
    arrange();
    const screen = sendHomewall();
    await act(async () => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: null,
      });
    });
    expect(screen.getByTestId('report-problem-done-title').textContent).toBe('mobile.setupSuggestion.appliedTitle');
    expect(screen.queryByTestId('report-problem-climb-now')).toBeNull();
    expect(applyChangedBoard).not.toHaveBeenCalled();
  });

  it('says the board is already set up that way when someone fixed it first, and offers it to climb', async () => {
    const fixed = { ...board, layoutId: 8, sizeId: 17, setIds: '26,27' } as UserBoard;
    fetchBoard.mockResolvedValue(fixed);
    const screen = sendHomewall();
    state.boardError = true;
    await act(async () => {
      boardMutate.mock.calls[0][1].onError({
        response: {
          errors: [{ message: 'Already set up', extensions: { code: 'BAD_USER_INPUT', reason: 'SETUP_UNCHANGED' } }],
        },
      });
      boardMutate.mock.calls[0][1].onSettled();
    });
    expect(fetchBoard).toHaveBeenCalledWith('board-1');
    expect(applyChangedBoard).toHaveBeenCalledWith(fixed);
    expect(screen.getByTestId('report-problem-done').textContent).toBe('mobile.setupSuggestion.alreadySetUp');
    expect(screen.queryByText('report.error')).toBeNull();
    fireEvent.click(screen.getByTestId('report-problem-climb-now'));
    await act(async () => {
      dismissal.resolve?.({ status: 'dismissed' });
    });
    expect(activate).toHaveBeenCalledWith(fixed);
  });

  it('keeps the form and the error line for any other refusal', async () => {
    const screen = sendHomewall();
    state.boardError = true;
    await act(async () => {
      boardMutate.mock.calls[0][1].onError({
        response: { errors: [{ message: 'Unknown layout', extensions: { code: 'BAD_USER_INPUT' } }] },
      });
      boardMutate.mock.calls[0][1].onSettled();
    });
    // The mutation's own error state re-renders the sheet.
    screen.rerender(<ReportDirectorySheet target={{ kind: 'board', board }} onClose={vi.fn()} onClaim={vi.fn()} />);
    expect(fetchBoard).not.toHaveBeenCalled();
    expect(screen.queryByTestId('report-problem-done')).toBeNull();
    expect(screen.getByText('report.error')).toBeTruthy();
  });

  it.each<[BoardSetupReviewReason | null, string]>([
    ['CLAIMED_GYM', 'mobile.setupSuggestion.reviewClaimedGym{"gym":"Crux"}'],
    ['NO_GYM', 'mobile.setupSuggestion.reviewNoGym'],
    ['RECENT_CHANGE', 'mobile.setupSuggestion.reviewRecentChange{"hours":24}'],
    ['RECENTLY_UNDONE', 'mobile.setupSuggestion.reviewRecentlyUndone{"days":90}'],
    ['DAILY_LIMIT', 'mobile.setupSuggestion.reviewDailyLimit{"count":3}'],
    ['CLASHES', 'mobile.setupSuggestion.reviewClashes'],
    // The server's flag is off: the suggestion is kept for review, with today's line.
    [null, 'report.sent'],
  ])('says why a suggestion waits (%s)', (reason, line) => {
    const screen = sendHomewall();
    act(() => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'SENT_FOR_REVIEW',
        setupReviewReason: reason,
        board: null,
      });
    });
    expect(screen.getByTestId('report-problem-done').textContent).toBe(line);
    expect(screen.queryByTestId('report-problem-climb-now')).toBeNull();
    expect(applyChangedBoard).not.toHaveBeenCalled();
  });
});

// The builder's near-miss "Use it and fix its setup" (#8151): the sheet opens on
// "Set up wrong" with the climber's own setup in it. Nothing goes until Send.
describe('ReportDirectorySheet opened from the builder with a setup', () => {
  // A Masters 2019 entered without its Screw-on Feet (set 20); the climber's has them.
  const noFeet = {
    ...board,
    boardType: 'moonboard',
    layoutId: 5,
    sizeId: 1,
    setIds: '17,18,19,21',
    angle: 40,
    isAngleAdjustable: true,
  } as UserBoard;
  const climbersSetup = { layoutId: 5, sizeId: 1, setIds: '17,18,19,20,21' };

  function prefilled(climbNowOffered = true, onClose = vi.fn(), closeAfterDismissed = false) {
    return (
      <ReportDirectorySheet
        target={{ kind: 'board', board: noFeet }}
        onClose={onClose}
        onClaim={vi.fn()}
        initialReason="wrong_setup"
        initialSetup={climbersSetup}
        climbNowOffered={climbNowOffered}
        closeAfterDismissed={closeAfterDismissed}
      />
    );
  }
  function renderPrefilled(climbNowOffered = true, onClose = vi.fn(), closeAfterDismissed = false) {
    return render(prefilled(climbNowOffered, onClose, closeAfterDismissed));
  }
  const send = (screen: ReturnType<typeof render>) => screen.getByTestId('sheet-top-bar-trailing') as HTMLButtonElement;

  it('opens the setup fields on the climber setup, ready to send, and sends only on Send', () => {
    state.setupSuggestions = true;
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'UNCLAIMED', canClaim: false };
    const screen = renderPrefilled();
    expect(screen.getByLabelText('report.boardReasons.wrongSetup').getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByTestId('setup-suggestion-holds').querySelector('[data-value]')?.getAttribute('data-value'),
    ).toContain('Screw-on Feet');
    expect(boardMutate).not.toHaveBeenCalled();
    expect(send(screen).disabled).toBe(false);
    fireEvent.click(send(screen));
    expect(boardMutate.mock.calls[0][0]).toEqual({
      boardUuid: 'board-1',
      reason: 'wrong_setup',
      duplicateOfBoardUuid: null,
      note: null,
      suggestedSetup: { layoutId: 5, sizeId: 1, setIds: '17,18,19,20,21', angle: null },
    });
  });

  it('writes the climber setup into the note while the setup fields are off', () => {
    state.setupSuggestions = false;
    const screen = renderPrefilled();
    expect(screen.queryByTestId('setup-suggestion-fields')).toBeNull();
    const note = screen.getByLabelText('report.noteLabel') as HTMLTextAreaElement;
    expect(note.value).toBe(
      'report.setupNote{"setup":"Masters 2019 · Standard · 11x18 Grid · Hold Set A, Hold Set B, Original School Holds, Screw-on Feet, Wooden Holds"}',
    );
    expect(boardMutate).not.toHaveBeenCalled();
    fireEvent.click(send(screen));
    expect(boardMutate.mock.calls[0][0]).toMatchObject({ reason: 'wrong_setup', note: note.value });
    expect(boardMutate.mock.calls[0][0].suggestedSetup).toBeUndefined();
  });

  it('leaves out Climb it now when the host has bound the board already', () => {
    state.setupSuggestions = true;
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'UNCLAIMED', canClaim: false };
    const screen = renderPrefilled(false);
    fireEvent.click(send(screen));
    act(() => {
      boardMutate.mock.calls[0][1].onSuccess({
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: { ...noFeet, setIds: climbersSetup.setIds },
      });
    });
    expect(screen.getByTestId('report-problem-done-title')).toBeTruthy();
    expect(screen.queryByTestId('report-problem-climb-now')).toBeNull();
  });
});

describe('ReportDirectorySheet opened from the builder: closing and the generated note', () => {
  const noFeet = {
    ...board,
    boardType: 'moonboard',
    layoutId: 5,
    sizeId: 1,
    setIds: '17,18,19,21',
    angle: 40,
    isAngleAdjustable: true,
  } as UserBoard;
  const climbersSetup = { layoutId: 5, sizeId: 1, setIds: '17,18,19,20,21' };
  function sheet(onClose = vi.fn(), closeAfterDismissed = false) {
    return (
      <ReportDirectorySheet
        target={{ kind: 'board', board: noFeet }}
        onClose={onClose}
        onClaim={vi.fn()}
        initialReason="wrong_setup"
        initialSetup={climbersSetup}
        closeAfterDismissed={closeAfterDismissed}
      />
    );
  }
  const generated =
    'report.setupNote{"setup":"Masters 2019 · Standard · 11x18 Grid · Hold Set A, Hold Set B, Original School Holds, Screw-on Feet, Wooden Holds"}';
  const noteField = (screen: ReturnType<typeof render>) =>
    screen.getByLabelText('report.noteLabel') as HTMLTextAreaElement;

  it('closes without asking to discard until the climber changes something', () => {
    state.setupSuggestions = true;
    state.gym = { uuid: 'gym-1', name: 'Crux', listingState: 'UNCLAIMED', canClaim: false };
    const screen = render(sheet());
    expect(guard.dirty).toBe(false);
    fireEvent.change(noteField(screen), { target: { value: 'Feet on the left' } });
    expect(guard.dirty).toBe(true);
  });

  it('treats the generated note as untouched too', () => {
    const screen = render(sheet());
    expect(noteField(screen).value).toBe(generated);
    expect(guard.dirty).toBe(false);
  });

  it('drops the generated note once the setup fields appear, or another reason is picked', () => {
    const screen = render(sheet());
    expect(noteField(screen).value).toBe(generated);
    state.setupSuggestions = true;
    screen.rerender(sheet());
    expect(screen.getByTestId('setup-suggestion-holds')).toBeTruthy();
    expect(noteField(screen).value).toBe('');

    state.setupSuggestions = false;
    const other = render(sheet());
    fireEvent.click(within(other.container).getByLabelText('report.boardReasons.gone'));
    expect((within(other.container).getByLabelText('report.noteLabel') as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps a note the climber edited when the fields appear', () => {
    const screen = render(sheet());
    fireEvent.change(noteField(screen), { target: { value: `${generated} and the kicker` } });
    state.setupSuggestions = true;
    screen.rerender(sheet());
    expect(noteField(screen).value).toBe(`${generated} and the kicker`);
  });

  it('tells the host it closed only once the sheet has slid away', async () => {
    const onClose = vi.fn();
    const screen = render(sheet(onClose, true));
    fireEvent.click(screen.getByTestId('sheet-top-bar-leading'));
    fireEvent.click(screen.getByTestId('sheet-top-bar-leading'));
    expect(dismissal.calls).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      dismissal.resolve?.({ status: 'dismissed' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
