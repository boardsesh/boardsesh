// @vitest-environment jsdom
// The workout runner over the player's board (#6291): the rest card while a
// timed block rests, Skip rest moving the wall once and only for the phone that
// moves it, Go now, and the modal "Workout done" card, one card for every
// player that shows it. Real runner hook, real rest-timer, workout-run and
// done-card stores; the queue and the chrome are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef, Fragment, type ReactNode } from 'react';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';

type TestQueueItem = { uuid: string; climb: { uuid: string; name: string } };
const queueState = vi.hoisted(() => ({
  queue: [] as TestQueueItem[],
  currentClimbQueueItem: null as TestQueueItem | null,
  dataReads: 0,
}));
const queueListeners = vi.hoisted(() => new Set<() => void>());
const nextClimb = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/queue-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    queueListeners.add(listener);
    return () => queueListeners.delete(listener);
  };
  return {
    useQueueSessionId: () => ({ sessionId: 'session-1' }),
    useQueueData: () => {
      queueState.dataReads += 1;
      const queue = useSyncExternalStore(subscribe, () => queueState.queue);
      const currentClimbQueueItem = useSyncExternalStore(subscribe, () => queueState.currentClimbQueueItem);
      return { queue, currentClimbQueueItem };
    },
    usePlaylistSuggestionSource: () => null,
    useQueueActions: () => ({
      nextClimb,
      getQueueSnapshot: () => ({
        queue: queueState.queue,
        currentClimbQueueItem: queueState.currentClimbQueueItem,
        playlistSuggestionSource: null,
      }),
    }),
  };
});
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V5', color: '#000000' }) }),
}));
// Solo by default: this phone moves its own wall.
const timerDriver = vi.hoisted(() => ({
  canAdvanceQueue: true,
  role: 'solo' as 'solo' | 'holder' | 'passenger' | 'unheld',
  pacerDisplayName: null as string | null,
}));
vi.mock('../../../hooks/use-session-timer-driver', () => ({ useSessionTimerDriver: () => timerDriver }));
// No crew clock by default: the effective pacing is the stage's, as
// `resolveEffectiveRestPacing` gives it. A test sets `crewPacing` for a crew
// clock, which wins over the stage there too. The overlay re-renders on every
// rest-timer store change, so a plain read at render is enough here.
const crewClock = vi.hoisted(() => ({
  pacing: null as { mode: 'afterTick' | 'onTheMinute'; advanceOn: 'deadline' | 'tick' | 'send' } | null,
}));
vi.mock('../../../hooks/use-effective-rest-pacing', async () => {
  const store = await import('../../../lib/rest-timer-store');
  const effectivePacing = () => {
    if (crewClock.pacing) return crewClock.pacing;
    const stagePacing = store.getRestTimerState().stagePacing;
    return { mode: stagePacing?.mode ?? 'afterTick', advanceOn: stagePacing?.advanceOn ?? 'deadline' };
  };
  return { useEffectiveRestPacing: effectivePacing, getEffectiveRestPacing: effectivePacing };
});
// The live clock is its own leaf; here it only has to show where it sits. A
// test runs the rest out with `setRestDisplayPhase`, which re-renders the
// display's readers as the real 1 Hz ticker would.
const restDisplay = vi.hoisted(() => ({
  phase: 'running' as 'running' | 'exceeded',
  listeners: new Set<() => void>(),
}));
function setRestDisplayPhase(phase: 'running' | 'exceeded'): void {
  restDisplay.phase = phase;
  for (const listener of restDisplay.listeners) listener();
}
vi.mock('../../queue-control/RestTimerPill', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    restDisplay.listeners.add(listener);
    return () => restDisplay.listeners.delete(listener);
  };
  return {
    RestTimerClock: () => createElement('span', { 'data-testid': 'rest-clock' }, 'clock'),
    useRestTimerDisplay: () => ({
      phase: useSyncExternalStore(subscribe, () => restDisplay.phase),
      displayLabel: '2:58',
      targetLabel: '3m',
      remainingSeconds: 178,
    }),
    restTimerClockAccessibilityLabel: () => 'countdownAria',
  };
});

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

