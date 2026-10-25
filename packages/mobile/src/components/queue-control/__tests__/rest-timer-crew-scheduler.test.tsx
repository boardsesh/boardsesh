// @vitest-environment jsdom
//
// The scheduler with the crew's shared clock (#5382). The failure mode is "the
// wall moved for the whole crew when it should not have", so every case that
// moves the wall is paired with one that must not: a passenger, an unheld wall,
// a refused or lost claim, a hand-moved wall, a tick rule without its tick. The
// store, the crew module and the server clock are REAL; only the transport is
// faked, answering as the backend's reducer would.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { SetSessionRestCadencePayload } from '@boardsesh/shared-schema/generated';
import type { SessionRestCadenceWire } from '../../../lib/graphql/operations';

const nextClimb = vi.fn();
const setSessionRestCadence =
  vi.fn<
    (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<SetSessionRestCadencePayload | null>
  >();
const reportHandledError = vi.fn();
let isCrewSession = true;
let inAppBoardConnection = 'connectedByMe';
let currentQueueItemUuid = 'queue-current';
let settings: Record<string, unknown> = {};
let currentNowMs = 0;
let appStateListener: ((state: string) => void) | null = null;

vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListener = listener;
      return {
        remove: () => {
          appStateListener = null;
        },
      };
    },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  computeNavigationStateWithSuggestions: () => ({
    canNext: true,
    canPrevious: false,
    nextItem: null,
    prevItem: null,
    remainingCount: 0,
    atTrackEnd: false,
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    nextClimb,
    getQueueSnapshot: () => ({ playlistSuggestionSource: null }),
    refreshPlaylistSuggestionSource: vi.fn(),
    setSessionRestCadence,
  }),
  useQueueData: () => ({
    queue: [],
    currentClimbQueueItem: { uuid: currentQueueItemUuid, climb: { uuid: 'current' } },
  }),
  useIsCrewSession: () => isCrewSession,
  usePlaylistSuggestionSource: () => null,
}));

vi.mock('../../../lib/playlists/track-pager', () => ({ canLoadMoreOfTrack: () => false }));
vi.mock('../../play-drawer/use-track-paging', () => ({ useTrackPaging: () => {} }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1 } }),
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({ inAppBoardConnection, localConnected: false, holderDisplayName: 'Sam' }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../hooks/use-keep-awake-while', () => ({ useKeepAwakeWhile: () => {} }));
vi.mock('../../../settings', () => ({
  useSetting: (key: string) => [settings[key], vi.fn()],
  getSetting: (key: string) => settings[key],
}));
vi.mock('../../../lib/clock', () => ({ nowMs: () => currentNowMs }));
vi.mock('../../../lib/rest-timer-cues', () => ({ playRestTimerCue: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledError(...args),
}));

import { playRestTimerCue } from '../../../lib/rest-timer-cues';
import type { RestTimerCueKind } from '../../../lib/rest-timer-cues';
import { handleCrewCadenceChange, resetCrewCadenceForTests } from '../../../lib/crew-rest-cadence';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
  subscribeLocalRestTimerActions,
  type LocalRestTimerAction,
} from '../../../lib/rest-timer-store';
import { resetServerClock } from '../../../lib/server-clock';
import { RestTimerAutoAdvanceScheduler } from '../RestTimerAutoAdvanceScheduler';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const SESSION = 'session-1';
const SAM = 'participant-sam';

let revision = 10;
let serverClock: SessionRestCadenceWire;

function cueCount(kind: RestTimerCueKind): number {
  return vi.mocked(playRestTimerCue).mock.calls.filter(([cue]) => cue.kind === kind).length;
}

function advance(ms: number) {
  act(() => {
    currentNowMs += ms;
    vi.advanceTimersByTime(ms);
  });
}

async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round++) await Promise.resolve();
  });
}

