// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';

type TestQueueItem = { uuid: string; climb?: { uuid: string; name: string } };
const queueState = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  queue: [] as TestQueueItem[],
  currentClimbQueueItem: null as TestQueueItem | null,
  playlistSuggestionSource: null as null,
}));
const queueActions = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const startWorkout = vi.hoisted(() => vi.fn());
vi.mock('../../../../hooks/use-start-workout', async () => {
  const { useWorkoutRunPendingStart } = await import('../../../../lib/workout-run-store');
  return {
    useStartWorkout: () => ({
      pending: useWorkoutRunPendingStart(queueState.sessionId),
      firstItem: queueState.queue.find((item) => item.uuid === 'w1') ?? null,
      startWorkout,
    }),
  };
});
// A queue item as the runner reads it: every one carries its climb.
const withClimb = vi.hoisted(
  () => (item: { uuid: string; climb?: { uuid: string; name: string } }) =>
    item.climb ? item : { ...item, climb: { uuid: `climb-${item.uuid}`, name: `Climb ${item.uuid}` } },
);
// A queue the card subscribes to like the real context, so a change re-renders it.
const queueListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../../../../providers/queue-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    queueListeners.add(listener);
    return () => queueListeners.delete(listener);
  };
  return {
    useQueueSessionId: () => ({ sessionId: queueState.sessionId }),
    useQueueData: () => {
      const queue = useSyncExternalStore(subscribe, () => queueState.queue);
      const current = queueState.currentClimbQueueItem;
      return { queue, currentClimbQueueItem: current ? withClimb(current) : null };
    },
    usePlaylistSuggestionSource: () => queueState.playlistSuggestionSource,
    useQueueActions: () => queueActions,
  };
});
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));
const drawerHost = vi.hoisted(() => ({ openPlayDrawer: vi.fn(), boardConfig: null }));
vi.mock('../../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => drawerHost }));
vi.mock('../../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V5', color: '#000000' }) }),
}));
// The live clock is its own leaf; here it only has to show where it sits. The
// rest line reads the display for its spoken sentence: 12 s over the rest.
vi.mock('../../../queue-control/RestTimerPill', () => ({
  RestTimerClock: () => createElement('span', { 'data-testid': 'rest-clock' }, 'clock'),
  useRestTimerDisplay: () => ({
    phase: 'exceeded',
    displayLabel: '-0:12',
    targetLabel: '3m',
    remainingSeconds: -12,
  }),
  restTimerClockAccessibilityLabel: ({ remainingSeconds }: { remainingSeconds: number | null }) =>
    `overrunAria:${remainingSeconds}`,
}));
// Solo by default: this phone moves its own wall.
const timerDriver = vi.hoisted(() => ({ canAdvanceQueue: true }));
vi.mock('../../../../hooks/use-session-timer-driver', () => ({ useSessionTimerDriver: () => timerDriver }));
const armRestTimerForWorkout = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/rest-timer-effective', () => ({ armRestTimerForWorkout }));
function setQueue(uuids: string[]): void {
  queueState.queue = queued(uuids);
  for (const listener of queueListeners) listener();
}

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../Card', () => ({
  Card: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('section', { onClick: onPress }, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    testID,
    accessibilityHint,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityHint?: string;
  }) => createElement('button', { onClick: onPress, 'data-testid': testID, 'data-hint': accessibilityHint }, children),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: 'label', secondaryLabel: 'secondaryLabel', tertiaryLabel: 'tertiaryLabel' },
    brandColors: { primary: 'primary', primaryFill: 'primaryFill' },
  }),
}));
// Plural-free interpolation: enough to read which key and count each row shows.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options && 'count' in options ? `${key.split('.').at(-1)}:${options.count}` : (key.split('.').at(-1) ?? key),
  }),
}));

import {
  countWorkoutRunTicks,
  getWorkoutRunLog,
  noteWorkoutRunTick,
  prepareWorkoutRun,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../../../../lib/workout-run-store';
import {
  applyRestTimerStagePacing,
  armRestTimer,
  disarmRestTimer,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../../lib/rest-timer-store';
import { resolveStageRestPacing } from '../../../../lib/rest-timer-pacing';
import { WorkoutRunCard } from '../WorkoutRunCard';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1', 'w2', 'w3'] },
    { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] },
  ],
};
const queued = (uuids: string[]): TestQueueItem[] => uuids.map((uuid) => withClimb({ uuid }));