const backHandlers = vi.hoisted(() => new Set<() => boolean>());
// Yoga does not run here, so a layout test reads the flex contract off the
// resolved style each view forwards (`data-style`), not measured pixels.
type StyleProp = Record<string, unknown> | ReadonlyArray<StyleProp> | false | null | undefined;
const flattenStyle = vi.hoisted(() => {
  const flatten = (style: unknown): Record<string, unknown> => {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style as Record<string, unknown>;
  };
  return flatten;
});
type ViewMockProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityViewIsModal?: boolean;
  pointerEvents?: string;
  style?: StyleProp;
};
vi.mock('react-native', () => ({
  View: forwardRef<HTMLDivElement, ViewMockProps>(
    ({ children, testID, accessibilityLabel, accessibilityViewIsModal, pointerEvents, style }, ref) =>
      createElement(
        'div',
        {
          ref,
          'data-testid': testID,
          'aria-label': accessibilityLabel,
          'data-modal': accessibilityViewIsModal ? 'true' : undefined,
          'data-pointer-events': pointerEvents,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHandlers.add(handler);
      return { remove: () => backHandlers.delete(handler) };
    },
  },
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, style }: { children?: ReactNode; style?: StyleProp }) =>
      createElement('div', { 'data-style': JSON.stringify(flattenStyle(style)) }, children),
  },
  FadeIn: { duration: () => ({}) },
  useReducedMotion: () => true,
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ onPress, testID }: { onPress?: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../use-announce-body-focus', () => ({ useAnnounceBodyFocus: () => {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { elevatedSurface: '#FFF', separator: '#CCC', label: '#111', secondaryLabel: '#666' },
    brandColors: { primary: '#6D28D9' },
    m3SurfaceContainers: { high: '#EEE' },
    materialElevation: { level2: {} },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { lg: 12 },
  overlays: { scrim: 'rgba(0,0,0,0.4)' },
  shadows: { md: {} },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));
// The key's last segment and its values, so a test reads which line and what it named.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      const name = key.split('.').at(-1) ?? key;
      return options ? `${name}(${Object.values(options).join(',')})` : name;
    },
  }),
}));

