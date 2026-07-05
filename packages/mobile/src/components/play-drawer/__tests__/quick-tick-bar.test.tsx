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
vi.mock('../InlineTriesPicker', () => ({ InlineTriesPicker: () => null }));
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
