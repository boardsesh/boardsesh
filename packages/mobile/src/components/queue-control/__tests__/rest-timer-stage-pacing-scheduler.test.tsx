// @vitest-environment jsdom
//
// The rest timer under a workout stage (#5380, #6231). The scheduler, the pacing
// sync, the rest-timer store and the workout-run store are all REAL: what moves
// the wall is their agreement, so the queue here moves when `nextClimb` runs and
// the sync re-resolves the stage exactly as it does in the app.
//
// Every "it fires" case is paired with an "it does not fire" case. The global
// settings' pairs live in rest-timer-auto-advance-scheduler.test.tsx and stay
// untouched by a stage.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

type QueueItemStub = { uuid: string; climb: { uuid: string } };

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let data = { queue: [] as QueueItemStub[], currentClimbQueueItem: null as QueueItemStub | null };
  return {
    isCrewSession: false,
    inAppBoardConnection: 'connectedByMe',
    settings: {} as Record<string, unknown>,
    nowMs: 0,
    sessionId: 'session-1' as string | null,
    queueDataReads: 0,
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

vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

// Partial mock: @boardsesh/profile-stats (reached through the real rest-timer
// store) reads other exports of this package at module load. Next exists while
// a later queue item does, exactly as the queue would say.
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

vi.mock('../../../providers/queue-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useQueueActions: () => ({ nextClimb, getQueueSnapshot: vi.fn(), refreshPlaylistSuggestionSource: vi.fn() }),
    useQueueData: () => {
      harness.queueDataReads += 1;
      return useSyncExternalStore(harness.subscribeQueueData, harness.getQueueData);
    },
    useQueueSessionId: () => ({ sessionId: harness.sessionId }),
    useIsCrewSession: () => harness.isCrewSession,
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
    inAppBoardConnection: harness.inAppBoardConnection,
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

import { playRestTimerCue, type RestTimerCueKind } from '../../../lib/rest-timer-cues';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
} from '../../../lib/rest-timer-store';
import type { RestTimerTickStatus } from '../../../lib/rest-timer-pacing';
import { resetWorkoutRunStoreForTests, setWorkoutRun } from '../../../lib/workout-run-store';
import { RestTimerAutoAdvanceScheduler } from '../RestTimerAutoAdvanceScheduler';
import { RestTimerPacingSync } from '../RestTimerPacingSync';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

const queueItem = (uuid: string): QueueItemStub => ({ uuid, climb: { uuid: `climb-${uuid}` } });

/** 4x4: 2 climbs x 2 rounds, 0 s between climbs (the 10 s changeover), 30 s between rounds. */
const FOUR_BY_FOUR: WorkoutRun = {
  stages: [
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a1', 'b1', 'a2', 'b2'],
      pacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 30, advanceOn: 'tick' },
      rounds: 2,
      roundByUuid: { a1: 1, b1: 1, a2: 2, b2: 2 },
    },
  ],
};

