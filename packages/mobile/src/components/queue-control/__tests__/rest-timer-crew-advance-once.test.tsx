// @vitest-environment jsdom
//
// A crew 4x4 moves the wall once per set (#5382, #5380; Marco, 2026-10-25).
// The crew's rest clock lives on the server and counts no reps: the phone that
// built the workout counts them, and hands the server each rest as it comes.
// Between reps the clock never moves the wall; after a set's last rep the set
// rest goes out with auto-advance on and `autoAdvanceOnce`, so the server's
// FIRE that takes its beat moves the wall and turns auto-advance off in the
// same write. If the builder's phone then sleeps, the wall waits instead of
// moving on after the next set's first rep.
//
// Every case that moves the wall is paired with one that must not. The
// scheduler, the pacing sync, the crew publisher, the rest-timer store, the
// workout run and the crew module are REAL; the transport is a small server
// that answers as the backend's reducer does (packages/backend/src/services/
// rest-cadence.ts) for the actions these flows send.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { SessionRestCadenceInput, SetSessionRestCadencePayload } from '@boardsesh/shared-schema/generated';
import type { SessionRestCadenceWire } from '../../../lib/graphql/operations';

type QueueItemStub = { uuid: string; climb: { uuid: string } };

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let data = { queue: [] as QueueItemStub[], currentClimbQueueItem: null as QueueItemStub | null };
  return {
    nowMs: 0,
    settings: {} as Record<string, unknown>,
    isCrewSession: true,
    inAppBoardConnection: 'connectedByMe',
    appStateListener: null as ((state: string) => void) | null,
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

const setSessionRestCadence = vi.fn<(input: SessionRestCadenceInput) => Promise<SetSessionRestCadencePayload | null>>();

vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appStateListener = listener;
      return {
        remove: () => {
          harness.appStateListener = null;
        },
      };
    },
  },
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
      getQueueSnapshot: () => ({ ...harness.getQueueData(), playlistSuggestionSource: null }),
      refreshPlaylistSuggestionSource: vi.fn(),
      setSessionRestCadence,
    }),
    useQueueData: () => useSyncExternalStore(harness.subscribeQueueData, harness.getQueueData),
    useQueueSessionId: () => ({ sessionId: SESSION }),
    useQueueSessionControls: () => ({ participantId: ME }),
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
    holderDisplayName: harness.inAppBoardConnection === 'heldByPeer' ? 'Sam' : null,
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
import type { RestTimerTickStatus } from '../../../lib/rest-timer-pacing';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { resetServerClock } from '../../../lib/server-clock';
import { noteWorkoutRunTick, resetWorkoutRunStoreForTests, setWorkoutRun } from '../../../lib/workout-run-store';
import { RestTimerAutoAdvanceScheduler } from '../RestTimerAutoAdvanceScheduler';
import { RestTimerCrewPublisher } from '../RestTimerCrewPublisher';
import { RestTimerPacingSync } from '../RestTimerPacingSync';

const SESSION = 'session-1';
const ME = 'participant-me';
const SAM = 'participant-sam';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

const queueItem = (uuid: string): QueueItemStub => ({ uuid, climb: { uuid: `climb-${uuid}` } });

/** Two sets (a, then b) of two reps, 0:15 between reps, 0:30 between sets; then limit bouldering. */
const FOUR_BY_FOUR_THEN_LIMIT: WorkoutRun = {
  stages: [
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a', 'b'],
      pacing: {
        mode: 'afterTick',
        restSeconds: 15,
        advanceOn: 'set',
        sets: { repsPerSet: 2, restBetweenSetsSeconds: 30 },
      },
    },
    {
      id: 'stage-limit',
      kind: 'limitBouldering',
      itemUuids: ['l1', 'l2'],
      pacing: { mode: 'afterTick', restSeconds: 60, advanceOn: 'send' },
    },
  ],
};
const QUEUE = ['a', 'b', 'l1', 'l2'];

// ---------------------------------------------------------------------------
// The server: the crew clock as the backend's reducer keeps it
// ---------------------------------------------------------------------------

type ServerClock = {
  mode: 'afterTick' | 'onTheMinute';
  targetSeconds: number | null;
  autoAdvance: boolean;
  autoAdvanceOnce: boolean;
  advanceOn: 'deadline' | 'tick' | 'send';
  source: 'settings' | 'stage';
  isRunning: boolean;
  anchorMs: number | null;
  pausedElapsedSeconds: number;
  lastFiredBeatMs: number | null;
  lastTick: { queueItemUuid: string; status: string } | null;
  setBy: string;
};

