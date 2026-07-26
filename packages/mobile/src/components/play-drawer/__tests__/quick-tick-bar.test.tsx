// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { logbookClimbAngleKey, type LogbookEntry } from '@boardsesh/board-react';

// QuickTickBar's `hasPriorHistory` decides flash vs send (deriveAscentType).
// It must read the prebuilt O(1) `logbookByClimbAngle` Map, NOT scan the raw
// `logbook` array. We prove this with a board whose `logbook` array is EMPTY
// (an array scan returns false → "flash") while the Map HAS an entry for this
// climb+angle (→ "send"). The save-button label is the observable.

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
// Auto-invokes onSuccess so the QuickTickSaved track call (and the
// savedRef/onDismiss wiring) fires the same way the real mutation would.
const saveMock = vi.hoisted(() => ({
  mutate: vi.fn((_input: unknown, callbacks?: { onSuccess?: () => void; onError?: (error: unknown) => void }) =>
    callbacks?.onSuccess?.(),
  ),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => createElement('button', { 'data-label': accessibilityLabel, onClick: onPress, disabled }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({ BottomSheetTextInput: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../InlineStarPicker', () => ({ InlineStarPicker: () => null }));
// Stub InlineTriesPicker as a faithful miniature of the real one: it RENDERS
// the count it was handed and applies the same `minAttempts` floor on
// decrement. That makes the displayed number readable from the DOM, so the
// tries tests can assert "what the picker showed is what got saved" without
// hardcoding the expected number on the save side (issue #2888).
vi.mock('../InlineTriesPicker', () => ({
  InlineTriesPicker: ({
    attemptCount,
    minAttempts = 1,
    onSelect,
  }: {
    attemptCount: number;
    minAttempts?: number;
    onSelect: (value: number) => void;
  }) =>
    createElement(
      'div',
      null,
      createElement('button', {
        'data-testid': 'tries-decrement',
        disabled: attemptCount <= minAttempts,
        onClick: () => onSelect(Math.max(minAttempts, attemptCount - 1)),
      }),
      createElement('span', { 'data-testid': 'tries-value' }, String(attemptCount)),
      createElement('button', {
        'data-testid': 'tries-increment',
        onClick: () => onSelect(attemptCount + 1),
      }),
    ),
}));
// Stub GradeSingleSelectRail: clicking the rail always selects the first
// loaded grade, so a test can drive grade selection without the real chip UI.
vi.mock('../../grade', () => ({
  GradeSingleSelectRail: ({ onSelect }: { onSelect: (difficultyId: number | undefined) => void }) =>
    createElement('button', {
      'data-testid': 'grade-rail-select',
      onClick: () => onSelect(gradesState.current[0]?.difficultyId),
    }),
}));
// Stub ClimbedAtField: clicking the date button drives a fixed past date, so a
// test can prove the picked value threads into saveTick without the native
// datetimepicker (which doesn't load under jsdom).
vi.mock('../../logbook/ClimbedAtField', () => ({
  ClimbedAtField: ({ mode, onChange }: { mode: 'date' | 'time'; onChange: (next: Date) => void }) =>
    createElement('button', {
      'data-testid': `climbedat-${mode}`,
      onClick: () => onChange(new Date('2025-03-15T12:00:00.000Z')),
    }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: gradesState.current }) }));
// Partial mock: keep the real exports (BOULDER_GRADES et al., pulled in
// transitively via climbed-at.ts → @boardsesh/profile-stats) and override only
// the board-name normaliser.
vi.mock('@boardsesh/board-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-config')>();
  return { ...actual, toBoardName: (name: string) => name };
});
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    TickButtonClicked: 'Tick Button Clicked',
    QuickTickSaved: 'Quick Tick Saved',
    QuickTickFailed: 'Quick Tick Failed',
    TickLogged: 'Tick Logged',
  },
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// QuickTickBar reads board-presence flags; mock the provider so the test doesn't
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
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../theme/colors', () => ({ brandColors: { success: '#047857' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 0 }) }));

// The board provider: an EMPTY logbook array (so an array scan finds nothing)
// plus a populated `logbookByClimbAngle` Map (the correct O(1) index).
vi.mock('@boardsesh/board-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-react')>();
  // QuickTickBar reads `getLogbook` from the stable actions context and the
  // `logbookByClimbAngle` index from the volatile logbook context. The fixture
  // object carries both fields, so both hooks resolve to it.
  return {
    ...actual,
    useOptionalBoardActions: () => boardState.current,
    useOptionalBoardLogbook: () => boardState.current,
    useSaveTick: () => ({ mutate: saveMock.mutate, isPending: false }),
  };
});

import { QuickTickBar, type QuickTickBarProps, type QuickTickDismissSnapshot } from '../QuickTickBar';
import { track } from '../../../lib/analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';

function renderBar(overrides: Partial<QuickTickBarProps> = {}) {
  return render(
    createElement(QuickTickBar, {
      climbUuid: CLIMB_UUID,
      boardName: 'kilter',
      angle: ANGLE,
      isMirror: false,
      isBenchmark: false,
      onDismiss: vi.fn(),
      ...overrides,
    }),
  );
}