import {
  countWorkoutRunTicks,
  getWorkoutRunLog,
  noteWorkoutRunTick,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../../../lib/workout-run-store';
import {
  applyRestTimerStagePacing,
  armRestTimer,
  getRestTimerState,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import {
  resolveStageRestPacing,
  type RestTimerPacingTransition,
  type RestTimerTickStatus,
} from '../../../lib/rest-timer-pacing';
import { resetWorkoutDoneCardStoreForTests } from '../../../lib/workout-done-card-store';
import { WorkoutRunnerOverlay } from '../WorkoutRunnerOverlay';

// A 4x4 of two sets (2 reps each, 0:45 between reps, 3:00 between sets), then
// two limit climbs and two climbs on the minute.
const run: WorkoutRun = {
  stages: [
    {
      id: 'four',
      kind: 'fourByFour',
      itemUuids: ['a', 'b'],
      pacing: {
        mode: 'afterTick',
        restSeconds: 45,
        advanceOn: 'set',
        sets: { repsPerSet: 2, restBetweenSetsSeconds: 180 },
      },
    },
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: ['l1', 'l2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
    { id: 'emom', kind: 'onTheMinute', itemUuids: ['o1', 'o2'], pacing: { mode: 'onTheMinute', restSeconds: 60 } },
  ],
};
const QUEUE = ['a', 'b', 'l1', 'l2', 'o1', 'o2'];
const item = (uuid: string): TestQueueItem => ({ uuid, climb: { uuid: `climb-${uuid}`, name: `Climb ${uuid}` } });

function notifyQueue(): void {
  for (const listener of queueListeners) listener();
}

/** The stage pacing RestTimerPacingSync would store for `uuid`, counting its reps from the tick log. */
function syncStagePacing(uuid: string, transition: RestTimerPacingTransition = 'none'): void {
  applyRestTimerStagePacing(
    resolveStageRestPacing({
      sessionId: 'session-1',
      run,
      position: locateInRun(run, uuid, QUEUE),
      queueItemUuid: uuid,
      repsLogged: countWorkoutRunTicks(getWorkoutRunLog('session-1'), uuid),
    }),
    1000,
    transition,
  );
}

/**
 * A solo swipe to `uuid`: it goes on the wall, and RestTimerPacingSync plans
 * `waitForTick` for a tick or send stage's new climb on the wall
 * (`planRestTimerPacingTransition`), so the rest running goes with the move.
 */
function swipeSoloTo(uuid: string): void {
  queueState.currentClimbQueueItem = queueState.queue.find((queued) => queued.uuid === uuid) ?? null;
  syncStagePacing(uuid, 'waitForTick');
  notifyQueue();
}

/** Put `uuid` on the wall, as the queue and RestTimerPacingSync would. */
function onTheWall(uuid: string): void {
  queueState.queue = QUEUE.map(item);
  queueState.currentClimbQueueItem = queueState.queue.find((queued) => queued.uuid === uuid) ?? null;
  syncStagePacing(uuid);
  notifyQueue();
}

/** A go on the climb on the wall, as the tick path records it, and the sync after it. */
function logGo(uuid: string, status: RestTimerTickStatus): void {
  const climbedAtMs = Date.now();
  const climbedAt = new Date(climbedAtMs).toISOString();
  noteRestTimerTick(climbedAt, getRestTimerState().stagePacing?.mode ?? 'afterTick', climbedAtMs, {
    status,
    queueItemUuid: uuid,
  });
  noteWorkoutRunTick('session-1', { queueItemUuid: uuid, status, climbedAt });
  syncStagePacing(uuid);
}

function renderOverlay(overrides: { run?: WorkoutRun | null; displayed?: string | null; suppressed?: boolean } = {}) {
  const onSeeWorkout = vi.fn();
  const props = {
    sessionId: 'session-1',
    run: overrides.run === undefined ? run : overrides.run,
    displayedQueueItemUuid:
      overrides.displayed === undefined ? (queueState.currentClimbQueueItem?.uuid ?? null) : overrides.displayed,
    boardName: 'kilter',
    suppressed: overrides.suppressed ?? false,
    onSeeWorkout,
  };
  const view = render(createElement(WorkoutRunnerOverlay, props));
  const rerender = (next: Partial<typeof props>) =>
    view.rerender(createElement(WorkoutRunnerOverlay, { ...props, ...next }));
  return { ...view, onSeeWorkout, rerender };
}

const caption = () => screen.getByTestId('workout-rest-card-caption').textContent;
const styleOf = (element: Element | null): Record<string, unknown> =>
  JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
const summaryLabel = () => screen.getByTestId('workout-rest-card-summary').getAttribute('aria-label');

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  resetRestTimerStoreForTests();
  resetWorkoutDoneCardStoreForTests();
  queueListeners.clear();
  nextClimb.mockClear();
  backHandlers.clear();
  queueState.dataReads = 0;
  crewClock.pacing = null;
  restDisplay.phase = 'running';
  restDisplay.listeners.clear();
  Object.assign(timerDriver, { canAdvanceQueue: true, role: 'solo', pacerDisplayName: null });
  setWorkoutRun('session-1', run);
  armRestTimer('afterTick', Date.now(), 'session-1');
  onTheWall('a');
});

describe('WorkoutRunnerOverlay', () => {
  it('renders nothing and reads nothing without a workout on this phone (a crewmate without the run)', () => {
    const { container } = renderOverlay({ run: null });

    expect(container.textContent).toBe('');
    expect(queueState.dataReads).toBe(0);
  });

  it('shows nothing while the climber is on the climb, before a go', () => {
    const { container } = renderOverlay();
    expect(container.textContent).toBe('');
  });

  it('rests between reps on the same climb, says the next rep (reps first), and Go now hides it until the next go', () => {
    renderOverlay();

    act(() => logGo('a', 'attempt'));
    expect(caption()).toBe('restCardThenRep(2,2,1,2)');
    expect(summaryLabel()).toBe('restLabel. countdownAria. restCardThenRepAccessibilityLabel(2,2,1,2)');
    expect(screen.queryByTestId('workout-rest-card-skip')).toBeNull();
    // Non-modal: the region around the card lets every touch through to the board.
    expect(screen.getByTestId('workout-rest-card').getAttribute('data-pointer-events')).toBe('box-none');
    expect(screen.getByTestId('workout-rest-card').getAttribute('data-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('workout-rest-card-go-now'));
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();
    expect(nextClimb).not.toHaveBeenCalled();

    // The set's last rep is a new rest: its card comes back.
    act(() => logGo('a', 'send'));
    expect(screen.getByTestId('workout-rest-card')).toBeTruthy();
  });

  it('sizes the summary by its own text, so the button drops under it rather than squeeze the name', () => {
    renderOverlay();
    act(() => logGo('a', 'attempt'));

    const region = screen.getByTestId('workout-rest-card');
    const card = styleOf(region.firstElementChild);
    const summary = styleOf(screen.getByTestId('workout-rest-card-summary'));
    // The row wraps, and a line breaks on each item's base size: with none set,
    // the summary's is its longest line unwrapped. Large text on a 375 pt phone
    // makes that too wide to sit beside the button, which then takes a line of
    // its own. A fixed basis (180) kept it beside, and the caption broke mid-phrase.
    expect(card).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(summary.flexBasis).toBeUndefined();
    expect(summary.flex).toBeUndefined();
    expect(summary).toMatchObject({ flexGrow: 1, flexShrink: 1 });
  });

  it("after a set's last rep names the next climb, and Skip rest moves the wall exactly once", () => {
    renderOverlay();
    act(() => logGo('a', 'attempt'));
    act(() => logGo('a', 'send'));

    expect(screen.getByText('restCardSetDone(1)')).toBeTruthy();
    expect(caption()).toBe('restCardNextClimb(Climb b,V5)');
    // One sentence to a screen reader: what this rest is, the clock, what comes
    // next, in the spoken line (a comma, not the visible "·").
    expect(summaryLabel()).toBe('restCardSetDone(1). countdownAria. restCardNextClimbAccessibilityLabel(Climb b,V5)');

    const skip = screen.getByTestId('workout-rest-card-skip');
    act(() => {
      fireEvent.click(skip);
      // A second tap before the wall has moved.
      fireEvent.click(skip);
    });

    expect(nextClimb).toHaveBeenCalledTimes(1);
    // The rest is over: the card goes, and the next climb rests only once logged.
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();
    expect(getRestTimerState().anchorMs).toBeNull();
  });

  it('skips a paused rest too: the wall moves once and the timer runs again, nothing frozen from the old rest', () => {
    renderOverlay();
    act(() => logGo('a', 'attempt'));
    act(() => logGo('a', 'send'));
    act(() => pauseRestTimer(Date.now()));
    expect(screen.getByText('timerPausedLabel')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId('workout-rest-card-skip'));
    });

    expect(nextClimb).toHaveBeenCalledTimes(1);
    // The next climb waits for its first log, as after a rest that ran out.
    expect(getRestTimerState()).toMatchObject({ isRunning: true, pausedElapsedSeconds: 0, anchorMs: null });
  });

  it("at the 4x4's end says the block is done and names the next block", () => {
    onTheWall('b');
    renderOverlay();
    act(() => logGo('b', 'send'));
    act(() => logGo('b', 'send'));

    expect(screen.getByText('restCardStageDone(preGeneratorFourByFour)')).toBeTruthy();
    expect(caption()).toBe('restCardNextStage(preGeneratorLimitBouldering)');
    expect(screen.getByTestId('workout-rest-card-skip')).toBeTruthy();
    expect(summaryLabel()).toBe(
      'restCardStageDoneAccessibilityLabel(preGeneratorFourByFour). countdownAria. restCardNextStage(preGeneratorLimitBouldering)',
    );
  });

  it('offers no Skip rest under a crew clock on the minute, where a tap would move nothing', () => {
    // The stage rests after the tick, but this phone follows the crew's clock.
    crewClock.pacing = { mode: 'onTheMinute', advanceOn: 'deadline' };
    renderOverlay();
    act(() => logGo('a', 'attempt'));
    act(() => logGo('a', 'send'));

    expect(screen.getByText('restCardSetDone(1)')).toBeTruthy();
    expect(caption()).toBe('restCardNextClimb(Climb b,V5)');
    expect(screen.queryByTestId('workout-rest-card-skip')).toBeNull();
  });

  it('offers no Skip rest under a crew clock whose rule would not move the wall on this go', () => {
    // Sent once on the set: the stage moves on after the set, but the crew's
    // clock waits for a send and the last go was a fall.
    crewClock.pacing = { mode: 'afterTick', advanceOn: 'send' };
    renderOverlay();
    act(() => logGo('a', 'send'));
    act(() => logGo('a', 'attempt'));

    expect(screen.getByText('restCardSetDone(1)')).toBeTruthy();
    expect(screen.queryByTestId('workout-rest-card-skip')).toBeNull();
  });

  it('after a fall on a limit climb says the next try comes back to it, with no Skip rest', () => {
    onTheWall('l1');
    renderOverlay();
    act(() => logGo('l1', 'attempt'));

    expect(caption()).toBe('restCardThenTryAgain(2)');
    expect(summaryLabel()).toBe('restLabel. countdownAria. restCardThenTryAgainAccessibilityLabel(2)');
    expect(screen.queryByTestId('workout-rest-card-skip')).toBeNull();
    expect(screen.getByTestId('workout-rest-card-go-now')).toBeTruthy();
  });

  it('takes a Go now card away once its rest has run out, and the next go brings the next one', () => {
    onTheWall('l1');
    renderOverlay();
    act(() => logGo('l1', 'attempt'));
    expect(screen.getByTestId('workout-rest-card-go-now')).toBeTruthy();

    // The rest ran out and the climb stays up: the climber is on the next try.
    act(() => setRestDisplayPhase('exceeded'));
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();

    act(() => {
      setRestDisplayPhase('running');
      logGo('l1', 'attempt');
    });
    expect(caption()).toBe('restCardThenTryAgain(3)');
  });

  it('keeps a card that leads off the climb past its rest, until the wall moves', () => {
    Object.assign(timerDriver, { canAdvanceQueue: false, role: 'passenger', pacerDisplayName: 'Sam' });
    onTheWall('l1');
    renderOverlay();
    act(() => logGo('l1', 'send'));

    act(() => setRestDisplayPhase('exceeded'));
    expect(caption()).toBe('autoAdvanceByName(Sam)');
  });

  it('never offers Skip rest on the minute', () => {
    armRestTimer('onTheMinute', Date.now(), 'session-1');
    onTheWall('o1');
    renderOverlay();
    act(() => logGo('o1', 'send'));

    expect(screen.getByText('nextBeatLabel')).toBeTruthy();
    expect(screen.queryByTestId('workout-rest-card-skip')).toBeNull();
  });

  it('on a crew phone that does not hold the wall, says whose phone moves it and offers no Skip rest', () => {
    Object.assign(timerDriver, { canAdvanceQueue: false, role: 'passenger', pacerDisplayName: 'Sam' });
    onTheWall('l1');
    renderOverlay();
    act(() => logGo('l1', 'send'));

    expect(caption()).toBe('autoAdvanceByName(Sam)');
    expect(screen.queryByTestId('workout-rest-card-skip')).toBeNull();
  });

  it('shows nothing for a climb the climber swiped to, or while another card owns the board', () => {
    const { rerender } = renderOverlay();
    act(() => logGo('a', 'attempt'));
    expect(screen.getByTestId('workout-rest-card')).toBeTruthy();

    rerender({ displayedQueueItemUuid: 'b' });
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();

    rerender({ displayedQueueItemUuid: 'a', suppressed: true });
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();

    rerender({ displayedQueueItemUuid: 'a', suppressed: false });
    expect(screen.getByTestId('workout-rest-card')).toBeTruthy();
  });

  it('loses the rest when a solo swipe moves the wall, so swiping back shows no card until the next go', () => {
    renderOverlay();
    act(() => logGo('a', 'attempt'));
    expect(screen.getByTestId('workout-rest-card')).toBeTruthy();

    // Solo, a swipe lights the climb (unlike a crew's preview): the rest ends, as on Next.
    act(() => swipeSoloTo('b'));
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();
    act(() => swipeSoloTo('a'));
    expect(screen.queryByTestId('workout-rest-card')).toBeNull();
    expect(getRestTimerState().anchorMs).toBeNull();

    // The rep still counts, and the next go on the climb starts a rest of its own.
    act(() => logGo('a', 'send'));
    expect(screen.getByText('restCardSetDone(1)')).toBeTruthy();
  });

  describe('Workout done', () => {
    // Just the 4x4: two sets, a then b, with nothing queued after them.
    const lastBlockRun: WorkoutRun = { stages: [run.stages[0]] };

    function onTheLastSet(): void {
      setWorkoutRun('session-1', lastBlockRun);
      onTheWall('b');
      queueState.queue = [item('a'), item('b')];
      notifyQueue();
    }

    it('opens when the workout finishes while the player is up, with what it came to, and closes on Done', () => {
      onTheLastSet();
      noteWorkoutRunTick('session-1', { queueItemUuid: 'a', status: 'send', climbedAt: new Date().toISOString() });
      const { onSeeWorkout } = renderOverlay({ run: lastBlockRun });
      expect(screen.queryByTestId('workout-done-card')).toBeNull();

      // The set's first rep: still climbing it.
      act(() => logGo('b', 'attempt'));
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
      // Its last rep finishes the workout.
      act(() => logGo('b', 'send'));

      const card = screen.getByTestId('workout-done-card');
      expect(card.getAttribute('data-modal')).toBe('true');
      expect(screen.getByTestId('workout-done-card-stats').textContent).toBe(
        '2doneStatSent0doneStatTried0doneStatSkipped',
      );
      expect(screen.queryByTestId('workout-rest-card')).toBeNull();

      fireEvent.click(screen.getByTestId('workout-done-card-done'));
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
      expect(onSeeWorkout).not.toHaveBeenCalled();
    });

    it('closes on See your workout before leaving, so a pane that stays up has no card left', () => {
      onTheLastSet();
      // The tablet pane: nothing to dismiss, so the push runs at once and the
      // overlay stays mounted beside the Record tab.
      const { onSeeWorkout } = renderOverlay({ run: lastBlockRun });
      act(() => logGo('b', 'send'));
      act(() => logGo('b', 'send'));

      fireEvent.click(screen.getByTestId('workout-done-card-see-workout'));

      expect(onSeeWorkout).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
      expect(backHandlers.size).toBe(0);
    });

    it('is one card for every player that shows it: closed on one, closed on all, and never reopened', () => {
      onTheLastSet();
      // Two tablet panes (two tabs), each with its own overlay on the same wall.
      const pane = (key: string) =>
        createElement(WorkoutRunnerOverlay, {
          key,
          sessionId: 'session-1',
          run: lastBlockRun,
          displayedQueueItemUuid: 'b',
          boardName: 'kilter',
          suppressed: false,
          onSeeWorkout: () => {},
        });
      render(createElement(Fragment, null, pane('climbs'), pane('record')));
      act(() => logGo('b', 'send'));
      act(() => logGo('b', 'send'));
      expect(screen.getAllByTestId('workout-done-card')).toHaveLength(2);

      fireEvent.click(screen.getAllByTestId('workout-done-card-done')[0]);
      expect(screen.queryAllByTestId('workout-done-card')).toHaveLength(0);

      // A later go on the finished climb, seen by either pane, does not bring it back.
      act(() => logGo('b', 'send'));
      expect(screen.queryAllByTestId('workout-done-card')).toHaveLength(0);
    });

    it('closes with the player: a player opened again on the finished workout shows no card', () => {
      onTheLastSet();
      const { unmount } = renderOverlay({ run: lastBlockRun });
      act(() => logGo('b', 'send'));
      act(() => logGo('b', 'send'));
      expect(screen.getByTestId('workout-done-card')).toBeTruthy();

      // Swiped the player away without Done.
      unmount();
      renderOverlay({ run: lastBlockRun });
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
    });

    it('closes on Android back before the player does, and stays closed', () => {
      onTheLastSet();
      renderOverlay({ run: lastBlockRun });
      act(() => logGo('b', 'send'));
      act(() => logGo('b', 'send'));
      expect(screen.getByTestId('workout-done-card')).toBeTruthy();
      expect(backHandlers.size).toBe(1);

      let handled = false;
      act(() => {
        for (const handler of backHandlers) handled = handler();
      });
      expect(handled).toBe(true);
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
      expect(backHandlers.size).toBe(0);

      // One more go on the finished climb does not bring it back.
      act(() => logGo('b', 'send'));
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
    });

    it('waits on a climb the climber swiped to, and shows on the way back', () => {
      onTheLastSet();
      const { rerender } = renderOverlay({ run: lastBlockRun });
      rerender({ displayedQueueItemUuid: 'a' });
      act(() => logGo('b', 'send'));
      act(() => logGo('b', 'send'));
      expect(screen.queryByTestId('workout-done-card')).toBeNull();

      rerender({ displayedQueueItemUuid: 'b' });
      expect(screen.getByTestId('workout-done-card')).toBeTruthy();
    });

    it('says nothing was logged here, not three zeros, when the last beat ran out unlogged', () => {
      const onTheMinuteRun: WorkoutRun = { stages: [run.stages[2]] };
      setWorkoutRun('session-1', onTheMinuteRun);
      armRestTimer('onTheMinute', Date.now(), 'session-1');
      onTheWall('o2');
      queueState.queue = [item('o1'), item('o2')];
      notifyQueue();
      renderOverlay({ run: onTheMinuteRun });
      expect(screen.queryByTestId('workout-done-card')).toBeNull();

      // The beat on the last climb found nothing to move on to.
      act(() => noteRestTimerQueueEnded());

      expect(screen.getByTestId('workout-done-card')).toBeTruthy();
      expect(screen.queryByTestId('workout-done-card-stats')).toBeNull();
      expect(screen.getByText('doneNothingLogged')).toBeTruthy();
    });

    it('never opens on a player that opened on a workout already done', () => {
      onTheLastSet();
      noteWorkoutRunTick('session-1', { queueItemUuid: 'b', status: 'send', climbedAt: new Date().toISOString() });
      noteWorkoutRunTick('session-1', { queueItemUuid: 'b', status: 'send', climbedAt: new Date().toISOString() });

      renderOverlay({ run: lastBlockRun });
      expect(screen.queryByTestId('workout-done-card')).toBeNull();
    });
  });
});
