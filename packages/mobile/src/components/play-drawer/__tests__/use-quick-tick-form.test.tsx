// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { logbookClimbAngleKey, type LogbookEntry } from '@boardsesh/board-react';
import { MIN_ATTEMPT_COUNT } from '@boardsesh/play-view';

// The behavioural half of the create-tick sheet: flash-vs-send derivation, the
// tries clamp, the climbedAt rule, the analytics events and the save-error
// channel. These used to live in quick-tick-bar.test.tsx; they moved with the
// logic when the form state was lifted into this hook, so QuickTickBar could
// become the presentational field stack and LogAscentSheet could put the same
// form's actions in ModalSheet's pinned footer.

const CLIMB_UUID = 'climb-1';
const ANGLE = 40;

const boardState = vi.hoisted(() => ({
  current: null as unknown,
}));

// Grades list returned by useGrades — empty by default (matches most tests,
// which don't exercise grade selection), overridable per-test.
const gradesState = vi.hoisted(() => ({
  current: [] as Array<{ difficultyId: number; name: string }>,
}));

// Stable save mock so a test can assert on the input passed to saveTick.mutate.
// Invokes onSuccess by default (so the TickLogged track call and the
// savedRef/onDismiss wiring fire the way the real mutation would); flip
// `failure` to drive the onError path instead.
const saveMock = vi.hoisted(() => {
  const state = { failure: null as Error | null };
  return {
    state,
    mutate: vi.fn((_input: unknown, callbacks?: { onSuccess?: () => void; onError?: (error: unknown) => void }) => {
      if (state.failure) callbacks?.onError?.(state.failure);
      else callbacks?.onSuccess?.();
    }),
  };
});

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: gradesState.current }) }));
// The climber's selected board, which the save path sends as `boardUuid` when
// it is the wall this tick is actually on. Mocked so the test doesn't pull the
// AsyncStorage-backed store into the graph.
const activeBoardState = vi.hoisted(() => ({
  current: null as { uuid: string; boardType: string; layoutId: number; sizeId: number; setIds: string } | null,
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoardState.current }),
}));
// Partial mock: keep the real exports (BOULDER_GRADES et al., pulled in
// transitively via climbed-at.ts → @boardsesh/profile-stats) and override only
// the board-name normaliser.
vi.mock('@boardsesh/board-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-config')>();
  return { ...actual, toBoardName: (name: string) => name };
});
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    QuickTickFailed: 'Quick Tick Failed',
    TickLogged: 'Tick Logged',
  },
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toastMock }));
// The hook reads board-presence flags; mock the provider so the test doesn't
// pull in its ws-client → expo-secure-store chain (un-mockable native module).
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: false, boardId: null }),
}));
// Mock the Rogue-timer provider so the test doesn't pull its rogue-timer-ble →
// react-native-ble-plx chain (Flow source Rolldown can't parse) into the graph.
vi.mock('../../../providers/rogue-timer-provider', () => ({
  useOptionalRogueTimer: () => null,
}));
vi.mock('../../../hooks/use-local-ticks', () => ({ useLocalPendingTicks: () => ({ data: 0 }) }));
// Connectivity drives which save-failure message the form shows (issue #4315).
const connectivityState = vi.hoisted(() => ({ isOffline: false }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => connectivityState.isOffline }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));

// The board provider: an EMPTY logbook array (so an array scan finds nothing)
// plus a populated `logbookByClimbAngle` Map (the correct O(1) index).
vi.mock('@boardsesh/board-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-react')>();
  // The hook reads `getLogbook` from the stable actions context and the
  // `logbookByClimbAngle` index from the volatile logbook context. The fixture
  // object carries both fields, so both hooks resolve to it.
  return {
    ...actual,
    useOptionalBoardActions: () => boardState.current,
    useOptionalBoardLogbook: () => boardState.current,
    useSaveTick: () => ({ mutate: saveMock.mutate, isPending: false }),
  };
});

import { useQuickTickForm, type QuickTickFormInput, type QuickTickDismissSnapshot } from '../use-quick-tick-form';
import { track } from '../../../lib/analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';

