// @vitest-environment jsdom
//
// The rest floor (#5380, #6729): an after-tick rest that began before the last
// advance counts from that advance, less the 3 s slack, for as long as it is
// still running. It is defence in depth behind the tick floor: the paths below
// reach a rest like that without a fresh tick, and each one used to move the
// wall a second time seconds after the first.
//
// The scheduler, the pacing sync, the pill, the rest-timer store and the
// workout-run store are all REAL, so what is asserted is their agreement: the
// wall moves when the pill reaches zero. Every "it fires" is paired with an "it
// does not fire".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

type QueueItemStub = { uuid: string; climb: { uuid: string } };

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let data = { queue: [] as QueueItemStub[], currentClimbQueueItem: null as QueueItemStub | null };
  return {
    settings: {} as Record<string, unknown>,
    nowMs: 0,
    getQueueData: () => data,
    setQueueData: (next: { queue: QueueItemStub[]; currentClimbQueueItem: QueueItemStub | null }) => {
      data = next;
      for (const listener of listeners) listener();
    },
    subscribeQueueData: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

/** The real queue's Next: the following queue item goes up, or nothing changes at the end. */
const nextClimb = vi.fn(() => {
  const { queue, currentClimbQueueItem } = harness.getQueueData();
  const position = queue.findIndex((queueItem) => queueItem.uuid === currentClimbQueueItem?.uuid);
  const next = queue[position + 1];
  if (next) harness.setQueueData({ queue, currentClimbQueueItem: next });
});

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

// Partial mock: @boardsesh/profile-stats (reached through the real rest-timer
// store) reads other exports of this package at module load.
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  computeNavigationStateWithSuggestions: (queue: QueueItemStub[], current: QueueItemStub | null) => {
    const position = queue.findIndex((queueItem) => queueItem.uuid === current?.uuid);
    return {
      canNext: position >= 0 && position < queue.length - 1,
      canPrevious: false,
      nextItem: null,
      prevItem: null,
      remainingCount: 0,
      atTrackEnd: false,
    };
  },
}));

vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));
vi.mock('../../../providers/queue-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useQueueActions: () => ({ nextClimb, getQueueSnapshot: vi.fn(), refreshPlaylistSuggestionSource: vi.fn() }),
    useQueueData: () => useSyncExternalStore(harness.subscribeQueueData, harness.getQueueData),
    useQueueSessionId: () => ({ sessionId: 'session-1' }),
    useIsCrewSession: () => false,
    usePlaylistSuggestionSource: () => null,
  };
});
vi.mock('../../../lib/playlists/track-pager', () => ({ canLoadMoreOfTrack: () => false }));
vi.mock('../../play-drawer/use-track-paging', () => ({ useTrackPaging: () => {} }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1 } }),
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    inAppBoardConnection: 'connectedByMe',
    localConnected: false,
    holderDisplayName: null,
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../hooks/use-keep-awake-while', () => ({ useKeepAwakeWhile: () => {} }));
vi.mock('../../../settings', () => ({
  useSetting: (key: string) => [harness.settings[key], vi.fn()],
  getSetting: (key: string) => harness.settings[key],
}));
vi.mock('../../../lib/clock', () => ({ nowMs: () => harness.nowMs }));
vi.mock('../../../lib/rest-timer-cues', () => ({ playRestTimerCue: vi.fn() }));

