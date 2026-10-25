// @vitest-environment jsdom
//
// The wall coming back to a climb the rest timer already moved on from (#5380
// QA, 2026-10-25). Seen on a solo live session during a backend deploy: the
// 4x4 set's rest ran out, the crew FIRE got no answer, so the phone moved the
// wall itself; that move never reached the server, the rejoin put the old
// climb back, and the session seed brought back the crew clock as the server
// still had it: the set's last rep on that climb and a rest long run out. The
// scheduler restarted that rest and moved the wall on a second time.
//
// The tick that earned a move is spent (`advancedFromQueueItemUuid`): a climb
// the timer moved the wall off never moves on again without a new tick on it.
// Every "never fires" case is paired with one where a new rep or send does.
// The scheduler, the pacing sync, the rest-timer store, the workout run and the
// crew module are REAL; the transport answers as the backend's reducer would.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { SetSessionRestCadencePayload } from '@boardsesh/shared-schema/generated';
import type { SessionRestCadenceWire } from '../../../lib/graphql/operations';

type QueueItemStub = { uuid: string; climb: { uuid: string } };

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let data = { queue: [] as QueueItemStub[], currentClimbQueueItem: null as QueueItemStub | null };
  return {
    nowMs: 0,
    settings: {} as Record<string, unknown>,
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

/** The real queue's Next: the following queue item goes up. */
const nextClimb = vi.fn(() => {
  const { queue, currentClimbQueueItem } = harness.getQueueData();
  const position = queue.findIndex((queueItem) => queueItem.uuid === currentClimbQueueItem?.uuid);
  const next = queue[position + 1];
  if (next) harness.setQueueData({ queue, currentClimbQueueItem: next });
});

const setSessionRestCadence =
  vi.fn<
    (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<SetSessionRestCadencePayload | null>
  >();

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
    useQueueActions: () => ({
      nextClimb,
      getQueueSnapshot: () => ({ playlistSuggestionSource: null }),
      refreshPlaylistSuggestionSource: vi.fn(),
      setSessionRestCadence,
    }),
    useQueueData: () => useSyncExternalStore(harness.subscribeQueueData, harness.getQueueData),
    useQueueSessionId: () => ({ sessionId: SESSION }),
    // A live session with nobody else in it: this phone is alone and moves the wall.
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
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));

import { handleCrewCadenceChange, resetCrewCadenceForTests } from '../../../lib/crew-rest-cadence';
import { isTickFreshEnoughToArm } from '../../../lib/rest-timer-auto-advance';
import type { RestTimerTickStatus } from '../../../lib/rest-timer-pacing';
import {
  armRestTimer,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { resetServerClock } from '../../../lib/server-clock';
import { noteWorkoutRunTick, resetWorkoutRunStoreForTests, setWorkoutRun } from '../../../lib/workout-run-store';
import { RestTimerAutoAdvanceScheduler } from '../RestTimerAutoAdvanceScheduler';
import { RestTimerPacingSync } from '../RestTimerPacingSync';

const SESSION = 'session-1';
const ME = 'participant-me';
const T0 = Date.parse('2026-10-25T08:50:00.000Z');

const queueItem = (uuid: string): QueueItemStub => ({ uuid, climb: { uuid: `climb-${uuid}` } });

/** The QA block: 3 reps a set, no rest between reps, 0:20 between sets. */
const FOUR_BY_FOUR: WorkoutRun = {
  stages: [
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a', 'b', 'c'],
      pacing: {
        mode: 'afterTick',
        restSeconds: 0,
        advanceOn: 'set',
        sets: { repsPerSet: 3, restBetweenSetsSeconds: 20 },
      },
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

let revision = 10;
/** The crew clock as the server holds it. */
let serverClock: SessionRestCadenceWire;

function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    const step = Math.min(1_000, ms - elapsed);
    act(() => {
      harness.nowMs += step;
      vi.advanceTimersByTime(step);
    });
  }
}

async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round++) await Promise.resolve();
  });
}