const server = {
  clock: null as ServerClock | null,
  revision: 10,
  /** Every FIRE goes unanswered: the socket is going away. */
  unreachableForFire: false,
};

function toWire(clock: ServerClock | null): SessionRestCadenceWire | null {
  if (clock === null) return null;
  return {
    mode: clock.mode,
    targetSeconds: clock.targetSeconds,
    autoAdvance: clock.autoAdvance,
    autoAdvanceOnce: clock.autoAdvanceOnce,
    advanceOn: clock.advanceOn,
    source: clock.source,
    isRunning: clock.isRunning,
    anchorAt: clock.anchorMs === null ? null : String(clock.anchorMs),
    pausedElapsedSeconds: clock.pausedElapsedSeconds,
    lastFiredBeatAt: clock.lastFiredBeatMs === null ? null : String(clock.lastFiredBeatMs),
    lastTickQueueItemUuid: clock.lastTick?.queueItemUuid ?? null,
    lastTickStatus: clock.lastTick?.status ?? null,
    setByParticipantId: clock.setBy,
  };
}

function configFrom(input: SessionRestCadenceInput, setBy: string): Partial<ServerClock> {
  const config = input.config;
  if (!config) throw new Error(`${input.action} without a config`);
  return {
    mode: config.mode as ServerClock['mode'],
    targetSeconds: config.targetSeconds ?? null,
    autoAdvance: config.autoAdvance,
    // A CONFIGURE without it clears it.
    autoAdvanceOnce: config.autoAdvanceOnce === true,
    advanceOn: config.advanceOn as ServerClock['advanceOn'],
    source: config.source as ServerClock['source'],
    setBy,
  };
}

/** One action, as the reducer applies it. Null: not applied, nothing written. */
function reduce(clock: ServerClock | null, input: SessionRestCadenceInput, setBy: string): ServerClock | null | false {
  const now = harness.nowMs;
  switch (input.action) {
    case 'ARM':
      return {
        ...(configFrom(input, setBy) as ServerClock),
        isRunning: true,
        anchorMs: input.elapsedMs == null ? null : now - input.elapsedMs,
        pausedElapsedSeconds: 0,
        lastFiredBeatMs: null,
        lastTick: null,
      };
    case 'DISARM':
      return null;
    case 'CONFIGURE': {
      if (clock === null) return false;
      const anchorMs =
        input.anchor === 'NOW' ? now - (input.elapsedMs ?? 0) : input.anchor === 'CLEAR' ? null : clock.anchorMs;
      return { ...clock, ...configFrom(input, setBy), anchorMs };
    }
    case 'TICK': {
      if (clock === null) return false;
      const tickAnchorMs = now - (input.elapsedMs ?? 0);
      const anchorMs = Math.min(
        now,
        Math.max(tickAnchorMs, clock.anchorMs ?? tickAnchorMs, clock.lastFiredBeatMs ?? tickAnchorMs),
      );
      const lastTick =
        input.tickQueueItemUuid && input.tickStatus
          ? { queueItemUuid: input.tickQueueItemUuid, status: input.tickStatus }
          : clock.lastTick;
      return { ...clock, anchorMs, isRunning: true, lastTick };
    }
    case 'FIRE': {
      if (clock === null || input.expectedRevision !== server.revision) return false;
      if (!clock.isRunning || !clock.autoAdvance || clock.anchorMs === null || clock.targetSeconds === null) {
        return false;
      }
      const beatMs = clock.anchorMs + clock.targetSeconds * 1000;
      if (now < beatMs - 2_000 || now > beatMs + 5_000) return false;
      if (clock.lastFiredBeatMs !== null && beatMs <= clock.lastFiredBeatMs) return false;
      // A once-only clock spends its advance in the same write.
      const spent = clock.autoAdvanceOnce ? { autoAdvance: false, autoAdvanceOnce: false } : {};
      return clock.advanceOn === 'deadline'
        ? { ...clock, ...spent, lastFiredBeatMs: beatMs, anchorMs: Math.max(now, beatMs) }
        : { ...clock, ...spent, lastFiredBeatMs: beatMs, anchorMs: null, lastTick: null };
    }
    case 'RESET':
      if (clock === null) return false;
      return { ...clock, anchorMs: now, lastTick: null };
    default:
      throw new Error(`The test server does not take ${input.action}`);
  }
}