// A DOM stand-in for the sheet: every control the real form exposes, driven
// through the hook's returned callbacks, so the assertions below read the same
// values a climber would see.
function Harness(props: QuickTickFormInput) {
  const form = useQuickTickForm(props);
  return createElement(
    'div',
    null,
    createElement('button', { 'data-testid': 'save', onClick: form.onSave }, form.saveLabel),
    createElement('button', { 'data-testid': 'attempt', onClick: form.onAttempt }),
    createElement('button', {
      'data-testid': 'tries-increment',
      onClick: () => form.onTriesSelect(form.tickState.attemptCount + 1),
    }),
    createElement('button', {
      'data-testid': 'tries-decrement',
      disabled: form.tickState.attemptCount <= MIN_ATTEMPT_COUNT,
      onClick: () => form.onTriesSelect(Math.max(MIN_ATTEMPT_COUNT, form.tickState.attemptCount - 1)),
    }),
    createElement('span', { 'data-testid': 'tries-value' }, String(form.tickState.attemptCount)),
    createElement('button', {
      'data-testid': 'grade-select',
      onClick: () => form.onGradeSelect(gradesState.current[0]?.difficultyId),
    }),
    createElement('button', {
      'data-testid': 'climbedat-date',
      onClick: () => form.onClimbedAtChange(new Date('2025-03-15T12:00:00.000Z')),
    }),
    createElement('button', { 'data-testid': 'future-adjusted', onClick: form.onFutureAdjusted }),
    createElement('span', { 'data-testid': 'ascent-type' }, form.ascentType),
    createElement('span', { 'data-testid': 'last-error' }, form.lastError ?? ''),
  );
}

function renderForm(overrides: Partial<QuickTickFormInput> = {}) {
  return render(
    createElement(Harness, {
      climbUuid: CLIMB_UUID,
      boardName: 'kilter',
      angle: ANGLE,
      isMirror: false,
      isBenchmark: false,
      baseAscensionistCount: 37,
      onDismiss: vi.fn(),
      ...overrides,
    }),
  );
}

/** The number the tries control is currently showing the climber. */
function displayedTries(container: HTMLElement): number {
  return Number(container.querySelector('[data-testid="tries-value"]')?.textContent);
}

function saveLabel(container: HTMLElement): string {
  return container.querySelector('[data-testid="save"]')?.textContent ?? '';
}

/** Board fixture with a mounted provider and NO history for this climb+angle. */
function boardWithoutHistory() {
  return {
    logbook: [],
    logbookByClimbAngle: new Map<string, LogbookEntry[]>(),
    // Fetched and genuinely empty — the only state in which an empty index may
    // be read as "no history".
    fetchedLogbookClimbUuids: new Set([CLIMB_UUID]),
    getLogbook: vi.fn(),
  };
}

/** Board fixture with a mounted provider and one prior tick for this climb+angle. */
function boardWithHistory() {
  const tick = { climb_uuid: CLIMB_UUID, angle: ANGLE } as unknown as LogbookEntry;
  return {
    logbook: [tick],
    logbookByClimbAngle: new Map<string, LogbookEntry[]>([[logbookClimbAngleKey(CLIMB_UUID, ANGLE), [tick]]]),
    fetchedLogbookClimbUuids: new Set([CLIMB_UUID]),
    getLogbook: vi.fn(),
  };
}

/** Provider mounted, but this climb's logbook fetch hasn't resolved yet. */
function boardWithUnfetchedLogbook() {
  return {
    logbook: [],
    logbookByClimbAngle: new Map<string, LogbookEntry[]>(),
    fetchedLogbookClimbUuids: new Set<string>(),
    getLogbook: vi.fn(),
  };
}