/** The number the tries picker is currently showing the climber. */
function displayedTries(container: HTMLElement): number {
  return Number(container.querySelector('[data-testid="tries-value"]')?.textContent);
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((node) => node.textContent === text);
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
  gradesState.current = [];
  vi.mocked(track).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QuickTickBar hasPriorHistory', () => {
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

    const { container } = renderBar();
    const labels = Array.from(container.querySelectorAll('[data-label]')).map((node) =>
      node.getAttribute('data-label'),
    );
    // deriveAscentType(true, 1) === 'send', so the log-ascent button is labelled
    // for a send, not a flash. The array scan would have produced 'flash'.
    expect(labels).toContain('playView.tickBar.logAscentAria');
    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    const flashButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.flashSaveLabel',
    );
    expect(sendButton).toBeTruthy();
    expect(flashButton).toBeUndefined();
  });

  it('falls back to "send" (history assumed) when there is no board provider', () => {
    boardState.current = null;
    const { container } = renderBar();
    const flashButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.flashSaveLabel',
    );
    expect(flashButton).toBeUndefined();
  });

  // #3940: an empty index means "no ticks" only once the fetch has landed.
  // Before that the answer is unknown, and guessing "no history" offers Flash
  // on a climb the climber may have sent many times — a phantom flash is
  // unrecoverable from the row itself, so the unknown state must read as Send.
  it("does not offer Flash while this climb's logbook fetch is still in flight", () => {
    boardState.current = boardWithUnfetchedLogbook();
    const { container } = renderBar();

    const flashButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.flashSaveLabel',
    );
    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    expect(flashButton).toBeUndefined();
    expect(sendButton).toBeTruthy();
  });

  it('saves a send, not a flash, when tapped before the fetch resolves', () => {
    boardState.current = boardWithUnfetchedLogbook();
    const { container } = renderBar();

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ status: 'send' });
  });

  it('offers Flash once the fetch lands and confirms no history', () => {
    boardState.current = boardWithoutHistory();
    const { container } = renderBar();

    const flashButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.flashSaveLabel',
    );
    expect(flashButton).toBeTruthy();
  });
});

describe('QuickTickBar climbedAt', () => {
  it('threads the picked climb date into saveTick instead of always sending now', () => {
    boardState.current = null;
    const { getByTestId, container } = renderBar();

    // Pick a fixed past date via the stubbed ClimbedAtField.
    fireEvent.click(getByTestId('climbedat-date'));

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      climbedAt: '2025-03-15T12:00:00.000Z',
    });
  });

  it('logs a fresh save-time now when the date is left untouched', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T12:00:00.000Z'));
    boardState.current = null;
    const { container } = renderBar();

    // The sheet stays mounted (PlayDrawer) and time passes without the user
    // touching the date field — the saved timestamp must be save-time now,
    // not the value captured at mount.
    vi.setSystemTime(new Date('2025-03-15T12:10:00.000Z'));

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      climbedAt: '2025-03-15T12:10:00.000Z',
    });
  });
});

describe('QuickTickBar grade value on Quick Tick Saved', () => {
  it('resolves the picked numeric difficulty id to a human grade label', () => {
    boardState.current = null;
    gradesState.current = [{ difficultyId: 5, name: 'V5' }];
    const { container, getByTestId } = renderBar();

    fireEvent.click(getByTestId('grade-rail-select'));
    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(track).toHaveBeenCalledWith(
      'Quick Tick Saved',
      expect.objectContaining({ difficulty: 5, grade: 'V5', hasDifficulty: true }),
    );
  });

  it('sends grade: null when no grade was picked', () => {
    boardState.current = null;
    const { container } = renderBar();

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(track).toHaveBeenCalledWith('Quick Tick Saved', expect.objectContaining({ grade: null, difficulty: null }));
  });
});