function serverChange(applied: boolean, action: string | null): SetSessionRestCadencePayload {
  return {
    applied,
    change: {
      restCadence: toWire(server.clock),
      revision: server.revision,
      serverNow: String(harness.nowMs),
      isSnapshot: false,
      action: applied ? (action as SetSessionRestCadencePayload['change']['action']) : null,
    },
  };
}

/** Apply one input on the server, by `setBy`. */
function serverApply(input: SessionRestCadenceInput, setBy: string): SetSessionRestCadencePayload {
  const next = reduce(server.clock, input, setBy);
  if (next === false) return serverChange(false, null);
  server.clock = next;
  server.revision += 1;
  return serverChange(true, input.action);
}

/** This phone's sends: the publisher's and the scheduler's FIREs. */
function serverAnswersThisPhone() {
  setSessionRestCadence.mockImplementation(async (input) => {
    if (input.action === 'FIRE' && server.unreachableForFire) throw new Error('Socket closed');
    return serverApply(input, ME);
  });
}

/** Sam's phone changed the clock; the subscription brings it here. */
function samSends(input: SessionRestCadenceInput) {
  const { change } = serverApply(input, SAM);
  act(() => {
    handleCrewCadenceChange(change, { sessionId: SESSION, ownParticipantId: ME, receivedAtMs: harness.nowMs });
  });
}

// ---------------------------------------------------------------------------
// Driving the phone
// ---------------------------------------------------------------------------

function advance(ms: number) {
  act(() => {
    harness.nowMs += ms;
    vi.advanceTimersByTime(ms);
  });
}

async function settle() {
  await act(async () => {
    for (let round = 0; round < 20; round++) await Promise.resolve();
  });
}

/** Seconds, a second at a time, letting every send and reply land before the next second. */
async function advanceSettled(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    advance(Math.min(1_000, ms - elapsed));
    await settle();
  }
}

function current(): string | null {
  return harness.getQueueData().currentClimbQueueItem?.uuid ?? null;
}

function sentActions(): string[] {
  return setSessionRestCadence.mock.calls.map(([input]) => input.action);
}

function fireCount(): number {
  return sentActions().filter((action) => action === 'FIRE').length;
}

function configuresSent(): NonNullable<SessionRestCadenceInput['config']>[] {
  return setSessionRestCadence.mock.calls
    .map(([input]) => input)
    .filter((input) => input.action === 'CONFIGURE')
    .map((input) => {
      if (!input.config) throw new Error('CONFIGURE without a config');
      return input.config;
    });
}

function renderPhone() {
  render(
    <>
      <RestTimerPacingSync />
      <RestTimerAutoAdvanceScheduler />
      <RestTimerCrewPublisher />
    </>,
  );
}

/** The workout built on this phone, on the wall, and the timer turned on: its ARM is the crew's clock. */
async function startWorkoutHere() {
  const queue = QUEUE.map(queueItem);
  harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
  setWorkoutRun(SESSION, FOUR_BY_FOUR_THEN_LIMIT);
  renderPhone();
  act(() => armRestTimer('afterTick', harness.nowMs, SESSION));
  await settle();
}

/**
 * A go logged on this phone, as use-tick-saver runs it: the rest timer, the
 * workout's tick log (a 4x4 rep), and so the TICK the publisher sends.
 */
async function logGo(status: RestTimerTickStatus, queueItemUuid: string | null = current()) {
  const climbedAt = new Date(harness.nowMs).toISOString();
  act(() => {
    noteRestTimerTick(climbedAt, 'afterTick', harness.nowMs, { status, queueItemUuid });
    if (queueItemUuid !== null) noteWorkoutRunTick(SESSION, { queueItemUuid, status, climbedAt });
  });
  await settle();
}