// The pill's own surface, as rest-timer-pill.test.tsx mocks it.
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111111', secondaryLabel: '#666666', tertiaryLabel: '#AAAAAA', accent: '#6D28D9' },
    brandColors: { error: '#C81E1E', primary: '#7C3AED' },
  }),
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../theme/typography', () => ({
  CHROME_LABEL_MAX_FONT_SCALE: 1.2,
  REST_CLOCK_MAX_FONT_SCALE: 1.3,
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('button', { 'data-testid': testID }, children),
}));
vi.mock('../AccessoryBarSurface', () => ({
  AccessoryBarSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

import {
  armRestTimer,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
} from '../../../lib/rest-timer-store';
import { isTickFreshEnoughToArm } from '../../../lib/rest-timer-auto-advance';
import type { RestTimerTickStatus } from '../../../lib/rest-timer-pacing';
import { noteWorkoutRunTick, resetWorkoutRunStoreForTests, setWorkoutRun } from '../../../lib/workout-run-store';
import { RestTimerAutoAdvanceScheduler } from '../RestTimerAutoAdvanceScheduler';
import { RestTimerPacingSync } from '../RestTimerPacingSync';
import { RestTimerPill } from '../RestTimerPill';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

const queueItem = (uuid: string): QueueItemStub => ({ uuid, climb: { uuid: `climb-${uuid}` } });

/** 4x4: 2 sets of 2 reps, no rest between reps, 30 s between sets. */
const FOUR_BY_FOUR: WorkoutRun = {
  stages: [
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a', 'b'],
      pacing: {
        mode: 'afterTick',
        restSeconds: 0,
        advanceOn: 'set',
        sets: { repsPerSet: 2, restBetweenSetsSeconds: 30 },
      },
    },
  ],
};

/** 4x4: 3 sets of 2 reps with no rest between sets, so the 10 s changeover. */
const FOUR_BY_FOUR_CHANGEOVER: WorkoutRun = {
  stages: [
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a', 'b', 'c'],
      pacing: {
        mode: 'afterTick',
        restSeconds: 0,
        advanceOn: 'set',
        sets: { repsPerSet: 2, restBetweenSetsSeconds: 0 },
      },
    },
  ],
};

/** A climb every 0:15. */
const ON_THE_MINUTE: WorkoutRun = {
  stages: [
    {
      id: 'stage-emom',
      kind: 'onTheMinute',
      itemUuids: ['e1', 'e2'],
      pacing: { mode: 'onTheMinute', restSeconds: 15 },
    },
  ],
};

/**
 * One second at a time. The fire re-checks the wall clock against its deadline
 * (the background guard), so one long jump would read every due fire as stale
 * and a "never fires" case would pass for the wrong reason.
 */
function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    const step = Math.min(1_000, ms - elapsed);
    act(() => {
      harness.nowMs += step;
      vi.advanceTimersByTime(step);
    });
  }
}

/** Run the clock up to `atMs`. */
function advanceTo(atMs: number) {
  advance(atMs - harness.nowMs);
}

function current(): string | null {
  return harness.getQueueData().currentClimbQueueItem?.uuid ?? null;
}

/**
 * The tick path, as use-tick-saver runs it: a tick on `queueItemUuid` (or on
 * whatever is up), climbed `agoMs` before it lands. The rest timer first, then
 * the workout's tick log, which a 4x4 counts its reps from. A tick dated more
 * than a minute back is history and stays out of the log.
 */
function logTick(status: RestTimerTickStatus, queueItemUuid: string | null = current(), agoMs = 0) {
  act(() => {
    const climbedAt = new Date(harness.nowMs - agoMs).toISOString();
    noteRestTimerTick(climbedAt, getRestTimerState().stagePacing?.mode ?? 'afterTick', harness.nowMs, {
      status,
      queueItemUuid,
    });
    if (queueItemUuid !== null && isTickFreshEnoughToArm(Date.parse(climbedAt), harness.nowMs)) {
      noteWorkoutRunTick('session-1', { queueItemUuid, status, climbedAt });
    }
  });
}

function runtime() {
  return (
    <>
      <RestTimerPacingSync />
      <RestTimerAutoAdvanceScheduler />
      <RestTimerPill onPress={() => {}} />
    </>
  );
}

function pillText(container: HTMLElement): string {
  return container.querySelector('[data-testid="rest-timer-pill-elapsed"]')?.textContent ?? '';
}

function setRestSeconds(seconds: number, rerender: (ui: ReactNode) => void) {
  harness.settings = { ...harness.settings, restTimerTargetSeconds: seconds };
  act(() => rerender(runtime()));
}

/**
 * The 4x4's last set moves on after its 30 s set rest onto a climb outside the
 * workout, which runs on the climber's own 1:30 with auto-advance on. The tick
 * rule's fire leaves no anchor and the stage change keeps it that way, so the
 * hand climb waits for a tick. Returns the advance instant, B.
 */