/** Limit bouldering: 3:00 rest, moves on only after a send. */
const LIMIT: WorkoutRun = {
  stages: [
    {
      id: 'stage-limit',
      kind: 'limitBouldering',
      itemUuids: ['l1', 'l2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ],
};

/** The same 4x4, then the limit block: the rest after b2 is the 4x4's, not the next block's. */
const FOUR_BY_FOUR_THEN_LIMIT: WorkoutRun = { stages: [...FOUR_BY_FOUR.stages, ...LIMIT.stages] };

/** A warm-up on the climber's own settings, then a climb every 0:15. */
const WARM_UP_THEN_ON_THE_MINUTE: WorkoutRun = {
  stages: [
    { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'stage-emom',
      kind: 'onTheMinute',
      itemUuids: ['e1', 'e2', 'e3'],
      pacing: { mode: 'onTheMinute', restSeconds: 15 },
    },
  ],
};

function cueCount(kind: RestTimerCueKind): number {
  return vi.mocked(playRestTimerCue).mock.calls.filter(([cue]) => cue.kind === kind).length;
}

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

function current(): string | null {
  return harness.getQueueData().currentClimbQueueItem?.uuid ?? null;
}

/** A workout on the wall: its queue, the climb that is up, and the run on this phone. */
function startWorkout(run: WorkoutRun, queueUuids: string[], currentUuid = queueUuids[0]) {
  const queue = queueUuids.map(queueItem);
  harness.setQueueData({ queue, currentClimbQueueItem: queue.find((item) => item.uuid === currentUuid) ?? null });
  setWorkoutRun('session-1', run);
}

/** The tick path: a tick on `queueItemUuid` (or on whatever is up), noted now. */
function logTick(status: RestTimerTickStatus, queueItemUuid: string | null = current(), lateMs = 0) {
  act(() => {
    noteRestTimerTick(
      new Date(harness.nowMs - lateMs).toISOString(),
      getRestTimerState().stagePacing?.mode ?? 'afterTick',
      harness.nowMs,
      {
        status,
        queueItemUuid,
      },
    );
  });
}

function renderRuntime() {
  return render(
    <>
      <RestTimerPacingSync />
      <RestTimerAutoAdvanceScheduler />
    </>,
  );
}

function armTimer() {
  act(() => armRestTimer(getRestTimerState().stagePacing?.mode ?? 'afterTick', harness.nowMs, 'session-1'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRestTimerStoreForTests();
  resetWorkoutRunStoreForTests();
  harness.isCrewSession = false;
  harness.inAppBoardConnection = 'connectedByMe';
  harness.sessionId = 'session-1';
  harness.nowMs = T0;
  harness.queueDataReads = 0;
  harness.setQueueData({ queue: [], currentClimbQueueItem: null });
  // The climber's own rest: a minute, auto-advance OFF. A stage must override both.
  harness.settings = { restTimerTargetSeconds: 60, restTimerAutoAdvance: false, restTimerMode: 'afterTick' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stage paces the timer', () => {
  it('fires at the stage rest with auto-advance off in the settings, not at the climber’s own minute', () => {
    startWorkout(LIMIT, ['l1', 'l2']);
    renderRuntime();
    armTimer();
    logTick('send');

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();

    advance(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l2');
  });

  it('leaves the climber’s own settings in charge of a climb outside the workout', () => {
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
    startWorkout(LIMIT, ['l1', 'hand-1', 'hand-2'], 'hand-1');
    renderRuntime();
    armTimer();
    logTick('attempt');

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(getRestTimerState().stagePacing).toBeNull();
  });
});

describe('limit bouldering: moves on only after a send', () => {
  it('never moves on after a fall: the rest runs out with the reached cue and the climb stays up', () => {
    startWorkout(LIMIT, ['l1', 'l2']);
    renderRuntime();
    armTimer();
    logTick('attempt');

    advance(180_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(cueCount('reached')).toBe(1);
    expect(current()).toBe('l1');

    advance(600_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('moves on once after a send, even after falls on the same climb', () => {
    startWorkout(LIMIT, ['l1', 'l2']);
    renderRuntime();
    armTimer();
    logTick('attempt');
    advance(200_000);
    logTick('send');

    advance(180_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(cueCount('advance')).toBe(1);
    expect(current()).toBe('l2');

    // The next climb has not been touched: nothing more happens.
    advance(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('counts a flash as a send', () => {
    startWorkout(LIMIT, ['l1', 'l2']);
    renderRuntime();
    armTimer();
    logTick('flash');

    advance(180_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('4x4: every climb waits for its own tick', () => {
  it('walks the round with a changeover, rests the round rest after its last climb, and never walks on alone', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    expect(getRestTimerState().stagePacing).toMatchObject({ queueItemUuid: 'a1', targetSeconds: 10 });

    logTick('send');
    advance(10_000);
    expect(current()).toBe('b1');
    expect(getRestTimerState()).toMatchObject({ anchorMs: null, lastTick: null });

    // b1 closes round 1. Nobody has climbed it yet: no rest, no move.
    advance(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(getRestTimerState().stagePacing).toMatchObject({
      queueItemUuid: 'b1',
      targetSeconds: 30,
      closesRound: true,
    });

    // A fall still counts on a 4x4: log it and the round rest runs.
    logTick('attempt');
    advance(29_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('a2');
  });

  it('rests the 4x4’s round rest after its last climb before the next block, not zero', () => {
    startWorkout(FOUR_BY_FOUR_THEN_LIMIT, ['a1', 'b1', 'a2', 'b2', 'l1', 'l2'], 'b2');
    renderRuntime();
    armTimer();
    expect(getRestTimerState().stagePacing).toMatchObject({
      stageId: 'stage-4x4',
      queueItemUuid: 'b2',
      closesRound: true,
      targetSeconds: 30,
    });

    logTick('attempt');
    // Not the 0 s between climbs, nor its 10 s changeover.
    advance(29_000);
    expect(nextClimb).not.toHaveBeenCalled();
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l1');

    // The limit block's first climb waits for its own send, then rests 3:00.
    expect(getRestTimerState()).toMatchObject({
      anchorMs: null,
      stagePacing: { stageId: 'stage-limit', queueItemUuid: 'l1', targetSeconds: 180 },
    });
    advance(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('does not take a tick on the previous climb as this climb’s', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2'], 'b1');
    renderRuntime();
    armTimer();
    logTick('send', 'a1');

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('does not take a tick from a list (no queue item) as this climb’s', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    logTick('send', null);

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('still moves on when a climb from a list is logged during the round rest', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2'], 'b1');
    renderRuntime();
    armTimer();
    logTick('send');
    advance(10_000);

    // Something off the wall, logged from a list: it counts for no queue item,
    // so b1's tick still stands and its round rest still moves the wall.
    logTick('send', null);
    expect(getRestTimerState().lastTick).toMatchObject({ queueItemUuid: 'b1' });

    advance(30_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('a2');
  });

  it('a manual Next mid-rest does not move the wall a second time', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(5_000);

    // The climber skips ahead themselves, 5 s into a 10 s changeover.
    act(() => nextClimb());
    expect(current()).toBe('b1');
    expect(getRestTimerState().anchorMs).toBeNull();

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b1');
  });

  it('still fires on a tick saved a few seconds late: the 10 s changeover clears the overdue grace', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    // The tick says it was climbed 6 s ago (a slow save): 4 s of rest left.
    logTick('send', 'a1', 6_000);

    advance(3_000);
    expect(nextClimb).not.toHaveBeenCalled();
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a tick back-dated past the changeover and its grace', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    logTick('send', 'a1', 20_000);

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('a crew', () => {
  it('never fires a stage rest from a passenger’s phone', () => {
    harness.isCrewSession = true;
    harness.inAppBoardConnection = 'heldByPeer';
    startWorkout(LIMIT, ['l1', 'l2']);
    renderRuntime();
    armTimer();
    logTick('send');

    advance(600_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('fires it from the phone holding the wall', () => {
    harness.isCrewSession = true;
    harness.inAppBoardConnection = 'connectedByMe';
    startWorkout(LIMIT, ['l1', 'l2']);
    renderRuntime();
    armTimer();
    logTick('send');

    advance(180_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('on the minute', () => {
  it('starts the beat when its first climb comes up, and never fires early', () => {
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true, restTimerTargetSeconds: 300 };
    startWorkout(WARM_UP_THEN_ON_THE_MINUTE, ['w1', 'e1', 'e2', 'e3']);
    renderRuntime();
    armTimer();
    logTick('send');

    // The warm-up runs on the climber's own 5:00 rest.
    advance(299_000);
    expect(nextClimb).not.toHaveBeenCalled();
    advance(1_000);
    expect(current()).toBe('e1');
    expect(getRestTimerState().anchorMs).toBe(T0 + 300_000);

    // The first climb every 0:15 gets the whole interval.
    advance(14_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('e2');
  });

  it('gives the first climb its whole interval after a pause carried across the stage change', () => {
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true, restTimerTargetSeconds: 300 };
    startWorkout(WARM_UP_THEN_ON_THE_MINUTE, ['w1', 'e1', 'e2', 'e3']);
    renderRuntime();
    armTimer();
    logTick('send');

    // Paused 40 s into the warm-up rest, then on to the first climb by hand.
    advance(40_000);
    act(() => pauseRestTimer(harness.nowMs));
    act(() => nextClimb());
    expect(current()).toBe('e1');
    advance(5_000);
    act(() => resumeRestTimer(harness.nowMs));

    advance(14_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('e2');
  });

  it('moves on every beat whether or not anything was logged', () => {
    startWorkout(WARM_UP_THEN_ON_THE_MINUTE, ['e1', 'e2', 'e3']);
    renderRuntime();
    armTimer();

    advance(15_000);
    expect(current()).toBe('e2');
    advance(15_000);
    expect(current()).toBe('e3');
    expect(nextClimb).toHaveBeenCalledTimes(2);
  });
});

describe('the end of the queue under a tick rule', () => {
  it('waits for the next tick once the queue is refilled, instead of walking on', () => {
    startWorkout(LIMIT, ['l1']);
    renderRuntime();
    armTimer();
    logTick('send');

    advance(180_000);
    expect(getRestTimerState().queueEnded).toBe(true);
    expect(nextClimb).not.toHaveBeenCalled();

    // A climb is added behind it.
    act(() =>
      harness.setQueueData({ queue: [queueItem('l1'), queueItem('later')], currentClimbQueueItem: queueItem('l1') }),
    );
    expect(getRestTimerState()).toMatchObject({ queueEnded: false, anchorMs: null });

    advance(600_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('never walks on after the refill with the send whose rest ran out, on a Reset or a tick-less re-anchor', () => {
    startWorkout(LIMIT, ['l1']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(180_000);
    expect(getRestTimerState().queueEnded).toBe(true);

    act(() =>
      harness.setQueueData({ queue: [queueItem('l1'), queueItem('later')], currentClimbQueueItem: queueItem('l1') }),
    );
    expect(getRestTimerState().lastTick).toBeNull();

    // The climber taps Reset on the running timer.
    act(() => resetRestTimer(harness.nowMs));
    advance(600_000);
    expect(nextClimb).not.toHaveBeenCalled();

    // A tick read back from the session (the same account's other phone).
    act(() => noteRestTimerTick(new Date(harness.nowMs).toISOString(), 'afterTick', harness.nowMs));
    advance(600_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(current()).toBe('l1');
  });
});

/** Climbs outside any workout, paced by the climber's own minute with auto-advance on. */
function onTheWallWithoutAWorkout(queueUuids: string[]) {
  harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
  const queue = queueUuids.map(queueItem);
  harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
}

describe('the tick floor: a tick never starts a rest before the last advance or the rest already running', () => {
  it('does not skip the climb just lit for a send saved 2 s after the advance but dated 55 s back', () => {
    onTheWallWithoutAWorkout(['x1', 'x2', 'x3', 'x4']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(60_000);
    expect(current()).toBe('x2');

    // x1's send, climbed 55 s ago and saved now. From its own time the next
    // deadline would be 7 s out.
    advance(2_000);
    logTick('send', 'x1', 55_000);

    advance(57_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('x2');
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('x3');
  });

  it('keeps the newly lit climb’s rest when an older tick on the previous climb lands after it', () => {
    onTheWallWithoutAWorkout(['x1', 'x2', 'x3', 'x4']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(60_000);
    expect(current()).toBe('x2');

    // x2's tick 20 s after the advance: its rest is up 80 s after the advance.
    advance(20_000);
    logTick('send', 'x2');
    // x1's tick, dated 5 s before the advance, lands 10 s later.
    advance(10_000);
    logTick('send', 'x1', 35_000);

    advance(49_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('x2');
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('x3');
  });

  it('leaves the first tick of a session at its own time', () => {
    onTheWallWithoutAWorkout(['x1', 'x2']);
    renderRuntime();
    armTimer();
    logTick('send', 'x1', 10_000);

    advance(49_000);
    expect(nextClimb).not.toHaveBeenCalled();
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('under a send rule, starts the newly lit climb’s rest no earlier than the advance', () => {
    startWorkout(LIMIT, ['l1', 'l2', 'hand-1']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(180_000);
    expect(current()).toBe('l2');

    // l2 sent and saved 2 s after it came up, dated 55 s back: it gets the
    // whole 3:00 from the advance, not 2:07.
    advance(2_000);
    logTick('send', 'l2', 55_000);

    advance(177_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l2');
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-1');
  });

  it('under a tick rule, starts a late previous-climb tick’s rest at the advance, and never walks on with it', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(10_000);
    expect(current()).toBe('b1');
    const advancedAt = harness.nowMs;

    // a1's attempt, climbed 3 s before the advance, saved 2 s after it.
    advance(2_000);
    logTick('attempt', 'a1', 5_000);
    expect(getRestTimerState().anchorMs).toBe(advancedAt);

    // b1 closes round 1: the round rest runs its whole 30 s from the advance.
    advance(27_000);
    expect(cueCount('reached')).toBe(0);
    advance(1_000);
    expect(cueCount('reached')).toBe(1);

    // a1's tick is not b1's: b1 never moves on alone.
    advance(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b1');

    // b1's own tick gets its own whole round rest.
    logTick('attempt');
    advance(29_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('a2');
  });
});

describe('a late tick on the previous climb', () => {
  it('never takes the place of the new climb’s own tick: b1 still moves on at its rest', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    logTick('attempt');
    // A second log on a1 starts saving 8 s in; the changeover moves the wall at 10 s.
    advance(10_000);
    expect(current()).toBe('b1');

    advance(5_000);
    logTick('attempt', 'b1');
    // a1's save finishes now, 12 s after it started.
    advance(5_000);
    logTick('send', 'a1', 12_000);
    expect(getRestTimerState().lastTick).toEqual({ status: 'attempt', queueItemUuid: 'b1' });

    // b1 closes round 1: its 30 s round rest from its own tick, 15 s after the advance.
    advance(24_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b1');
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('a2');
  });

  it('in the other order, never walks b1 on by itself, and b1’s own tick still moves it on at its rest', () => {
    startWorkout(FOUR_BY_FOUR, ['a1', 'b1', 'a2', 'b2']);
    renderRuntime();
    armTimer();
    logTick('attempt');
    advance(10_000);
    expect(current()).toBe('b1');

    // a1's late save lands first.
    advance(2_000);
    logTick('send', 'a1', 4_000);
    advance(30_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b1');

    logTick('attempt', 'b1');
    advance(29_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('a2');
  });

  it('never takes the place of a send under limit bouldering either', () => {
    startWorkout(LIMIT, ['l1', 'l2', 'hand-1']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(180_000);
    expect(current()).toBe('l2');

    advance(10_000);
    logTick('send', 'l2');
    // A fall on l1, saved before the advance, finishing 20 s after it.
    advance(10_000);
    logTick('attempt', 'l1', 25_000);

    advance(169_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l2');
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-1');
  });
});

describe('yesterday’s send, logged on the climb just lit', () => {
  const A_DAY_MS = 24 * 60 * 60 * 1000;

  /** Limit: l1 sent and moved on; 2 s later the date picker logs a send a day back on l2. */
  function yesterdaysSendOnTheNewClimb() {
    startWorkout(LIMIT, ['l1', 'l2', 'hand-1']);
    renderRuntime();
    armTimer();
    logTick('send');
    advance(180_000);
    expect(current()).toBe('l2');

    advance(2_000);
    logTick('send', 'l2', A_DAY_MS);
  }

  it('never walks the wall on: it earns no advance, and no rest runs out for it', () => {
    yesterdaysSendOnTheNewClimb();
    expect(getRestTimerState().lastTick).toBeNull();
    const cuesSoFar = vi.mocked(playRestTimerCue).mock.calls.length;

    advance(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l2');
    expect(vi.mocked(playRestTimerCue).mock.calls.length).toBe(cuesSoFar);
  });

  it('a send logged now still moves it on after its whole rest', () => {
    yesterdaysSendOnTheNewClimb();

    advance(10_000);
    logTick('send', 'l2');
    advance(179_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l2');
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('hand-1');
  });
});

describe('the pacing sync', () => {
  it('never reads the queue without a workout, and leaves no stage behind one', () => {
    harness.settings = { ...harness.settings, restTimerAutoAdvance: true };
    render(<RestTimerPacingSync />);
    act(() => harness.setQueueData({ queue: [queueItem('x')], currentClimbQueueItem: queueItem('x') }));

    expect(harness.queueDataReads).toBe(0);
    expect(getRestTimerState().stagePacing).toBeNull();
  });

  it('drops the stage when the session ends', () => {
    startWorkout(LIMIT, ['l1', 'l2']);
    const { rerender } = render(<RestTimerPacingSync />);
    expect(getRestTimerState().stagePacing).toMatchObject({ stageId: 'stage-limit' });

    harness.sessionId = null;
    rerender(<RestTimerPacingSync />);
    expect(getRestTimerState().stagePacing).toBeNull();
  });
});