/** Seconds, a second at a time, letting each FIRE's reply land before the next second. */
async function advanceSettled(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    advance(Math.min(1_000, ms - elapsed));
    await settle();
  }
}

function current(): string | null {
  return harness.getQueueData().currentClimbQueueItem?.uuid ?? null;
}

function fireCalls() {
  return setSessionRestCadence.mock.calls.filter(([input]) => input.action === 'FIRE');
}

/** A change from the server, taken as the session subscription takes it. */
function fromServer(
  clock: Partial<SessionRestCadenceWire>,
  { isSnapshot = false, action = null as string | null } = {},
) {
  serverClock = { ...serverClock, ...clock };
  revision += 1;
  act(() => {
    handleCrewCadenceChange(
      { restCadence: serverClock, revision, serverNow: String(harness.nowMs), isSnapshot, action },
      { sessionId: SESSION, ownParticipantId: ME, receivedAtMs: harness.nowMs },
    );
  });
}

/**
 * A workout on the wall and the timer on, in a live session this phone is
 * alone in: the crew clock is this phone's own pacing, as its publisher sent it.
 */
function startWorkout(run: WorkoutRun, queueUuids: string[], pacing: Partial<SessionRestCadenceWire>) {
  const queue = queueUuids.map(queueItem);
  harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
  setWorkoutRun(SESSION, run);
  render(
    <>
      <RestTimerPacingSync />
      <RestTimerAutoAdvanceScheduler />
    </>,
  );
  act(() => armRestTimer('afterTick', harness.nowMs, SESSION));
  serverClock = {
    mode: 'afterTick',
    targetSeconds: 20,
    autoAdvance: true,
    advanceOn: 'tick',
    source: 'stage',
    isRunning: true,
    anchorAt: null,
    pausedElapsedSeconds: 0,
    lastFiredBeatAt: null,
    lastTickQueueItemUuid: null,
    lastTickStatus: null,
    setByParticipantId: ME,
    ...pacing,
  };
  fromServer({}, { action: 'ARM' });
}

/**
 * A go logged on this phone, as use-tick-saver runs it: the rest timer, the
 * workout's tick log, and the TICK the server takes for it.
 */
function logGo(status: RestTimerTickStatus, queueItemUuid: string | null = current()) {
  const climbedAt = new Date(harness.nowMs).toISOString();
  act(() => {
    noteRestTimerTick(climbedAt, 'afterTick', harness.nowMs, { status, queueItemUuid });
    if (queueItemUuid !== null && isTickFreshEnoughToArm(harness.nowMs, harness.nowMs)) {
      noteWorkoutRunTick(SESSION, { queueItemUuid, status, climbedAt });
    }
  });
  fromServer(
    { anchorAt: String(harness.nowMs), lastTickQueueItemUuid: queueItemUuid, lastTickStatus: status },
    { action: 'TICK' },
  );
}

/** The FIRE never gets an answer: the socket is going away under a deploy. */
function serverUnreachable() {
  setSessionRestCadence.mockRejectedValue(new Error('Socket closed'));
}

/** The server takes every FIRE, as its reducer does for a beat that is due. */
function serverTakesEveryFire() {
  setSessionRestCadence.mockImplementation(async (input) => {
    if (input.action !== 'FIRE') return null;
    serverClock = {
      ...serverClock,
      anchorAt: null,
      lastFiredBeatAt: String(harness.nowMs),
      lastTickQueueItemUuid: null,
      lastTickStatus: null,
    };
    revision += 1;
    return {
      applied: true,
      change: {
        restCadence: serverClock,
        revision,
        serverNow: String(harness.nowMs),
        isSnapshot: false,
        action: 'FIRE',
      },
    };
  });
}

/**
 * The reconnect after the deploy: the rejoin puts the server's climb back on
 * the wall, and the session seed brings back the server's crew clock, which
 * never saw the move.
 */
