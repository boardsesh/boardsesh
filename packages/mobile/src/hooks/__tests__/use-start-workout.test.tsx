// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

const harness = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  liveSessionId: 'session-1' as string | null,
  queue: [] as ClimbQueueItem[],
  currentClimbQueueItem: null as ClimbQueueItem | null,
  setCurrentClimb: vi.fn(),
  openPlayDrawer: vi.fn(),
  showToast: vi.fn(),
  reportError: vi.fn(),
  nowMs: Date.parse('2026-10-27T10:00:00Z'),
  settings: {} as Record<string, unknown>,
}));

vi.mock('../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: harness.sessionId }),
  useQueueData: () => ({ queue: harness.queue, currentClimbQueueItem: harness.currentClimbQueueItem }),
  useQueueActions: () => ({
    getQueueSnapshot: () => ({
      sessionId: harness.liveSessionId,
      queue: harness.queue,
      currentClimbQueueItem: harness.currentClimbQueueItem,
      playlistSuggestionSource: null,
    }),
    setCurrentClimb: harness.setCurrentClimb,
  }),
}));
vi.mock('../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: harness.openPlayDrawer }),
}));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: harness.showToast }) }));
vi.mock('../../lib/error-reporting', () => ({ reportError: harness.reportError }));
vi.mock('../../lib/clock', () => ({ nowMs: () => harness.nowMs }));
vi.mock('../../settings', () => ({
  getSetting: (key: string) => harness.settings[key],
  useSetting: (key: string) => [harness.settings[key], vi.fn()],
}));
vi.mock('../../lib/preference-store', () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  removePreference: vi.fn(async () => {}),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useStartWorkout } from '../use-start-workout';
import { RestTimerPacingSync } from '../../components/queue-control/RestTimerPacingSync';
import {
  getWorkoutRunForSession,
  isWorkoutRunPendingStart,
  markWorkoutRunStarted,
  prepareWorkoutRun,
  resetWorkoutRunStoreForTests,
} from '../../lib/workout-run-store';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  noteRestTimerQueueEnded,
  pauseRestTimer,
  resetRestTimerStoreForTests,
} from '../../lib/rest-timer-store';
import { resetRestTimerEffectiveForTests } from '../../lib/rest-timer-effective';
import { describeWorkoutRunner } from '../../lib/workout-runner-readout';

function queueItem(uuid: string): ClimbQueueItem {
  return { uuid, climb: { uuid: `climb-${uuid}`, name: uuid } } as unknown as ClimbQueueItem;
}

const VOLUME: WorkoutRun = { stages: [{ id: 'volume', kind: 'volume', itemUuids: ['a', 'b'] }] };
const ON_THE_MINUTE: WorkoutRun = {
  stages: [
    {
      id: 'on-the-minute',
      kind: 'onTheMinute',
      itemUuids: ['a', 'b'],
      pacing: { mode: 'onTheMinute', restSeconds: 60 },
    },
  ],
};
const LIMIT: WorkoutRun = {
  stages: [
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: ['a', 'b'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ],
};

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  resetRestTimerStoreForTests();
  resetRestTimerEffectiveForTests();
  harness.sessionId = 'session-1';
  harness.liveSessionId = 'session-1';
  harness.queue = [queueItem('unrelated'), queueItem('a'), queueItem('b')];
  harness.currentClimbQueueItem = null;
  harness.settings = { restTimerTargetSeconds: 60, restTimerMode: 'onTheMinute', restTimerAutoAdvance: true };
  harness.setCurrentClimb.mockReset();
  harness.setCurrentClimb.mockImplementation((item: ClimbQueueItem) => {
    harness.currentClimbQueueItem = item;
  });
  harness.openPlayDrawer.mockReset();
  harness.showToast.mockReset();
  harness.reportError.mockReset();
});
afterEach(cleanup);