function advanceOffTheWorkout(): { advancedAtMs: number; rerender: (ui: ReactNode) => void; container: HTMLElement } {
  const queue = ['a', 'b', 'hand-1', 'hand-2', 'hand-3'].map(queueItem);
  harness.setQueueData({ queue, currentClimbQueueItem: queue[1] });
  setWorkoutRun('session-1', FOUR_BY_FOUR);
  const { rerender, container } = render(runtime());
  act(() => armRestTimer('afterTick', harness.nowMs, 'session-1'));
  logTick('attempt');
  logTick('send');
  advance(30_000);
  expect(current()).toBe('hand-1');
  expect(nextClimb).toHaveBeenCalledTimes(1);
  const advancedAtMs = harness.nowMs;
  expect(getRestTimerState()).toMatchObject({ anchorMs: null, lastFiredDeadlineMs: advancedAtMs, stagePacing: null });
  return { advancedAtMs, rerender, container };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRestTimerStoreForTests();
  resetWorkoutRunStoreForTests();
  harness.nowMs = T0;
  harness.setQueueData({ queue: [], currentClimbQueueItem: null });
  harness.settings = { restTimerTargetSeconds: 90, restTimerAutoAdvance: true, restTimerMode: 'afterTick' };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a rest that began before the last advance', () => {
  it('waits a whole rest from the advance, less the 3 s slack, for a send from 85 s ago: not 7 s', () => {
    const { advancedAtMs } = advanceOffTheWorkout();

    // 2 s after the advance, the date picker logs a send from 85 s ago: history,
    // so it anchors at its own time, and its own 1:30 would run out 7 s after
    // the advance.
    advance(2_000);
    logTick('send', 'hand-1', 85_000);

    advanceTo(advancedAtMs + 86_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('hand-1');

    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-2');
  });

  it('does the same after an on-the-minute stage hands the wall to a climb outside it', () => {
    const queue = ['e1', 'e2', 'hand-1', 'hand-2'].map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    setWorkoutRun('session-1', ON_THE_MINUTE);
    render(runtime());
    act(() => armRestTimer('onTheMinute', harness.nowMs, 'session-1'));
    advance(30_000);
    expect(current()).toBe('hand-1');
    const advancedAtMs = harness.nowMs;
    // Leaving the minute waits for a tick.
    expect(getRestTimerState()).toMatchObject({ anchorMs: null, lastFiredDeadlineMs: advancedAtMs });

    advance(2_000);
    logTick('send', 'hand-1', 85_000);

    advanceTo(advancedAtMs + 86_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-1');

    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(3);
    expect(current()).toBe('hand-2');
  });

  it('shows the same rest on the pill: it reaches 0:00 as the wall moves', () => {
    const { advancedAtMs, container } = advanceOffTheWorkout();

    advance(2_000);
    logTick('send', 'hand-1', 85_000);
    // The rest counts from 3 s before the advance: 1:25 left, not 0:05.
    expect(pillText(container)).toBe('1:25');

    advanceTo(advancedAtMs + 86_000);
    expect(pillText(container)).toBe('0:01');
    expect(nextClimb).toHaveBeenCalledTimes(1);

    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    // The advance starts the next climb's rest.
    expect(pillText(container)).toBe('1:30');
  });

  it('carries the floored rest across a pause', () => {
    const { advancedAtMs, container } = advanceOffTheWorkout();
    advance(2_000);
    logTick('send', 'hand-1', 85_000);

    advance(8_000);
    act(() => pauseRestTimer(harness.nowMs));
    expect(pillText(container)).toBe('1:17');

    advance(20_000);
    expect(pillText(container)).toBe('1:17');
    act(() => resumeRestTimer(harness.nowMs));

    // 77 s left at the resume, 30 s after the advance.
    advanceTo(advancedAtMs + 106_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
  });

  it('never revives a rest that ran out before it landed: a send from 5 min ago starts nothing', () => {
    const { advancedAtMs } = advanceOffTheWorkout();
    advance(2_000);
    logTick('send', 'hand-1', 300_000);

    advance(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('hand-1');
    expect(getRestTimerState().anchorMs).toBe(advancedAtMs + 2_000 - 300_000);
  });
});

describe('a longer rest set over a rest that had run out (the settings-edit revival)', () => {
  it('moves the wall no earlier than the new rest from the advance, less the slack', () => {
    const { advancedAtMs, rerender } = advanceOffTheWorkout();
    advance(2_000);
    // Its own 1:30 ran out 3:28 before the advance: nothing is scheduled.
    logTick('send', 'hand-1', 300_000);
    advance(8_000);

    // 5:10 from 5:00 ago runs out 12 s after the advance.
    setRestSeconds(310, rerender);

    advanceTo(advancedAtMs + 306_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('hand-1');

    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-2');
  });

  it('leaves it run out when the longer rest has run out too', () => {
    const { rerender } = advanceOffTheWorkout();
    advance(2_000);
    logTick('send', 'hand-1', 300_000);
    advance(8_000);

    // 5:00 from 5:00 ago ran out 2 s after the advance, 8 s ago.
    setRestSeconds(300, rerender);

    advance(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('hand-1');
  });
});

describe('what the floor leaves alone', () => {
  it('an ordinary after-tick rest: tick, a whole rest, the next whole rest from the advance', () => {
    const queue = ['x1', 'x2', 'x3'].map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    render(runtime());
    act(() => armRestTimer('afterTick', harness.nowMs, 'session-1'));
    logTick('send');

    advance(89_000);
    expect(nextClimb).not.toHaveBeenCalled();
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    const advancedAtMs = harness.nowMs;
    expect(getRestTimerState().anchorMs).toBe(advancedAtMs);

    advance(89_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('x3');
  });

  it('the 4x4 changeover: 10 s after a set’s last rep, right after the set before it moved the wall', () => {
    const queue = ['a', 'b', 'c'].map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    setWorkoutRun('session-1', FOUR_BY_FOUR_CHANGEOVER);
    render(runtime());
    act(() => armRestTimer('afterTick', harness.nowMs, 'session-1'));
    logTick('attempt');
    logTick('send');
    advance(10_000);
    expect(current()).toBe('b');
    expect(getRestTimerState().stagePacing).toMatchObject({
      queueItemUuid: 'b',
      targetSeconds: null,
      reps: { logged: 0, perSet: 2 },
    });

    // b's first rep as it came up, its last a second later.
    logTick('attempt');
    advance(1_000);
    logTick('send');
    expect(getRestTimerState().stagePacing).toMatchObject({ queueItemUuid: 'b', targetSeconds: 10, closesSet: true });
    advance(9_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('c');
  });

  it('the 4x4 changeover for reps dated before the advance: 10 s from the advance', () => {
    const queue = ['a', 'b', 'c'].map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    setWorkoutRun('session-1', FOUR_BY_FOUR_CHANGEOVER);
    render(runtime());
    act(() => armRestTimer('afterTick', harness.nowMs, 'session-1'));
    logTick('attempt');
    logTick('send');
    advance(10_000);
    expect(current()).toBe('b');
    const advancedAtMs = harness.nowMs;

    // Both of b's reps saved 1 s after the advance, dated 20 and 19 s back: the
    // tick floor starts the set rest at the advance.
    advance(1_000);
    logTick('attempt', 'b', 20_000);
    logTick('send', 'b', 19_000);
    advanceTo(advancedAtMs + 9_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('c');
  });
});

describe('a rest length changed after an advance', () => {
  it('a shorter rest waits the new rest from the advance', () => {
    const queue = ['x1', 'x2', 'x3'].map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    const { rerender } = render(runtime());
    act(() => armRestTimer('afterTick', harness.nowMs, 'session-1'));
    logTick('send');
    advance(90_000);
    expect(current()).toBe('x2');
    const advancedAtMs = harness.nowMs;

    advance(10_000);
    setRestSeconds(30, rerender);

    advanceTo(advancedAtMs + 29_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('x3');
  });

  it('a shorter rest over a floored one waits the new rest from the advance, less the slack', () => {
    const { advancedAtMs, rerender } = advanceOffTheWorkout();
    advance(2_000);
    logTick('send', 'hand-1', 85_000);

    advance(8_000);
    setRestSeconds(30, rerender);

    advanceTo(advancedAtMs + 26_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-2');
  });
});

describe('arming again', () => {
  it('starts with no last advance, so the next rest counts from its own tick', () => {
    const { advancedAtMs } = advanceOffTheWorkout();
    act(() => disarmRestTimer());
    advance(1_000);
    act(() => armRestTimer('afterTick', harness.nowMs, 'session-1'));
    expect(getRestTimerState().lastFiredDeadlineMs).toBeNull();

    // Logged now, climbed 50 s ago: a minute back at most is a climb just done,
    // and with no advance behind it the rest runs from its own time.
    logTick('send', 'hand-1', 50_000);
    advanceTo(advancedAtMs + 40_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-2');
  });
});