/** The publisher's debounce, and the CONFIGURE behind it. */
async function letTheConfigureGo() {
  await advanceSettled(1_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRestTimerStoreForTests();
  resetWorkoutRunStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
  harness.nowMs = T0;
  harness.isCrewSession = true;
  harness.inAppBoardConnection = 'connectedByMe';
  harness.appStateListener = null;
  harness.settings = {
    restTimerTargetSeconds: 90,
    restTimerAutoAdvance: false,
    restTimerMode: 'afterTick',
    restTimerCountdownCues: true,
  };
  harness.setQueueData({ queue: [], currentClimbQueueItem: null });
  server.clock = null;
  server.revision = 10;
  server.unreachableForFire = false;
  serverAnswersThisPhone();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the builder holds the wall in a crew', () => {
  /** Both reps of the set on the wall; returns when the last one was logged. */
  async function climbTheSet() {
    await logGo('attempt');
    await letTheConfigureGo();
    // The rest between reps runs out: the climb stays up for the next rep.
    await advanceSettled(20_000);
    expect(fireCount()).toBe(0);
    await logGo('send');
    await letTheConfigureGo();
  }

  it('never moves the wall between reps, and the crew clock holds auto-advance off for them', async () => {
    await startWorkoutHere();
    expect(server.clock).toMatchObject({ autoAdvance: false, autoAdvanceOnce: false, targetSeconds: 15 });
    await logGo('attempt');
    await advanceSettled(120_000);
    expect(fireCount()).toBe(0);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(current()).toBe('a');
  });

  it('sends the set rest once-only after the last rep, and the server moves the wall once', async () => {
    await startWorkoutHere();
    await climbTheSet();
    expect(configuresSent().at(-1)).toEqual({
      mode: 'afterTick',
      targetSeconds: 30,
      autoAdvance: true,
      autoAdvanceOnce: true,
      advanceOn: 'tick',
      source: 'stage',
    });
    expect(server.clock).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true });

    await advanceSettled(29_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(fireCount()).toBe(1);
    expect(current()).toBe('b');
    // The FIRE spent it: the crew clock stops advancing until the next set says so.
    expect(server.clock).toMatchObject({ autoAdvance: false, autoAdvanceOnce: false });
    expect(getRestTimerState().crew?.config).toMatchObject({ autoAdvance: false });
  });

  it('goes back to no advance for the next set’s reps, then moves on once after that set too', async () => {
    await startWorkoutHere();
    await climbTheSet();
    await advanceSettled(30_000);
    expect(current()).toBe('b');
    expect(configuresSent().at(-1)).toEqual({
      mode: 'afterTick',
      targetSeconds: 15,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    });

    await logGo('send');
    await advanceSettled(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');

    await logGo('attempt');
    await letTheConfigureGo();
    expect(server.clock).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true, targetSeconds: 30 });
    await advanceSettled(30_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('l1');
  });

  it('hands the limit block after it a clock that moves on after every send, with no once-only advance', async () => {
    await startWorkoutHere();
    await climbTheSet();
    await advanceSettled(30_000);
    await logGo('send');
    await logGo('send');
    await letTheConfigureGo();
    await advanceSettled(30_000);
    expect(current()).toBe('l1');
    await letTheConfigureGo();
    expect(server.clock).toMatchObject({
      advanceOn: 'send',
      autoAdvance: true,
      autoAdvanceOnce: false,
      targetSeconds: 60,
    });
    expect(configuresSent().at(-1)).not.toHaveProperty('autoAdvanceOnce');

    await logGo('send');
    await advanceSettled(61_000);
    expect(current()).toBe('l2');
    // The limit block's advance left auto-advance on: it moves on after every send.
    expect(server.clock).toMatchObject({ autoAdvance: true });
  });

  it('keeps the set rest once-only when it restarts after the background, and still moves on once', async () => {
    await startWorkoutHere();
    await climbTheSet();
    // The phone sleeps through the set rest's end: no timer ran meanwhile.
    act(() => {
      harness.nowMs += 60_000;
    });
    act(() => harness.appStateListener?.('active'));
    await settle();
    // The restart re-sends the clock it holds: still once-only.
    expect(configuresSent().at(-1)).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true, targetSeconds: 30 });
    expect(server.clock).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true, anchorMs: harness.nowMs });
    expect(nextClimb).not.toHaveBeenCalled();

    await advanceSettled(31_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');
    expect(server.clock).toMatchObject({ autoAdvance: false });
  });
});