/** A crewmate armed the crew clock; this phone takes it from the server (offset 0). */
function crewArmed(clock: Partial<SessionRestCadenceWire> = {}) {
  serverClock = {
    mode: 'afterTick',
    targetSeconds: 60,
    autoAdvance: true,
    advanceOn: 'deadline',
    source: 'settings',
    isRunning: true,
    anchorAt: String(currentNowMs),
    pausedElapsedSeconds: 0,
    lastFiredBeatAt: null,
    lastTickQueueItemUuid: null,
    lastTickStatus: null,
    setByParticipantId: SAM,
    ...clock,
  };
  act(() => {
    handleCrewCadenceChange(
      { restCadence: serverClock, revision, serverNow: String(currentNowMs), isSnapshot: false, action: 'ARM' },
      { sessionId: SESSION, ownParticipantId: 'participant-me', receivedAtMs: currentNowMs },
    );
  });
}

/** The server's answer to a FIRE, at the current instant. */
function fireReply({
  applied,
  clock = {},
  nextRevision = applied ? revision + 1 : revision,
  serverNowMs = currentNowMs,
}: {
  applied: boolean;
  clock?: Partial<SessionRestCadenceWire>;
  nextRevision?: number;
  serverNowMs?: number;
}): SetSessionRestCadencePayload {
  revision = nextRevision;
  serverClock = { ...serverClock, ...clock };
  return {
    applied,
    change: {
      restCadence: serverClock,
      revision,
      serverNow: String(serverNowMs),
      isSnapshot: false,
      action: applied ? 'FIRE' : null,
    },
  };
}

function fireCalls() {
  return setSessionRestCadence.mock.calls.filter(([input]) => input.action === 'FIRE');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRestTimerStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
  isCrewSession = true;
  inAppBoardConnection = 'connectedByMe';
  currentQueueItemUuid = 'queue-current';
  currentNowMs = T0;
  revision = 10;
  appStateListener = null;
  settings = { restTimerTargetSeconds: 90, restTimerAutoAdvance: false, restTimerMode: 'afterTick' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the board holder claims each beat from the server', () => {
  it('moves the wall only once the server took the beat', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { anchorAt: String(T0 + 60_000), lastFiredBeatAt: String(T0 + 60_000) } }),
    );

    advance(59_000);
    expect(fireCalls()).toHaveLength(0);
    advance(1_000);
    expect(fireCalls()).toEqual([
      [
        { action: 'FIRE', expectedRevision: 10, firedBeatAgoMs: 0 },
        { timeoutMs: 2_000, retryWhenRateLimited: false },
      ],
    ]);
    await settle();
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(cueCount('advance')).toBe(1);
    // The server's restart is the crew's next rest.
    expect(getRestTimerState().anchorMs).toBe(T0 + 60_000);
    expect(getRestTimerState().crew?.revision).toBe(11);
  });

  it('does not move the wall for a beat the server says is taken', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: false, nextRevision: 11, clock: { lastFiredBeatAt: String(T0 + 60_000) } }),
    );
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(cueCount('advance')).toBe(0);
  });

  it('lets the beat go when the FIRE gets no answer, and restarts the rest once nobody can claim it', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockRejectedValue(
      new Error("GraphQL mutation 'SetSessionRestCadence' timed out after 2000ms"),
    );
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));

    advance(60_000);
    await settle();
    expect(nextClimb).not.toHaveBeenCalled();
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(cueCount('reached')).toBe(1);

    advance(5_000);
    expect(actions).toEqual([]);
    advance(300);
    // Restarted here, and sent on as RESET by the crew publisher.
    expect(actions).toEqual([{ type: 'reanchored', sessionId: SESSION }]);
    expect(getRestTimerState().anchorMs).toBe(currentNowMs);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('does not restart the rest when the FIRE had landed after all', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockRejectedValue(new Error('timed out'));
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));
    advance(60_000);
    await settle();
    // The FIRE's own event arrives: the server took the beat and restarted the rest.
    act(() => {
      handleCrewCadenceChange(
        {
          restCadence: { ...serverClock, anchorAt: String(T0 + 60_000), lastFiredBeatAt: String(T0 + 60_000) },
          revision: 11,
          serverNow: String(currentNowMs),
          isSnapshot: false,
          action: 'FIRE',
        },
        { sessionId: SESSION, ownParticipantId: 'participant-me', receivedAtMs: currentNowMs },
      );
    });
    advance(5_300);
    expect(actions).toEqual([]);
  });
});