const rowTexts = () =>
  [...screen.getAllByTestId(/^workout-stage/)].map((row) => `${row.getAttribute('data-testid')}|${row.textContent}`);

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  resetRestTimerStoreForTests();
  queueActions.setCurrentClimb.mockClear();
  drawerHost.openPlayDrawer.mockClear();
  armRestTimerForWorkout.mockClear();
  startWorkout.mockClear();
  timerDriver.canAdvanceQueue = true;
  queueState.playlistSuggestionSource = null;
  queueListeners.clear();
  queueState.sessionId = 'session-1';
  queueState.queue = queued(['w1', 'w2', 'w3', 'm1', 'm2']);
  queueState.currentClimbQueueItem = { uuid: 'w1' };
});

describe('WorkoutRunCard', () => {
  it('offers explicit Start before current-climb and timer controls, including an already selected workout climb', () => {
    prepareWorkoutRun('session-1', run);
    render(createElement(WorkoutRunCard, { onAddBlock: vi.fn() }));

    fireEvent.click(screen.getByTestId('workout-runner-start'));
    expect(startWorkout).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('workout-runner-current')).toBeNull();
    expect(screen.queryByTestId('workout-runner-overall')).toBeNull();
    expect(screen.queryByTestId('workout-runner-rest')).toBeNull();
    expect(screen.queryByTestId('workout-runner-turn-on')).toBeNull();
    expect(screen.queryByTestId('workout-runner-done')).toBeNull();
    expect(rowTexts()).toEqual([
      'workout-stage|preWorkoutSectionWarmUpworkoutStageClimbs:3',
      'workout-stage|preGeneratorVolumeworkoutStageClimbs:2',
    ]);
    expect(screen.getByTestId('workout-add-block')).toBeTruthy();
  });

  it('offers Add a block after every prepared climb leaves the queue', () => {
    prepareWorkoutRun('session-1', run);
    queueState.queue = queued(['hand-queued']);
    const onAddBlock = vi.fn();
    render(createElement(WorkoutRunCard, { onAddBlock }));

    expect(screen.queryByTestId('workout-runner-start')).toBeNull();
    fireEvent.click(screen.getByText('addWorkoutPromptTitle'));
    expect(onAddBlock).toHaveBeenCalledOnce();
  });

  it('renders nothing for a session without a workout', () => {
    const { container } = render(createElement(WorkoutRunCard));
    expect(container.textContent).toBe('');
  });

  it('lists the stages, marks the current one and counts what is left in it', () => {
    setWorkoutRun('session-1', run);
    render(createElement(WorkoutRunCard));

    expect(screen.getByText('workoutCardTitle')).toBeTruthy();
    expect(rowTexts()).toEqual([
      'workout-stage-current|preWorkoutSectionWarmUpworkoutStageToGo:2',
      'workout-stage|preGeneratorVolumeworkoutStageClimbs:2',
    ]);
  });

  it('counts only queued climbs, and a removed climb comes back staged after Undo', () => {
    setWorkoutRun('session-1', run);
    render(createElement(WorkoutRunCard));

    // Bulk-remove two warm-up climbs from the queue sheet.
    act(() => setQueue(['w1', 'm1', 'm2']));
    expect(rowTexts()[0]).toBe('workout-stage-current|preWorkoutSectionWarmUpworkoutStageLastClimb');

    // Undo restores the same uuids: they are warm-up climbs again.
    act(() => setQueue(['w1', 'w2', 'w3', 'm1', 'm2']));
    expect(rowTexts()[0]).toBe('workout-stage-current|preWorkoutSectionWarmUpworkoutStageToGo:2');
  });

  it('hides once none of the workout is left in the queue', () => {
    setWorkoutRun('session-1', run);
    queueState.queue = queued(['hand-queued']);
    queueState.currentClimbQueueItem = { uuid: 'hand-queued' };
    const { container } = render(createElement(WorkoutRunCard));
    expect(container.textContent).toBe('');
  });

  describe('the runner', () => {
    // A 4x4 of two sets (2 reps each, no rest between reps, 3:00 between sets),
    // then one limit climb.
    const timedRun: WorkoutRun = {
      stages: [
        {
          id: 'four',
          kind: 'fourByFour',
          itemUuids: ['a', 'b'],
          pacing: {
            mode: 'afterTick',
            restSeconds: 0,
            advanceOn: 'set',
            sets: { repsPerSet: 2, restBetweenSetsSeconds: 180 },
          },
        },
        {
          id: 'limit',
          kind: 'limitBouldering',
          itemUuids: ['l1'],
          pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
        },
      ],
    };
    const timedQueue = ['a', 'b', 'l1'];

    /** The stage pacing RestTimerPacingSync would store for `uuid`, counting its reps from the tick log. */
    function syncStagePacing(uuid: string, workoutRun: WorkoutRun = timedRun): void {
      const position = locateInRun(workoutRun, uuid, timedQueue);
      const repsLogged = countWorkoutRunTicks(getWorkoutRunLog('session-1'), uuid);
      applyRestTimerStagePacing(
        resolveStageRestPacing({ sessionId: 'session-1', run: workoutRun, position, queueItemUuid: uuid, repsLogged }),
        1000,
        'none',
      );
    }

    /** Put `uuid` on the wall, with the stage pacing RestTimerPacingSync would store for it. */
    function onTheWall(uuid: string, workoutRun: WorkoutRun = timedRun): void {
      queueState.queue = queued(timedQueue);
      queueState.currentClimbQueueItem = { uuid };
      syncStagePacing(uuid, workoutRun);
    }

    /** A tick on the climb on the wall, as the tick path records it, and the sync after it. */
    function logTick(uuid: string, status: 'flash' | 'send' | 'attempt', workoutRun: WorkoutRun = timedRun): void {
      const climbedAt = new Date(5000).toISOString();
      noteRestTimerTick(climbedAt, 'afterTick', 5000, { status, queueItemUuid: uuid });
      noteWorkoutRunTick('session-1', { queueItemUuid: uuid, status, climbedAt });
      syncStagePacing(uuid, workoutRun);
    }

    it('shows the set and rep you are on and the climb on the wall, which opens the player', () => {
      setWorkoutRun('session-1', timedRun);
      onTheWall('b');
      render(createElement(WorkoutRunCard));

      expect(screen.getByText('overallPosition')).toBeTruthy();
      expect(screen.getByTestId('workout-runner-current').textContent).toContain('workoutStageSetPosition');
      expect(screen.getByTestId('workout-runner-current').textContent).toContain('Climb b');
      fireEvent.click(screen.getByTestId('workout-runner-current'));
      expect(drawerHost.openPlayDrawer).toHaveBeenCalledWith({ uuid: 'climb-b', name: 'Climb b' }, {});
    });

    it('offers to turn the rest timer on while a timed block has it off', () => {
      setWorkoutRun('session-1', timedRun);
      onTheWall('a');
      render(createElement(WorkoutRunCard));

      expect(screen.getByTestId('workout-runner-turn-on').getAttribute('data-hint')).toBe('turnOnHint');
      fireEvent.click(screen.getByTestId('workout-runner-turn-on'));
      expect(armRestTimerForWorkout).toHaveBeenCalledWith('session-1', timedRun, expect.any(Number));
      expect(screen.queryByTestId('workout-runner-rest')).toBeNull();
    });

    it('shows no rest between reps with no rest between them, then counts the set rest down and names the next climb', () => {
      setWorkoutRun('session-1', timedRun);
      armRestTimer('afterTick', 1000, 'session-1');
      onTheWall('a');
      queueState.queue = queued(timedQueue);
      render(createElement(WorkoutRunCard));
      expect(screen.queryByTestId('workout-runner-rest')).toBeNull();

      // The first rep: the climber goes again at once, so no clock.
      act(() => logTick('a', 'attempt'));
      expect(screen.queryByTestId('workout-runner-rest')).toBeNull();

      // The set's last rep: the set rest, then the next climb.
      act(() => logTick('a', 'send'));
      const restLine = screen.getByTestId('workout-runner-rest');
      expect(restLine.textContent).toBe('setRestLabelclockthenNext');
      // One sentence to a screen reader, the overrun in words rather than signed digits.
      expect(restLine.getAttribute('aria-label')).toBe('setRestLabel. overrunAria:-12. thenNext');
      expect(screen.queryByTestId('workout-runner-turn-on')).toBeNull();

      // Turning the timer off brings the offer back and stops the clock.
      act(() => disarmRestTimer());
      expect(screen.queryByTestId('workout-runner-rest')).toBeNull();
      expect(screen.getByTestId('workout-runner-turn-on')).toBeTruthy();
    });

    it('rests between reps when the set has a rest between them, and says the next rep comes back to the climb', () => {
      const repRestRun: WorkoutRun = {
        stages: [
          {
            id: 'four',
            kind: 'fourByFour',
            itemUuids: ['a', 'b'],
            pacing: {
              mode: 'afterTick',
              restSeconds: 45,
              advanceOn: 'set',
              sets: { repsPerSet: 3, restBetweenSetsSeconds: 180 },
            },
          },
        ],
      };
      setWorkoutRun('session-1', repRestRun);
      armRestTimer('afterTick', 1000, 'session-1');
      onTheWall('a', repRestRun);
      render(createElement(WorkoutRunCard));

      act(() => logTick('a', 'send', repRestRun));
      expect(screen.getByTestId('workout-runner-rest').textContent).toBe('restLabelclockthenRep');
    });

    it('rests a limit climb after a fall and says the next try comes back to it', () => {
      setWorkoutRun('session-1', timedRun);
      armRestTimer('afterTick', 1000, 'session-1');
      onTheWall('l1');
      render(createElement(WorkoutRunCard));
      expect(screen.getByTestId('workout-runner-current').textContent).toContain('positionWithTry');

      act(() => logTick('l1', 'attempt'));
      expect(screen.getByTestId('workout-runner-rest').textContent).toBe('restLabelclockthenTryAgain');
    });

    it('never promises the next climb on a crew phone that does not hold the wall', () => {
      timerDriver.canAdvanceQueue = false;
      setWorkoutRun('session-1', timedRun);
      onTheWall('b');
      render(createElement(WorkoutRunCard));
      expect(screen.getByTestId('workout-runner-turn-on').getAttribute('data-hint')).toBe('turnOnPassengerHint');

      act(() => armRestTimer('afterTick', 1000, 'session-1'));
      act(() => logTick('b', 'attempt'));
      act(() => logTick('b', 'send'));
      expect(screen.getByTestId('workout-runner-rest').textContent).toBe('setRestLabelclockautoAdvanceBlocked');
    });

    it('says what each finished block came to, and keeps the climb count for one with nothing logged', () => {
      setWorkoutRun('session-1', run);
      queueState.queue = queued(['w1', 'w2', 'w3', 'm1', 'm2']);
      queueState.currentClimbQueueItem = { uuid: 'm1' };
      noteWorkoutRunTick('session-1', { queueItemUuid: 'w1', status: 'send', climbedAt: '2026-10-24T12:00:00.000Z' });
      noteWorkoutRunTick('session-1', {
        queueItemUuid: 'w2',
        status: 'attempt',
        climbedAt: '2026-10-24T12:01:00.000Z',
      });
      render(createElement(WorkoutRunCard));

      expect(rowTexts()).toEqual([
        'workout-stage|preWorkoutSectionWarmUptallySent:1 · tallyTried:1 · tallySkipped:1',
        'workout-stage-current|preGeneratorVolumeworkoutStageToGo:1',
      ]);
    });

    it('finishes with the totals of the blocks logged here once the last climb is logged, and Add a block stays', () => {
      setWorkoutRun('session-1', run);
      queueState.queue = queued(['w1', 'w2', 'w3', 'm1', 'm2']);
      queueState.currentClimbQueueItem = { uuid: 'm2' };
      noteWorkoutRunTick('session-1', { queueItemUuid: 'm1', status: 'flash', climbedAt: '2026-10-24T12:00:00.000Z' });
      noteWorkoutRunTick('session-1', { queueItemUuid: 'm2', status: 'send', climbedAt: '2026-10-24T12:01:00.000Z' });
      render(createElement(WorkoutRunCard, { onAddBlock: vi.fn() }));

      // The warm-up has nothing logged on this phone, so it keeps its climb count
      // and adds nothing to the totals: it may have been logged on another phone.
      expect(screen.getByTestId('workout-runner-done').textContent).toBe('donetallySent:2');
      expect(rowTexts()[0]).toBe('workout-stage|preWorkoutSectionWarmUpworkoutStageClimbs:3');
      expect(screen.queryByTestId('workout-runner-current')).toBeNull();
      expect(screen.queryByText('overallPosition')).toBeNull();
      expect(screen.getByTestId('workout-add-block')).toBeTruthy();
    });

    it('takes you to the first workout climb when Start left another climb on the wall', () => {
      setWorkoutRun('session-1', run);
      queueState.queue = queued(['earlier', 'w1', 'w2', 'w3', 'm1', 'm2']);
      queueState.currentClimbQueueItem = { uuid: 'earlier' };
      render(createElement(WorkoutRunCard));

      expect(screen.queryByTestId('workout-runner-current')).toBeNull();
      expect(screen.getByTestId('workout-runner-resume').textContent).toContain('startWorkout');
      fireEvent.click(screen.getByTestId('workout-runner-resume'));
      expect(queueActions.setCurrentClimb).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'w1' }), {
        playlistSuggestionSource: null,
      });
    });
  });

  describe('off the plan', () => {
    it('takes you back to the workout climb you left for a climb from search, without counting it skipped', () => {
      setWorkoutRun('session-1', run);
      // On m1, nothing logged, the climber opened a climb from search: it went in
      // right after m1 and onto the wall.
      queueState.queue = queued(['w1', 'w2', 'w3', 'm1', 'from-search', 'm2']);
      queueState.currentClimbQueueItem = { uuid: 'from-search' };
      for (const uuid of ['w1', 'w2', 'w3']) {
        noteWorkoutRunTick('session-1', { queueItemUuid: uuid, status: 'send', climbedAt: '2026-10-24T12:00:00.000Z' });
      }
      render(createElement(WorkoutRunCard));

      expect(screen.getByTestId('workout-runner-resume').textContent).toBe('backToWorkoutClimb m1');
      expect(rowTexts()).toEqual([
        'workout-stage|preWorkoutSectionWarmUptallySent:3',
        'workout-stage|preGeneratorVolumeworkoutStageClimbs:2',
      ]);
      fireEvent.click(screen.getByTestId('workout-runner-resume'));
      expect(queueActions.setCurrentClimb).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'm1' }), {
        playlistSuggestionSource: null,
      });
    });
  });

  describe('Add a block', () => {
    it('sits under the stages and opens the sheet', () => {
      setWorkoutRun('session-1', run);
      const onAddBlock = vi.fn();
      render(createElement(WorkoutRunCard, { onAddBlock }));

      fireEvent.click(screen.getByTestId('workout-add-block'));
      expect(onAddBlock).toHaveBeenCalledTimes(1);
    });

    it('offers to start a workout in a session without one', () => {
      const onAddBlock = vi.fn();
      render(createElement(WorkoutRunCard, { onAddBlock }));

      expect(screen.getByText('addWorkoutPromptTitle')).toBeTruthy();
      fireEvent.click(screen.getByText('addWorkoutPromptTitle'));
      expect(onAddBlock).toHaveBeenCalledTimes(1);
    });

    it('offers a fresh block once the workout has left the queue', () => {
      setWorkoutRun('session-1', run);
      queueState.queue = queued(['hand-queued']);
      queueState.currentClimbQueueItem = { uuid: 'hand-queued' };
      render(createElement(WorkoutRunCard, { onAddBlock: vi.fn() }));

      expect(screen.getByTestId('workout-add-prompt')).toBeTruthy();
      expect(screen.queryByText('workoutCardTitle')).toBeNull();
    });

    it('renders nothing outside an active session', () => {
      queueState.sessionId = null;
      const { container } = render(createElement(WorkoutRunCard, { onAddBlock: vi.fn() }));
      expect(container.textContent).toBe('');
    });
  });

  it('names a warm-up planned as a cool-down "Cool-down"', () => {
    setWorkoutRun('session-1', {
      stages: [...run.stages, { id: 'cool', kind: 'warmUp', itemUuids: ['c1', 'c2'], coolDown: true }],
    });
    queueState.queue = queued(['w1', 'w2', 'w3', 'm1', 'm2', 'c1', 'c2']);
    queueState.currentClimbQueueItem = { uuid: 'c1' };
    render(createElement(WorkoutRunCard));

    expect(rowTexts()).toEqual([
      'workout-stage|preWorkoutSectionWarmUpworkoutStageClimbs:3',
      'workout-stage|preGeneratorVolumeworkoutStageClimbs:2',
      'workout-stage-current|preWorkoutSectionCoolDownworkoutStageToGo:1',
    ]);
  });
});