beforeEach(() => {
  saveMock.mutate.mockClear();
  saveMock.state.failure = null;
  toastMock.showToast.mockClear();
  gradesState.current = [];
  connectivityState.isOffline = false;
  activeBoardState.current = null;
  vi.mocked(track).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useQuickTickForm hasPriorHistory', () => {
  it('threads the immutable climb count into SaveTickOptions', () => {
    boardState.current = boardWithoutHistory();
    const { getByTestId } = renderForm({ baseAscensionistCount: 37 });

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ baseAscensionistCount: 37 });
  });

  it('reads the logbookByClimbAngle index, not the raw logbook array', () => {
    const tick = { climb_uuid: CLIMB_UUID, angle: ANGLE } as unknown as LogbookEntry;
    boardState.current = {
      // Empty array: a `.some()` scan would return false → "flash".
      logbook: [],
      // Map index HAS history at this climb+angle → should resolve to "send".
      logbookByClimbAngle: new Map<string, LogbookEntry[]>([[logbookClimbAngleKey(CLIMB_UUID, ANGLE), [tick]]]),
      fetchedLogbookClimbUuids: new Set([CLIMB_UUID]),
      getLogbook: vi.fn(),
    };

    const { container } = renderForm();

    // deriveAscentType(true, 1) === 'send'. The array scan would have said flash.
    expect(container.querySelector('[data-testid="ascent-type"]')?.textContent).toBe('send');
    expect(saveLabel(container)).toBe('playView.tickBar.sendSaveLabel');
  });

  it('falls back to "send" (history assumed) when there is no board provider', () => {
    boardState.current = null;
    const { container } = renderForm();

    expect(saveLabel(container)).toBe('playView.tickBar.sendSaveLabel');
  });

  // #3940: an empty index means "no ticks" only once the fetch has landed.
  // Before that the answer is unknown, and guessing "no history" offers Flash
  // on a climb the climber may have sent many times — a phantom flash is
  // unrecoverable from the row itself, so the unknown state must read as Send.
  it("does not offer Flash while this climb's logbook fetch is still in flight", () => {
    boardState.current = boardWithUnfetchedLogbook();
    const { container } = renderForm();

    expect(saveLabel(container)).toBe('playView.tickBar.sendSaveLabel');
  });

  it('saves a send, not a flash, when tapped before the fetch resolves', () => {
    boardState.current = boardWithUnfetchedLogbook();
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ status: 'send' });
  });

  it('offers Flash once the fetch lands and confirms no history', () => {
    boardState.current = boardWithoutHistory();
    const { container } = renderForm();

    expect(saveLabel(container)).toBe('playView.tickBar.flashSaveLabel');
  });
});

describe('useQuickTickForm climbedAt', () => {
  it('threads the picked climb date into saveTick instead of always sending now', () => {
    boardState.current = null;
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('climbedat-date'));
    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      climbedAt: '2025-03-15T12:00:00.000Z',
    });
  });

  it('logs a fresh save-time now when the date is left untouched', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T12:00:00.000Z'));
    boardState.current = null;
    const { getByTestId } = renderForm();

    // The sheet stays mounted (PlayDrawer) and time passes without the user
    // touching the date field — the saved timestamp must be save-time now,
    // not the value captured at mount.
    vi.setSystemTime(new Date('2025-03-15T12:10:00.000Z'));

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      climbedAt: '2025-03-15T12:10:00.000Z',
    });
  });

  it('warns through the shared tick catalog when a future pick was pulled back to now', () => {
    boardState.current = null;
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('future-adjusted'));

    expect(toastMock.showToast).toHaveBeenCalledWith('mobile.tick.futureTimeAdjusted', 'warning');
  });
});

describe('useQuickTickForm grade value on Tick Logged', () => {
  it('resolves the picked numeric difficulty id to a human grade label', () => {
    boardState.current = null;
    gradesState.current = [{ difficultyId: 5, name: 'V5' }];
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('grade-select'));
    fireEvent.click(getByTestId('save'));

    expect(track).toHaveBeenCalledWith(
      'Tick Logged',
      expect.objectContaining({ difficulty: 5, grade: 'V5', hasDifficulty: true }),
    );
  });

  it('sends grade: null when no grade was picked', () => {
    boardState.current = null;
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(track).toHaveBeenCalledWith('Tick Logged', expect.objectContaining({ grade: null, difficulty: null }));
  });
});