function rejoinRestoresTheServersState(wallUuid: string, clock: Partial<SessionRestCadenceWire>) {
  act(() => {
    const { queue } = harness.getQueueData();
    harness.setQueueData({ queue, currentClimbQueueItem: queue.find((item) => item.uuid === wallUuid) ?? null });
  });
  fromServer(clock, { isSnapshot: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRestTimerStoreForTests();
  resetWorkoutRunStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
  harness.nowMs = T0;
  revision = 10;
  harness.setQueueData({ queue: [], currentClimbQueueItem: null });
  harness.settings = { restTimerTargetSeconds: 60, restTimerAutoAdvance: false, restTimerMode: 'afterTick' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a 4x4 set the wall already moved on from, put back by the rejoin', () => {
  /** Fell, Sent, Fell on a; the set rest runs out with the server out of reach, and the phone moves the wall. */
  async function finishTheSetDuringTheDeploy() {
    startWorkout(FOUR_BY_FOUR, ['a', 'b', 'c'], {});
    logGo('attempt');
    logGo('send');
    logGo('attempt');
    expect(getRestTimerState().stagePacing).toMatchObject({ queueItemUuid: 'a', closesSet: true, targetSeconds: 20 });
    const lastRepAtMs = harness.nowMs;

    serverUnreachable();
    await advanceSettled(20_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');
    return lastRepAtMs;
  }

  it('never moves the wall on again: no FIRE, no restarted rest, the climb stays up', async () => {
    const lastRepAtMs = await finishTheSetDuringTheDeploy();

    // About 25 s later the rejoin puts a back, with the server's clock: the
    // set's last rep on a, and its rest run out long ago.
    await advanceSettled(25_000);
    serverTakesEveryFire();
    rejoinRestoresTheServersState('a', {
      anchorAt: String(lastRepAtMs),
      lastTickQueueItemUuid: 'a',
      lastTickStatus: 'attempt',
    });
    expect(getRestTimerState()).toMatchObject({
      lastTick: { queueItemUuid: 'a' },
      advancedFromQueueItemUuid: 'a',
      stagePacing: { queueItemUuid: 'a', closesSet: true },
    });
    const anchorAfterSeed = getRestTimerState().anchorMs;

    await advanceSettled(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(fireCalls()).toHaveLength(1);
    expect(current()).toBe('a');
    // Nothing restarted the set rest that ran out.
    expect(getRestTimerState().anchorMs).toBe(anchorAfterSeed);
  });

  it('moves on once more after a new rep on it: that go earns its own set rest', async () => {
    const lastRepAtMs = await finishTheSetDuringTheDeploy();
    await advanceSettled(25_000);
    serverTakesEveryFire();
    rejoinRestoresTheServersState('a', {
      anchorAt: String(lastRepAtMs),
      lastTickQueueItemUuid: 'a',
      lastTickStatus: 'attempt',
    });

    logGo('send');
    expect(getRestTimerState().advancedFromQueueItemUuid).toBeNull();
    await advanceSettled(19_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    await advanceSettled(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('b');
  });

  it('a seed that only restores the climb (the server cleared the tick) moves nothing either', async () => {
    await finishTheSetDuringTheDeploy();
    serverTakesEveryFire();
    rejoinRestoresTheServersState('a', { anchorAt: null, lastTickQueueItemUuid: null, lastTickStatus: null });

    await advanceSettled(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('a');
  });
});

describe('a set the server took the FIRE for, put back by a stale seed', () => {
  it('never moves on again from the climb the crew advance moved the wall off', async () => {
    startWorkout(FOUR_BY_FOUR, ['a', 'b', 'c'], {});
    logGo('attempt');
    logGo('attempt');
    logGo('send');
    const lastRepAtMs = harness.nowMs;
    serverTakesEveryFire();
    await advanceSettled(20_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');
    expect(getRestTimerState().advancedFromQueueItemUuid).toBe('a');

    await advanceSettled(10_000);
    rejoinRestoresTheServersState('a', {
      anchorAt: String(lastRepAtMs),
      lastFiredBeatAt: null,
      lastTickQueueItemUuid: 'a',
      lastTickStatus: 'send',
    });
    await advanceSettled(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('a');
  });
});

describe('limit bouldering: a send that already moved the wall on', () => {
  async function sendAndMoveOnDuringTheDeploy() {
    startWorkout(LIMIT, ['l1', 'l2'], { targetSeconds: 180, advanceOn: 'send' });
    logGo('send');
    const sentAtMs = harness.nowMs;
    serverUnreachable();
    await advanceSettled(180_000);
    expect(current()).toBe('l2');
    return sentAtMs;
  }

  it('never moves on again from the climb put back with that send', async () => {
    const sentAtMs = await sendAndMoveOnDuringTheDeploy();
    serverTakesEveryFire();
    rejoinRestoresTheServersState('l1', {
      anchorAt: String(sentAtMs),
      lastTickQueueItemUuid: 'l1',
      lastTickStatus: 'send',
    });

    await advanceSettled(600_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('l1');
  });

  it('moves on after a new send on it, once its rest runs out', async () => {
    const sentAtMs = await sendAndMoveOnDuringTheDeploy();
    serverTakesEveryFire();
    rejoinRestoresTheServersState('l1', {
      anchorAt: String(sentAtMs),
      lastTickQueueItemUuid: 'l1',
      lastTickStatus: 'send',
    });

    logGo('send');
    await advanceSettled(179_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    await advanceSettled(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('l2');
  });
});

describe('with no crew clock', () => {
  const localGo = (status: RestTimerTickStatus) =>
    act(() => {
      const climbedAt = new Date(harness.nowMs).toISOString();
      noteRestTimerTick(climbedAt, 'afterTick', harness.nowMs, { status, queueItemUuid: current() });
      noteWorkoutRunTick(SESSION, { queueItemUuid: current() ?? '', status, climbedAt });
    });

  /** The 4x4 on the wall with the timer on, and no crew clock. Returns the queue. */
  function startLocalWorkout(): QueueItemStub[] {
    const queue = ['a', 'b', 'c'].map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    setWorkoutRun(SESSION, FOUR_BY_FOUR);
    render(
      <>
        <RestTimerPacingSync />
        <RestTimerAutoAdvanceScheduler />
      </>,
    );
    act(() => armRestTimer('afterTick', harness.nowMs, SESSION));
    return queue;
  }

  it('a rep after the timer was turned off and on again earns the set rest and one advance', () => {
    const queue = startLocalWorkout();
    localGo('attempt');
    localGo('send');
    localGo('attempt');
    advance(20_000);
    expect(current()).toBe('b');
    expect(getRestTimerState().advancedFromQueueItemUuid).toBe('a');

    // a comes back, and the climber turns the timer off and on again: nothing
    // moves until a rep, and the old mark never holds that rep back.
    act(() => harness.setQueueData({ queue, currentClimbQueueItem: queue[0] }));
    act(() => disarmRestTimer());
    act(() => armRestTimer('afterTick', harness.nowMs, SESSION));
    expect(getRestTimerState().advancedFromQueueItemUuid).toBeNull();
    advance(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('a');

    localGo('send');
    advance(19_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('b');
    advance(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
  });

  it('a climb put back after the move never moves on again, and moves on after a new rep', async () => {
    const queue = startLocalWorkout();
    localGo('attempt');
    localGo('send');
    localGo('attempt');
    advance(20_000);
    expect(current()).toBe('b');

    act(() => harness.setQueueData({ queue, currentClimbQueueItem: queue[0] }));
    advance(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('a');

    localGo('send');
    advance(20_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('b');
  });
});