describe('a FIRE that never comes back', () => {
  it('is given up after 2 s, rejoin included, and the holder does not move the wall', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    // A rejoin over a dead connection: the call never settles.
    setSessionRestCadence.mockImplementation(() => new Promise(() => {}));
    advance(60_000);
    await settle();
    expect(reportHandledError).not.toHaveBeenCalled();
    advance(2_000);
    await settle();
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('lets a phone alone in its session move the wall itself after the 2 s', async () => {
    isCrewSession = false;
    inAppBoardConnection = 'disconnected';
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(() => new Promise(() => {}));
    advance(60_000);
    await settle();
    expect(nextClimb).not.toHaveBeenCalled();
    advance(2_000);
    await settle();
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('only the phone pacing the crew claims a beat', () => {
  it.each([
    ['a passenger', 'heldByPeer'],
    ['an unheld wall', 'disconnected'],
  ])('%s never claims or moves the wall, even with the crew deadline due', (_label, connection) => {
    inAppBoardConnection = connection;
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    advance(61_000);
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('hands over mid-rest: the new holder claims the same deadline once, the old one never', async () => {
    inAppBoardConnection = 'heldByPeer';
    crewArmed({ mode: 'onTheMinute' });
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(currentNowMs) } }),
    );

    advance(30_000);
    inAppBoardConnection = 'connectedByMe';
    rerender(<RestTimerAutoAdvanceScheduler />);
    advance(30_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);

    // Handed back before the next beat: this phone stays out of it.
    advance(30_000);
    inAppBoardConnection = 'heldByPeer';
    rerender(<RestTimerAutoAdvanceScheduler />);
    advance(31_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('a refusal that can still land', () => {
  it('retries the same beat on the new revision when another write landed first', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence
      // A crewmate's tick landed just before the beat: the revision moved, the beat did not.
      .mockImplementationOnce(async () =>
        fireReply({
          applied: false,
          nextRevision: 11,
          serverNowMs: currentNowMs + 100,
          clock: { lastTickStatus: 'send', lastTickQueueItemUuid: 'queue-current' },
        }),
      )
      .mockImplementationOnce(async () =>
        fireReply({ applied: true, clock: { lastFiredBeatAt: String(T0 + 60_000) } }),
      );

    advance(60_000);
    await settle();
    expect(nextClimb).not.toHaveBeenCalled();
    advance(100);
    await settle();
    expect(fireCalls().map(([input]) => input.expectedRevision)).toEqual([10, 11]);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('retries at the beat by the server’s clock when the server had not reached it yet', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    // This phone's clock runs 2.5 s ahead of the server's, and it did not know.
    setSessionRestCadence
      .mockImplementationOnce(async () => fireReply({ applied: false, serverNowMs: currentNowMs - 2_500 }))
      .mockImplementationOnce(async () =>
        fireReply({ applied: true, clock: { anchorAt: String(T0 + 60_000), lastFiredBeatAt: String(T0 + 60_000) } }),
      );

    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    advance(2_400);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    advance(100);
    await settle();
    expect(fireCalls()).toHaveLength(2);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after the bounded attempts', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: false, nextRevision: revision + 1, serverNowMs: currentNowMs }),
    );
    advance(60_000);
    for (let round = 0; round < 5; round++) {
      await settle();
      advance(10);
    }
    await settle();
    expect(fireCalls()).toHaveLength(3);
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('a phone alone in its session', () => {
  beforeEach(() => {
    isCrewSession = false;
    inAppBoardConnection = 'disconnected';
  });

  it('still lets the server take the beat first', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: false, nextRevision: 11, clock: { lastFiredBeatAt: String(T0 + 60_000) } }),
    );
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('moves the wall itself when the server cannot be reached', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockRejectedValue(new Error('socket closed'));
    advance(60_000);
    await settle();
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(getRestTimerState().lastFiredDeadlineMs).toBe(T0 + 60_000);
  });
});

describe('the wall moved while the claim was in flight', () => {
  it('spends the beat on the move rather than skipping the climb just lit', async () => {
    crewArmed();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    let answer: (payload: SetSessionRestCadencePayload) => void = () => {};
    setSessionRestCadence.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    advance(60_000);
    expect(fireCalls()).toHaveLength(1);

    currentQueueItemUuid = 'queue-next-by-hand';
    rerender(<RestTimerAutoAdvanceScheduler />);
    answer(
      fireReply({ applied: true, clock: { anchorAt: String(T0 + 60_000), lastFiredBeatAt: String(T0 + 60_000) } }),
    );
    await settle();
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('the crew clock’s advance rule', () => {
  it('claims nothing under a send rule without a send on the climb on the wall', async () => {
    crewArmed({ advanceOn: 'send', lastTickStatus: 'attempt', lastTickQueueItemUuid: 'queue-current' });
    render(<RestTimerAutoAdvanceScheduler />);
    advance(61_000);
    await settle();
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('claims the beat once the climb on the wall was sent', async () => {
    crewArmed({ advanceOn: 'send', lastTickStatus: 'send', lastTickQueueItemUuid: 'queue-current' });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { anchorAt: null, lastTickStatus: null, lastTickQueueItemUuid: null } }),
    );
    advance(60_000);
    await settle();
    expect(nextClimb).toHaveBeenCalledTimes(1);
    // The next climb waits for its own send.
    expect(getRestTimerState().anchorMs).toBeNull();
    expect(getRestTimerState().lastTick).toBeNull();
  });
});

describe('a crew clock this app cannot run', () => {
  it('never moves the wall, though this phone’s own timer would have', async () => {
    settings = { restTimerTargetSeconds: 60, restTimerAutoAdvance: true, restTimerMode: 'afterTick' };
    act(() => {
      armRestTimer('afterTick', currentNowMs, SESSION);
      noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs);
    });
    crewArmed({ mode: 'everyOtherMinute' });
    expect(getRestTimerState().crew?.config).toBeNull();
    render(<RestTimerAutoAdvanceScheduler />);
    advance(61_000);
    await settle();
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('on the minute', () => {
  it('claims every beat once', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(currentNowMs) } }),
    );
    advance(60_000);
    await settle();
    advance(60_000);
    await settle();
    expect(fireCalls().map(([input]) => input.expectedRevision)).toEqual([10, 11]);
    expect(nextClimb).toHaveBeenCalledTimes(2);
  });
});

describe('a beat the server’s spacing fence refuses (#6754)', () => {
  it('sends no FIRE on the minute for a beat 5 s after the last one taken, and claims the next', async () => {
    // A grid kept from another interval put the next beat 5 s after the last advance.
    crewArmed({ mode: 'onTheMinute', anchorAt: String(T0 - 55_000), lastFiredBeatAt: String(T0) });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(currentNowMs) } }),
    );
    advance(5_000);
    await settle();
    expect(fireCalls()).toHaveLength(0);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(cueCount('reached')).toBe(1);

    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('claims an on-the-minute beat 12 s after the last one taken', async () => {
    crewArmed({ mode: 'onTheMinute', targetSeconds: 60, anchorAt: String(T0 - 48_000), lastFiredBeatAt: String(T0) });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(currentNowMs) } }),
    );
    advance(12_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('sends no FIRE after a tick for a rest the server counts from before the last advance', async () => {
    // A CONFIGURE that reached back left the crew's anchor 10 s before its last advance.
    crewArmed({ anchorAt: String(T0 - 10_000), lastFiredBeatAt: String(T0) });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () => fireReply({ applied: true }));
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(0);
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('back from the background', () => {
  it('the holder restarts the crew’s rest instead of claiming a beat nobody watched', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));
    // The phone slept through the deadline: the clock moved, the timers did not.
    currentNowMs += 120_000;
    act(() => appStateListener?.('active'));
    expect(actions).toEqual([{ type: 'reanchored', sessionId: SESSION }]);
    advance(0);
    await settle();
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('a passenger leaves the crew’s rest alone', () => {
    inAppBoardConnection = 'heldByPeer';
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));
    currentNowMs += 120_000;
    act(() => appStateListener?.('active'));
    expect(actions).toEqual([]);
    expect(getRestTimerState().anchorMs).toBe(T0);
  });
});

describe('on the minute, a beat this phone lets go', () => {
  // Each case leaves the store as it was before the beat: only marking the beat
  // spent gets the scheduler on to the next one.
  it('still claims the next beat after a FIRE that got no answer', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockRejectedValueOnce(new Error('socket closed'));
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(cueCount('reached')).toBe(1);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(T0 + 120_000) } }),
    );
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(2);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('never floors a later after-tick rest at a beat it let go: no extra rest (Fable, #6757)', async () => {
    // The server took the beat at T0; the next beat at T0 + 60 s gets no answer here.
    crewArmed({ mode: 'onTheMinute', anchorAt: String(T0 - 60_000), lastFiredBeatAt: String(T0) });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockRejectedValueOnce(new Error('socket closed'));
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);

    // T0 + 70 s: the crew switches to a 1:00 rest after each climb, waiting for a tick.
    advance(10_000);
    revision += 1;
    serverClock = { ...serverClock, mode: 'afterTick', anchorAt: null };
    act(() => {
      handleCrewCadenceChange(
        { restCadence: serverClock, revision, serverNow: String(currentNowMs), isSnapshot: false, action: 'CONFIGURE' },
        { sessionId: SESSION, ownParticipantId: 'participant-me', receivedAtMs: currentNowMs },
      );
    });

    // T0 + 80 s: a send dated T0 + 50 s, after the server's last advance and
    // before the beat let go. The server's TICK floor starts that rest at T0 + 50 s.
    advance(10_000);
    act(() => {
      noteRestTimerTick(new Date(T0 + 50_000).toISOString(), 'afterTick', currentNowMs, {
        status: 'send',
        queueItemUuid: 'queue-current',
      });
    });
    revision += 1;
    serverClock = {
      ...serverClock,
      anchorAt: String(T0 + 50_000),
      lastTickStatus: 'send',
      lastTickQueueItemUuid: 'queue-current',
    };
    act(() => {
      handleCrewCadenceChange(
        { restCadence: serverClock, revision, serverNow: String(currentNowMs), isSnapshot: false, action: 'TICK' },
        { sessionId: SESSION, ownParticipantId: 'participant-me', receivedAtMs: currentNowMs },
      );
    });
    expect(getRestTimerState().anchorMs).toBe(T0 + 50_000);

    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { anchorAt: String(currentNowMs), lastFiredBeatAt: String(T0 + 110_000) } }),
    );
    // No FIRE before the crew's beat at T0 + 110 s...
    advance(29_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    // ...and the wall moves on it, not 7 s later on a rest floored at the beat let go.
    advance(1_000);
    await settle();
    expect(fireCalls()).toHaveLength(2);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('still claims the next beat when the climber locked the phone through one', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(T0 + 120_000) } }),
    );
    // Locked from 0:00 to 1:20: the clock moved, the timers did not.
    currentNowMs += 80_000;
    act(() => appStateListener?.('active'));
    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    await settle();
    expect(fireCalls()).toHaveLength(0);
    advance(39_000);
    expect(fireCalls()).toHaveLength(0);
    advance(1_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('still claims the next beat after the retries of one ran out', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    // The server keeps saying "not yet" at the same revision.
    setSessionRestCadence.mockImplementation(async () => fireReply({ applied: false }));
    advance(60_000);
    for (let round = 0; round < 5; round++) {
      await settle();
      advance(10);
    }
    await settle();
    expect(fireCalls()).toHaveLength(3);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(T0 + 120_000) } }),
    );
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(4);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('claims the next beat on the server’s clock after one came back too late', async () => {
    crewArmed({ mode: 'onTheMinute' });
    render(<RestTimerAutoAdvanceScheduler />);
    // The server's clock runs 6 s ahead of what this phone took it for, so the
    // FIRE lands 6 s after the beat: lost. Its round trip shows the real offset.
    setSessionRestCadence.mockImplementationOnce(async () =>
      fireReply({ applied: false, serverNowMs: currentNowMs + 6_000 }),
    );
    advance(60_000);
    await settle();
    expect(fireCalls()).toHaveLength(1);
    expect(nextClimb).not.toHaveBeenCalled();
    // The beats now land 6 s earlier on this phone: the next is at 1:54, not 2:00.
    expect(getRestTimerState().anchorMs).toBe(T0 - 6_000);
    setSessionRestCadence.mockImplementation(async () =>
      fireReply({ applied: true, clock: { lastFiredBeatAt: String(T0 + 120_000) }, serverNowMs: currentNowMs + 6_000 }),
    );
    advance(53_000);
    expect(fireCalls()).toHaveLength(1);
    advance(1_000);
    await settle();
    expect(fireCalls()).toHaveLength(2);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('a FIRE with no session to send it on', () => {
  it('lets the beat go on a crew holder’s phone', async () => {
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockResolvedValue(null);
    advance(60_000);
    await settle();
    expect(nextClimb).not.toHaveBeenCalled();
    expect(cueCount('reached')).toBe(1);
  });

  it('moves the wall from a phone alone in its session', async () => {
    isCrewSession = false;
    inAppBoardConnection = 'disconnected';
    crewArmed();
    render(<RestTimerAutoAdvanceScheduler />);
    setSessionRestCadence.mockResolvedValue(null);
    advance(60_000);
    await settle();
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('a crew rest after a tick that was already past', () => {
  it.each([
    ['a passenger', 'heldByPeer'],
    ['an unheld wall', 'disconnected'],
  ])('%s leaves it alone', (_label, connection) => {
    inAppBoardConnection = connection;
    // The deadline went 10 s ago, while nobody paced the wall.
    crewArmed({ anchorAt: String(T0 - 70_000) });
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));
    render(<RestTimerAutoAdvanceScheduler />);
    advance(10_000);
    expect(actions).toEqual([]);
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(getRestTimerState().anchorMs).toBe(T0 - 70_000);
  });

  it('is restarted once by the phone that takes the board over', () => {
    inAppBoardConnection = 'heldByPeer';
    crewArmed({ anchorAt: String(T0 - 70_000) });
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    expect(actions).toEqual([]);

    inAppBoardConnection = 'connectedByMe';
    rerender(<RestTimerAutoAdvanceScheduler />);
    // Sent on as RESET by the crew publisher; nobody's wall moves.
    expect(actions).toEqual([{ type: 'reanchored', sessionId: SESSION }]);
    expect(getRestTimerState().anchorMs).toBe(T0);
    rerender(<RestTimerAutoAdvanceScheduler />);
    advance(1_000);
    expect(actions).toHaveLength(1);
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('is restarted by the holder once nobody can claim it, when it came in just past', () => {
    // A crewmate's send logged a whole rest late: the deadline is 2 s gone.
    crewArmed({ anchorAt: String(T0 - 62_000) });
    const actions: LocalRestTimerAction[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action));
    render(<RestTimerAutoAdvanceScheduler />);
    advance(3_000);
    expect(actions).toEqual([]);
    advance(300);
    expect(actions).toEqual([{ type: 'reanchored', sessionId: SESSION }]);
    expect(setSessionRestCadence).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
  });
});