describe('useQuickTickForm dismiss-analytics plumbing (savedRef / fieldSnapshotRef)', () => {
  it('keeps fieldSnapshotRef in sync with the field-completeness state', () => {
    boardState.current = null;
    gradesState.current = [{ difficultyId: 5, name: 'V5' }];
    const fieldSnapshotRef: { current: QuickTickDismissSnapshot } = {
      current: { hasQuality: false, hasDifficulty: false, hasComment: false, attemptCountChanged: false },
    };
    const { getByTestId } = renderForm({ fieldSnapshotRef });

    fireEvent.click(getByTestId('grade-select'));

    expect(fieldSnapshotRef.current).toMatchObject({ hasDifficulty: true });
  });

  it('tracks a changed tries count in the dismiss snapshot', () => {
    boardState.current = null;
    const fieldSnapshotRef: { current: QuickTickDismissSnapshot } = {
      current: { hasQuality: false, hasDifficulty: false, hasComment: false, attemptCountChanged: false },
    };
    const { getByTestId } = renderForm({ fieldSnapshotRef });

    expect(fieldSnapshotRef.current.attemptCountChanged).toBe(false);
    fireEvent.click(getByTestId('tries-increment'));

    expect(fieldSnapshotRef.current.attemptCountChanged).toBe(true);
  });

  it('sets savedRef to true right before calling onDismiss on a successful save', () => {
    boardState.current = null;
    const savedRef: { current: boolean } = { current: false };
    const onDismiss = vi.fn(() => {
      // Assert inside the callback so we prove the flag was already flipped
      // by the time the sheet is told to close (ordering matters — the
      // wrapping close handler in LogAscentSheet reads this synchronously).
      expect(savedRef.current).toBe(true);
    });
    const { getByTestId } = renderForm({ savedRef, onDismiss });

    fireEvent.click(getByTestId('save'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('useQuickTickForm analytics', () => {
  it('fires exactly one event per committed tick — the canonical TickLogged', () => {
    boardState.current = null;
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(track).toHaveBeenCalledWith(
      SHARED_EVENTS.TickLogged,
      expect.objectContaining({ climbUuid: CLIMB_UUID, platform: 'mobile', surface: 'mobile_quick_tick' }),
    );
    // The old Tick Button Clicked (save-intent) and Quick Tick Saved
    // (same onSuccess as TickLogged) companions are gone.
    expect(vi.mocked(track).mock.calls.map(([eventName]) => eventName)).toEqual(['Tick Logged']);
  });
});

// The failed save prints its reason in the action bar's reserved error slot
// instead of a toast the sheet covers — so the message has to survive on the
// form until the next attempt clears it.
describe('useQuickTickForm save errors', () => {
  it('surfaces the mutation error message and clears it on the next attempt', () => {
    boardState.current = null;
    saveMock.state.failure = new Error('Board is offline');
    const { container, getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));
    expect(container.querySelector('[data-testid="last-error"]')?.textContent).toBe('Board is offline');
    expect(track).toHaveBeenCalledWith('Quick Tick Failed', expect.objectContaining({ climbUuid: CLIMB_UUID }));

    saveMock.state.failure = null;
    fireEvent.click(getByTestId('save'));
    expect(container.querySelector('[data-testid="last-error"]')?.textContent).toBe('');
  });

  it('falls back to the catalog message when the failure carries none', () => {
    boardState.current = null;
    saveMock.state.failure = new Error('');
    const { container, getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(container.querySelector('[data-testid="last-error"]')?.textContent).toBe('mobile.logAscent.errorMessage');
  });

  // Issue #4315. A save that fails offline has already exhausted the local write,
  // the retry ladder and the outbox degrade. The network error's own message is a
  // technical, English-only string, so say what happened in the climber's language.
  it('shows the localized offline message when the save fails while offline', () => {
    boardState.current = null;
    connectivityState.isOffline = true;
    saveMock.state.failure = new Error('Network request failed');
    const { container, getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(container.querySelector('[data-testid="last-error"]')?.textContent).toBe(
      'mobile.logAscent.offlineErrorMessage',
    );
  });

  it('still surfaces the error own message when online, where it is worth reading', () => {
    boardState.current = null;
    connectivityState.isOffline = false;
    saveMock.state.failure = new Error('Climb not found');
    const { container, getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(container.querySelector('[data-testid="last-error"]')?.textContent).toBe('Climb not found');
  });
});

// Issue #2888. The tries control and the save path must always agree: the
// number the climber can see is the number that reaches their logbook. These
// assert the SAVED value against the value read back out of the form, never
// against a literal, so they stay honest if the form's defaults move.
describe('useQuickTickForm tries count', () => {
  it('saves the single try it is showing when a redpoint goes first go this session', () => {
    boardState.current = boardWithHistory();
    const { container, getByTestId } = renderForm();

    // Prior history, untouched control: one try, and the primary action offers a
    // Send (not a Flash) because the climber has been on this climb before.
    const shownTries = displayedTries(container);
    expect(shownTries).toBe(1);
    expect(saveLabel(container)).toBe('playView.tickBar.sendSaveLabel');

    fireEvent.click(getByTestId('save'));

    // Read the shown count BEFORE the click — a successful save resets the
    // form, so the control is back at its default by the time this runs.
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      status: 'send',
      attemptCount: shownTries,
    });
    // The try the climber never made. Before the fix this stored 2.
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ attemptCount: 1 });
  });

  it('reports the shown count to analytics, not a rewritten one', () => {
    boardState.current = boardWithHistory();
    const { getByTestId } = renderForm();

    fireEvent.click(getByTestId('save'));

    expect(track).toHaveBeenCalledWith(
      SHARED_EVENTS.TickLogged,
      expect.objectContaining({ status: 'send', attemptCount: 1 }),
    );
  });

  it('makes the first tries bump change what gets stored', () => {
    // Before the fix, 1 and 2 both saved as 2, so the first bump moved the
    // display and nothing else.
    boardState.current = boardWithHistory();
    const { container, getByTestId } = renderForm();

    fireEvent.click(getByTestId('tries-increment'));
    const shownTries = displayedTries(container);
    expect(shownTries).toBe(2);

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ attemptCount: shownTries });
  });

  it('saves the shown count when the climber logs an attempt instead of an ascent', () => {
    boardState.current = boardWithHistory();
    const { container, getByTestId } = renderForm();

    fireEvent.click(getByTestId('tries-increment'));
    fireEvent.click(getByTestId('tries-increment'));
    const shownTries = displayedTries(container);
    expect(shownTries).toBe(3);

    fireEvent.click(getByTestId('attempt'));

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      status: 'attempt',
      attemptCount: shownTries,
    });
  });

  it('lets a climber walk back down to Flash after over-counting their tries', () => {
    // The old floor made Send a one-way door: bump a first-ever go to 2 tries
    // and the control locked at 2, so an accidental tap cost you the flash. The
    // round trip is safe because the primary label follows the count in view —
    // the climber sees it go Flash → Send → Flash.
    boardState.current = boardWithoutHistory();
    const { container, getByTestId } = renderForm();

    expect(displayedTries(container)).toBe(1);
    expect(saveLabel(container)).toBe('playView.tickBar.flashSaveLabel');

    fireEvent.click(getByTestId('tries-increment'));
    expect(displayedTries(container)).toBe(2);
    expect(saveLabel(container)).toBe('playView.tickBar.sendSaveLabel');

    // The floor the old code raised to 2 the moment the label flipped to Send.
    expect((getByTestId('tries-decrement') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByTestId('tries-decrement'));

    expect(displayedTries(container)).toBe(1);
    expect(saveLabel(container)).toBe('playView.tickBar.flashSaveLabel');

    fireEvent.click(getByTestId('save'));
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ status: 'flash', attemptCount: 1 });
  });
});