describe('QuickTickBar dismiss-analytics plumbing (savedRef / fieldSnapshotRef)', () => {
  it('keeps fieldSnapshotRef in sync with the field-completeness state', () => {
    boardState.current = null;
    gradesState.current = [{ difficultyId: 5, name: 'V5' }];
    const fieldSnapshotRef: { current: QuickTickDismissSnapshot } = {
      current: { hasQuality: false, hasDifficulty: false, hasComment: false, attemptCountChanged: false },
    };
    const { getByTestId } = renderBar({ fieldSnapshotRef });

    fireEvent.click(getByTestId('grade-rail-select'));

    expect(fieldSnapshotRef.current).toMatchObject({ hasDifficulty: true });
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
    const { container } = renderBar({ savedRef, onDismiss });

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('QuickTickBar analytics', () => {
  it('fires the canonical TickLogged event alongside QuickTickSaved on a successful save', () => {
    boardState.current = null;
    const { container } = renderBar();

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'playView.tickBar.sendSaveLabel',
    );
    fireEvent.click(sendButton as Element);

    expect(track).toHaveBeenCalledWith(
      SHARED_EVENTS.QuickTickSaved,
      expect.objectContaining({ climbUuid: CLIMB_UUID }),
    );
    expect(track).toHaveBeenCalledWith(
      SHARED_EVENTS.TickLogged,
      expect.objectContaining({ climbUuid: CLIMB_UUID, platform: 'mobile', surface: 'mobile_quick_tick' }),
    );
  });
});

// Issue #2888. The tries picker and the save path must always agree: the
// number the climber can see is the number that reaches their logbook. These
// assert the SAVED value against the value read back out of the picker, never
// against a literal, so they stay honest if the form's defaults move.
describe('QuickTickBar tries count', () => {
  it('saves the single try it is showing when a redpoint goes first go this session', () => {
    boardState.current = boardWithHistory();
    const { container } = renderBar();

    // Prior history, untouched picker: one try, and the button offers a Send
    // (not a Flash) because the climber has been on this climb before.
    const shownTries = displayedTries(container);
    expect(shownTries).toBe(1);
    const sendButton = buttonWithText(container, 'playView.tickBar.sendSaveLabel');
    expect(sendButton).toBeTruthy();

    fireEvent.click(sendButton as Element);

    // Read the shown count BEFORE the click — a successful save resets the
    // form, so the picker is back at its default by the time this runs.
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      status: 'send',
      attemptCount: shownTries,
    });
    // The try the climber never made. Before the fix this stored 2.
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ attemptCount: 1 });
  });

  it('reports the shown count to analytics, not a rewritten one', () => {
    boardState.current = boardWithHistory();
    const { container } = renderBar();

    fireEvent.click(buttonWithText(container, 'playView.tickBar.sendSaveLabel') as Element);

    expect(track).toHaveBeenCalledWith(
      SHARED_EVENTS.QuickTickSaved,
      expect.objectContaining({ status: 'send', attemptCount: 1 }),
    );
  });

  it('keeps the Send label while saving one try — the label and the count are independent', () => {
    // Guards the other half of the fix: dropping the floor must not turn a
    // repeat ascent into a Flash. Prior history means Send at any count.
    boardState.current = boardWithHistory();
    const { container } = renderBar();

    expect(buttonWithText(container, 'playView.tickBar.flashSaveLabel')).toBeUndefined();
    fireEvent.click(buttonWithText(container, 'playView.tickBar.sendSaveLabel') as Element);

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ status: 'send', attemptCount: 1 });
  });

  it('makes the first plus press change what gets stored', () => {
    // Before the fix, 1 and 2 both saved as 2, so the first press of + moved
    // the display and nothing else. (2 saving as 2 passes either way — this
    // earns its keep next to the one-try test above, not on its own.)
    boardState.current = boardWithHistory();
    const { container, getByTestId } = renderBar();

    fireEvent.click(getByTestId('tries-increment'));
    const shownTries = displayedTries(container);
    expect(shownTries).toBe(2);

    fireEvent.click(buttonWithText(container, 'playView.tickBar.sendSaveLabel') as Element);

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ attemptCount: shownTries });
  });

  it('saves the shown count when the climber logs an attempt instead of an ascent', () => {
    boardState.current = boardWithHistory();
    const { container, getByTestId } = renderBar();

    fireEvent.click(getByTestId('tries-increment'));
    fireEvent.click(getByTestId('tries-increment'));
    const shownTries = displayedTries(container);
    expect(shownTries).toBe(3);

    fireEvent.click(buttonWithText(container, 'mobile.logAscent.attempt') as Element);

    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({
      status: 'attempt',
      attemptCount: shownTries,
    });
  });

  it('lets a climber walk back up to Flash after over-counting their tries', () => {
    // The old floor made Send a one-way door: bump a first-ever go to 2 tries
    // and the minus button locked at 2, so an accidental tap cost you the
    // flash. The round trip is safe because the button label follows the count
    // in view — the climber sees it go Flash → Send → Flash.
    boardState.current = boardWithoutHistory();
    const { container, getByTestId } = renderBar();

    expect(displayedTries(container)).toBe(1);
    expect(buttonWithText(container, 'playView.tickBar.flashSaveLabel')).toBeTruthy();

    fireEvent.click(getByTestId('tries-increment'));
    expect(displayedTries(container)).toBe(2);
    expect(buttonWithText(container, 'playView.tickBar.sendSaveLabel')).toBeTruthy();
    expect(buttonWithText(container, 'playView.tickBar.flashSaveLabel')).toBeUndefined();

    // The floor the old code raised to 2 the moment the label flipped to Send,
    // which greyed this button out and stranded the climber on "Send".
    expect((getByTestId('tries-decrement') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByTestId('tries-decrement'));

    expect(displayedTries(container)).toBe(1);
    const flashButton = buttonWithText(container, 'playView.tickBar.flashSaveLabel');
    expect(flashButton).toBeTruthy();

    fireEvent.click(flashButton as Element);
    expect(saveMock.mutate.mock.calls[0][0]).toMatchObject({ status: 'flash', attemptCount: 1 });
  });
});