describe('the board holder does not have the workout (the builder’s phone is asleep)', () => {
  /** Sam built the 4x4 and logged the set's last rep; this phone holds the wall and follows Sam's clock. */
  function samsSetRest({ once }: { once: boolean }) {
    const queue = QUEUE.map(queueItem);
    harness.setQueueData({ queue, currentClimbQueueItem: queue[0] });
    renderPhone();
    samSends({
      action: 'ARM',
      config: { mode: 'afterTick', targetSeconds: 15, autoAdvance: false, advanceOn: 'tick', source: 'stage' },
    });
    samSends({ action: 'TICK', tickQueueItemUuid: 'a', tickStatus: 'send', elapsedMs: 0 });
    samSends({
      action: 'CONFIGURE',
      anchor: 'KEEP',
      config: {
        mode: 'afterTick',
        targetSeconds: 30,
        autoAdvance: true,
        ...(once ? { autoAdvanceOnce: true } : {}),
        advanceOn: 'tick',
        source: 'stage',
      },
    });
  }

  it('moves the wall once at the end of the set rest, then waits through the next set’s first rep', async () => {
    samsSetRest({ once: true });
    expect(getRestTimerState().crew?.config).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true });
    await advanceSettled(30_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');

    // Sam's phone sleeps: nobody hands the crew the next set. A rep on b here
    // starts a rest that runs out and leaves b up.
    await logGo('send');
    expect(server.clock).toMatchObject({ lastTick: { queueItemUuid: 'b' }, autoAdvance: false });
    await advanceSettled(120_000);
    expect(fireCount()).toBe(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');
  });

  it('without the flag (an older builder) moves on again after the next set’s first rep', async () => {
    samsSetRest({ once: false });
    await advanceSettled(30_000);
    expect(current()).toBe('b');
    await logGo('send');
    await advanceSettled(31_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('l1');
  });

  it('moves on again once the builder’s phone sends the next set rest', async () => {
    samsSetRest({ once: true });
    await advanceSettled(30_000);
    expect(current()).toBe('b');
    await logGo('attempt');
    await advanceSettled(60_000);
    expect(current()).toBe('b');

    // Sam's phone wakes and counts the set done on b.
    samSends({
      action: 'CONFIGURE',
      anchor: 'KEEP',
      config: {
        mode: 'afterTick',
        targetSeconds: 30,
        autoAdvance: true,
        autoAdvanceOnce: true,
        advanceOn: 'tick',
        source: 'stage',
      },
    });
    await logGo('send');
    await advanceSettled(31_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
    expect(current()).toBe('l1');
  });
});

describe('the builder is a passenger', () => {
  it('sends the set rest once-only and never moves the wall itself', async () => {
    harness.inAppBoardConnection = 'heldByPeer';
    await startWorkoutHere();
    await logGo('attempt');
    await logGo('send');
    await letTheConfigureGo();
    expect(configuresSent().at(-1)).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true, targetSeconds: 30 });

    await advanceSettled(120_000);
    expect(fireCount()).toBe(0);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('hands the next set back to no advance when the holder’s FIRE moves the wall', async () => {
    harness.inAppBoardConnection = 'heldByPeer';
    await startWorkoutHere();
    await logGo('attempt');
    await logGo('send');
    await letTheConfigureGo();

    // Sam holds the wall: his FIRE takes the set rest's beat and moves the queue.
    await advanceSettled(29_000);
    samSends({ action: 'FIRE', expectedRevision: server.revision });
    expect(server.clock).toMatchObject({ autoAdvance: false, autoAdvanceOnce: false });
    act(() => {
      const { queue } = harness.getQueueData();
      harness.setQueueData({ queue, currentClimbQueueItem: queue[1] });
    });
    await letTheConfigureGo();
    expect(configuresSent().at(-1)).toEqual({
      mode: 'afterTick',
      targetSeconds: 15,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    });
    await advanceSettled(120_000);
    expect(fireCount()).toBe(0);
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('alone in the session, with the server out of reach for the FIRE', () => {
  it('moves the wall once itself and spends the once-only advance on the server too', async () => {
    harness.isCrewSession = false;
    await startWorkoutHere();
    await logGo('attempt');
    await logGo('send');
    await letTheConfigureGo();
    server.unreachableForFire = true;

    await advanceSettled(30_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');
    await letTheConfigureGo();
    // The move made here goes to the server as auto-advance off, then the next set's pacing.
    const [spent, nextSet] = configuresSent().slice(-2);
    expect(spent).toEqual({
      mode: 'afterTick',
      targetSeconds: 30,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    });
    expect(nextSet).toEqual({
      mode: 'afterTick',
      targetSeconds: 15,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    });
    expect(server.clock).toMatchObject({ autoAdvance: false, autoAdvanceOnce: false });

    server.unreachableForFire = false;
    await logGo('send');
    await advanceSettled(120_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(current()).toBe('b');
  });
});