describe('prepared workout launch', () => {
  it('selects the first surviving workout item from the live queue, using its exact uuid', () => {
    prepareWorkoutRun('session-1', VOLUME);
    const { result } = renderHook(useStartWorkout);
    const staleRenderedStart = result.current.startWorkout;
    const reorderedFirst = queueItem('b');
    harness.queue = [queueItem('unrelated'), reorderedFirst];

    act(staleRenderedStart);

    expect(harness.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(reorderedFirst, { playlistSuggestionSource: null });
    expect(harness.openPlayDrawer).toHaveBeenCalledExactlyOnceWith(reorderedFirst.climb, { committedExternally: true });
    expect(harness.setCurrentClimb.mock.invocationCallOrder[0]).toBeLessThan(
      harness.openPlayDrawer.mock.invocationCallOrder[0],
    );
    expect(isWorkoutRunPendingStart('session-1')).toBe(false);
    expect(getRestTimerState().armed).toBe(false);
  });

  it('does nothing after every staged item is removed', () => {
    prepareWorkoutRun('session-1', VOLUME);
    const { result, rerender } = renderHook(useStartWorkout);
    harness.queue = [queueItem('unrelated')];
    rerender();
    expect(result.current.firstItem).toBeNull();
    act(result.current.startWorkout);
    expect(isWorkoutRunPendingStart('session-1')).toBe(true);
    expect(harness.setCurrentClimb).not.toHaveBeenCalled();
    expect(harness.openPlayDrawer).not.toHaveBeenCalled();
  });

  it.each([null, 'other-session'])('rejects a stale callback after live session changes to %s', (liveSessionId) => {
    prepareWorkoutRun('session-1', VOLUME);
    const { result } = renderHook(useStartWorkout);
    harness.liveSessionId = liveSessionId;
    act(result.current.startWorkout);
    expect(isWorkoutRunPendingStart('session-1')).toBe(true);
    expect(harness.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('starts once across two hosts, including a synchronous re-entrant navigation callback', () => {
    prepareWorkoutRun('session-1', ON_THE_MINUTE);
    const { result } = renderHook(() => ({ pill: useStartWorkout(), card: useStartWorkout() }));
    const pillStart = result.current.pill.startWorkout;
    const cardStart = result.current.card.startWorkout;
    harness.openPlayDrawer.mockImplementationOnce(cardStart);

    act(() => {
      pillStart();
      cardStart();
    });

    expect(harness.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(harness.openPlayDrawer).toHaveBeenCalledTimes(1);
    expect(result.current.pill.pending).toBe(false);
    expect(result.current.card.pending).toBe(false);
  });

  it('retains preparation and timer state after navigation failure, then retries the same item', () => {
    prepareWorkoutRun('session-1', ON_THE_MINUTE);
    armRestTimer('onTheMinute', harness.nowMs - 20_000, 'session-1');
    const timerBefore = getRestTimerState();
    const { result } = renderHook(useStartWorkout);
    const first = harness.queue[1];
    harness.openPlayDrawer.mockImplementationOnce(() => {
      throw new Error('Navigation unavailable');
    });

    act(result.current.startWorkout);

    expect(isWorkoutRunPendingStart('session-1')).toBe(true);
    expect(getRestTimerState()).toBe(timerBefore);
    expect(harness.showToast).toHaveBeenCalledWith('mobile.workoutRunner.startError', 'error');
    expect(harness.currentClimbQueueItem).toBe(first);
    act(result.current.startWorkout);
    expect(isWorkoutRunPendingStart('session-1')).toBe(false);
    expect(harness.setCurrentClimb.mock.calls.map(([item]) => item)).toEqual([first, first]);
    expect(getRestTimerState().anchorMs).toBe(harness.nowMs);
  });

  it.each([false, true])(
    'starts a full on-the-minute interval over an existing matching clock (paused: %s)',
    (paused) => {
      prepareWorkoutRun('session-1', ON_THE_MINUTE);
      armRestTimer('onTheMinute', harness.nowMs - 40_000, 'session-1');
      if (paused) pauseRestTimer(harness.nowMs - 20_000);
      const { result } = renderHook(useStartWorkout);

      act(result.current.startWorkout);

      expect(getRestTimerState()).toMatchObject({ armed: true, isRunning: true, anchorMs: harness.nowMs });
    },
  );

  it('resumes a paused after-tick stage but waits for its own first tick', () => {
    prepareWorkoutRun('session-1', LIMIT);
    armRestTimer('afterTick', harness.nowMs - 40_000, 'session-1');
    noteRestTimerTick(new Date(harness.nowMs - 40_000).toISOString(), 'afterTick', harness.nowMs - 40_000);
    pauseRestTimer(harness.nowMs - 20_000);
    const { result } = renderHook(useStartWorkout);

    act(result.current.startWorkout);

    expect(getRestTimerState()).toMatchObject({
      armed: true,
      isRunning: true,
      anchorMs: null,
      pausedElapsedSeconds: 0,
    });
  });

  it.each(['onTheMinute', 'afterTick'] as const)(
    'clears an old queue-ended latch when launching a single-climb %s workout',
    (mode) => {
      const sourceRun = mode === 'onTheMinute' ? ON_THE_MINUTE : LIMIT;
      const singleClimbRun: WorkoutRun = { stages: [{ ...sourceRun.stages[0], itemUuids: ['a'] }] };
      harness.queue = [queueItem('a')];
      prepareWorkoutRun('session-1', singleClimbRun);
      armRestTimer(mode, harness.nowMs - 20_000, 'session-1');
      noteRestTimerTick(new Date(harness.nowMs - 20_000).toISOString(), mode, harness.nowMs - 20_000);
      noteRestTimerQueueEnded({ listEnded: true });
      expect(getRestTimerState().queueEnded).toBe(true);
      const { result } = renderHook(useStartWorkout);

      act(result.current.startWorkout);

      expect(getRestTimerState()).toMatchObject({
        armed: true,
        isRunning: true,
        queueEnded: false,
        anchorMs: mode === 'onTheMinute' ? harness.nowMs : null,
      });
      expect(
        describeWorkoutRunner({
          run: singleClimbRun,
          queueUuids: ['a'],
          currentUuid: 'a',
          nextUuid: null,
          log: [],
          rest: getRestTimerState(),
          canAdvanceQueue: true,
        })?.phase,
      ).toBe('climbing');
    },
  );

  it('leaves an existing personal timer unchanged when starting an untimed workout', () => {
    prepareWorkoutRun('session-1', VOLUME);
    armRestTimer('onTheMinute', harness.nowMs - 20_000, 'session-1');
    const timerBefore = getRestTimerState();
    const { result } = renderHook(useStartWorkout);

    act(result.current.startWorkout);

    expect(getRestTimerState()).toBe(timerBefore);
  });
});

describe('prepared stage pacing', () => {
  it('does not take pacing over when a remote/manual selection puts a prepared item on the wall', () => {
    prepareWorkoutRun('session-1', ON_THE_MINUTE);
    armRestTimer('onTheMinute', harness.nowMs - 20_000, 'session-1');
    const timerBefore = getRestTimerState();
    const screen = render(createElement(RestTimerPacingSync));
    harness.currentClimbQueueItem = harness.queue[1];
    screen.rerender(createElement(RestTimerPacingSync));

    expect(isWorkoutRunPendingStart('session-1')).toBe(true);
    expect(getRestTimerState()).toBe(timerBefore);
    expect(getRestTimerState().stagePacing).toBeNull();
  });

  it('reconsiders pacing when preparation is consumed without replacing the run', () => {
    prepareWorkoutRun('session-1', ON_THE_MINUTE);
    harness.currentClimbQueueItem = harness.queue[1];
    const heldRun = getWorkoutRunForSession('session-1');
    render(createElement(RestTimerPacingSync));
    expect(getRestTimerState().stagePacing).toBeNull();

    act(() => {
      markWorkoutRunStarted('session-1');
    });

    expect(getWorkoutRunForSession('session-1')).toBe(heldRun);
    expect(getRestTimerState().stagePacing).toMatchObject({ mode: 'onTheMinute', queueItemUuid: 'a' });
  });
});