describe('useQuickTickForm board attribution', () => {
  // The wall the climber picked, and the config the drawer sends for a climb
  // that lives on it. Set ids are stored in a different ORDER than the tick
  // sends them, which is the same wall — the comparison has to normalise, the
  // way the server's own config gate does.
  const SELECTED_BOARD = {
    uuid: 'board-uuid-tranquility',
    boardType: 'moonboard',
    layoutId: 6,
    sizeId: 1,
    setIds: '27,24,26,25',
  };
  const TICK_CONFIG = { layoutId: 6, sizeId: 1, setIds: '24,25,26,27' };

  it("sends the selected board's uuid when the tick is on that wall", () => {
    // Without this the tick carries only the config and the presence board id,
    // and a serial-less wall's presence id is the shared per-config feed — so
    // the tick lands on the global feed and the climber's own board reads as
    // empty on Home (#5121).
    boardState.current = boardWithoutHistory();
    activeBoardState.current = SELECTED_BOARD;
    const { getByTestId } = renderForm({ boardName: 'moonboard', ...TICK_CONFIG });

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ boardUuid: SELECTED_BOARD.uuid });
  });

  it('omits the uuid when the drawer resolved a different board to render', () => {
    // A climb that needs holds this wall hasn't got renders against another
    // board, and the tick carries THAT config. The server drops a boardUuid
    // whose config disagrees without falling back (#4219), so sending it here
    // would leave the tick with no board at all.
    boardState.current = boardWithoutHistory();
    activeBoardState.current = SELECTED_BOARD;
    const { getByTestId } = renderForm({ boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' });

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).not.toHaveProperty('boardUuid');
  });

  it('omits the uuid when no board is selected', () => {
    boardState.current = boardWithoutHistory();
    activeBoardState.current = null;
    const { getByTestId } = renderForm({ boardName: 'moonboard', ...TICK_CONFIG });

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).not.toHaveProperty('boardUuid');
  });

  it('omits the uuid when the drawer sent no config to check it against', () => {
    boardState.current = boardWithoutHistory();
    activeBoardState.current = SELECTED_BOARD;
    const { getByTestId } = renderForm({ boardName: 'moonboard' });

    fireEvent.click(getByTestId('save'));

    expect(saveMock.mutate.mock.calls[0][0]).not.toHaveProperty('boardUuid');
  });
});
