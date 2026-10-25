// The rest-timer store following the crew's shared clock (#5382): adopting it,
// clearing it, and announcing only what this phone did itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewRestCadence } from '../crew-rest-cadence';
import {
  adoptCrewCadence,
  applyRestTimerStagePacing,
  armRestTimer,
  bindRestTimerToSession,
  clearCrewCadence,
  clearRestTimerQueueEnded,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerCrewBeatSkipped,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  reanchorRestTimerAfterBackground,
  resetRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
  setCrewRestPacingDraft,
  setRestTimerWallQueueItemReader,
  settleCrewRestPacingDraft,
  subscribeLocalRestTimerActions,
  type LocalRestTimerAction,
} from '../rest-timer-store';

const SESSION = 'session-1';
const T0 = Date.parse('2026-10-24T10:00:00.000Z');

function crewClock(overrides: Partial<CrewRestCadence> = {}): CrewRestCadence {
  return {
    sessionId: SESSION,
    revision: 5,
    config: {
      mode: 'afterTick',
      targetSeconds: 60,
      autoAdvance: true,
      advanceOn: 'deadline',
      source: 'settings',
      setByParticipantId: 'participant-sam',
    },
    isRunning: true,
    anchorMs: T0,
    pausedElapsedSeconds: 0,
    lastFiredBeatMs: null,
    lastTick: null,
    anchorServerMs: T0,
    lastFiredBeatServerMs: null,
    ...overrides,
  };
}

function recordActions(): LocalRestTimerAction[] {
  const actions: LocalRestTimerAction[] = [];
  subscribeLocalRestTimerActions((action) => actions.push(action));
  return actions;
}

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('adoptCrewCadence', () => {
  it('arms the timer for the crew’s session on the crew’s anchor', () => {
    adoptCrewCadence(crewClock({ lastTick: { status: 'send', queueItemUuid: 'item-1' } }));
    const state = getRestTimerState();
    expect(state.armed).toBe(true);
    expect(state.armedForSessionId).toBe(SESSION);
    expect(state.anchorMs).toBe(T0);
    expect(state.isRunning).toBe(true);
    expect(state.lastTick).toEqual({ status: 'send', queueItemUuid: 'item-1' });
    expect(state.crew?.revision).toBe(5);
  });

  it('rolls the cycle only when something the scheduler reads changed', () => {
    adoptCrewCadence(crewClock());
    const { cycleId } = getRestTimerState();
    adoptCrewCadence(crewClock({ revision: 6, lastTick: { status: 'attempt', queueItemUuid: 'item-1' } }));
    expect(getRestTimerState().cycleId).toBe(cycleId);
    adoptCrewCadence(crewClock({ revision: 7, anchorMs: T0 + 30_000, anchorServerMs: T0 + 30_000 }));
    expect(getRestTimerState().cycleId).toBe(cycleId + 1);
  });

  it('keeps the config object while the config is the same, so readers do not re-render', () => {
    adoptCrewCadence(crewClock());
    const config = getRestTimerState().crew?.config;
    adoptCrewCadence(crewClock({ revision: 6 }));
    expect(getRestTimerState().crew?.config).toBe(config);
  });

  it('keeps this phone’s own action while the server’s clock has not moved', () => {
    adoptCrewCadence(crewClock());
    resetRestTimer(T0 + 20_000);
    // An unrelated change (a crewmate's tick on the minute) lands before the reset's echo.
    adoptCrewCadence(crewClock({ revision: 6, lastTick: { status: 'send', queueItemUuid: 'item-2' } }));
    expect(getRestTimerState().anchorMs).toBe(T0 + 20_000);
    // The echo moves the server's anchor, and that wins.
    adoptCrewCadence(crewClock({ revision: 7, anchorMs: T0 + 20_050, anchorServerMs: T0 + 20_050 }));
    expect(getRestTimerState().anchorMs).toBe(T0 + 20_050);
  });

  it('lets a snapshot replace whatever this phone did meanwhile', () => {
    adoptCrewCadence(crewClock());
    pauseRestTimer(T0 + 10_000);
    adoptCrewCadence(crewClock({ revision: 1 }), { replaceLocal: true });
    expect(getRestTimerState().isRunning).toBe(true);
    expect(getRestTimerState().anchorMs).toBe(T0);
  });

  it('never lets either clock’s last advance fire again', () => {
    armRestTimer('afterTick', T0, SESSION);
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', T0);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 60_000, T0 + 60_000);
    adoptCrewCadence(crewClock({ lastFiredBeatMs: T0 + 30_000, lastFiredBeatServerMs: T0 + 30_000 }));
    expect(getRestTimerState().lastFiredDeadlineMs).toBe(T0 + 60_000);
    adoptCrewCadence(crewClock({ revision: 6, lastFiredBeatMs: T0 + 120_000, lastFiredBeatServerMs: T0 + 120_000 }));
    expect(getRestTimerState().lastFiredDeadlineMs).toBe(T0 + 120_000);
  });

  it('only holds a clock this app cannot run, leaving the timer as it was', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    adoptCrewCadence(crewClock({ config: null, anchorMs: T0 - 99_000 }));
    const state = getRestTimerState();
    expect(state.crew?.config).toBeNull();
    expect(state.anchorMs).toBe(T0);
    clearCrewCadence();
    expect(getRestTimerState().crew).toBeNull();
    expect(getRestTimerState().armed).toBe(true);
  });

  it('takes the crew’s restart as a reason to look at the queue again', () => {
    adoptCrewCadence(crewClock());
    noteRestTimerQueueEnded();
    adoptCrewCadence(crewClock({ revision: 6, anchorMs: T0 + 60_000, anchorServerMs: T0 + 60_000 }));
    expect(getRestTimerState().queueEnded).toBe(false);
  });
});

describe('clearCrewCadence', () => {
  it('turns off a timer that followed the crew’s clock', () => {
    applyRestTimerStagePacing(null, T0, 'none');
    adoptCrewCadence(crewClock());
    clearCrewCadence();
    const state = getRestTimerState();
    expect(state.armed).toBe(false);
    expect(state.crew).toBeNull();
  });

  it('does nothing without a crew clock', () => {
    armRestTimer('afterTick', T0, SESSION);
    clearCrewCadence();
    expect(getRestTimerState().armed).toBe(true);
  });
});

describe('local actions', () => {
  it('announces what this phone did, with the session it was armed for', () => {
    const actions = recordActions();
    armRestTimer('afterTick', T0, null);
    bindRestTimerToSession(SESSION);
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', T0 + 500, { status: 'send', queueItemUuid: 'item-1' });
    pauseRestTimer(T0 + 10_000);
    resumeRestTimer(T0 + 20_000);
    resetRestTimer(T0 + 30_000);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 90_000, T0 + 90_000);
    noteRestTimerQueueEnded();
    clearRestTimerQueueEnded(T0 + 100_000, 'afterTick');
    reanchorRestTimerAfterBackground(T0 + 200_000, T0 + 160_000);
    disarmRestTimer();
    expect(actions).toEqual([
      { type: 'arm', sessionId: null },
      { type: 'bound', sessionId: SESSION },
      {
        type: 'tick',
        sessionId: SESSION,
        tick: { status: 'send', queueItemUuid: 'item-1' },
        tickStartMs: T0,
        tickRecorded: true,
      },
      { type: 'pause', sessionId: SESSION, pausedElapsedSeconds: 10 },
      { type: 'resume', sessionId: SESSION },
      { type: 'reset', sessionId: SESSION, isRunning: true },
      { type: 'fired', sessionId: SESSION, anchorAfter: 'now' },
      { type: 'queueEndedCleared', sessionId: SESSION, anchorAfter: 'now' },
      { type: 'reanchored', sessionId: SESSION },
      { type: 'disarm', sessionId: SESSION },
    ]);
  });

  it('announces nothing for a crew change taken from the server', () => {
    const actions = recordActions();
    adoptCrewCadence(crewClock());
    adoptCrewCadence(crewClock({ revision: 6, anchorMs: T0 + 1, anchorServerMs: T0 + 1 }));
    clearCrewCadence();
    expect(actions).toEqual([]);
  });

  it('announces no disarm for a timer that was never on', () => {
    const actions = recordActions();
    disarmRestTimer();
    expect(actions).toEqual([]);
  });

  it('announces a stage change on the wall only while armed', () => {
    const actions = recordActions();
    const stage = {
      sessionId: SESSION,
      stageId: 'stage-1',
      kind: 'onTheMinute' as const,
      queueItemUuid: 'item-1',
      mode: 'onTheMinute' as const,
      targetSeconds: 60,
      advanceOn: 'deadline' as const,
      closesSet: false,
      stagePacing: { mode: 'onTheMinute' as const, restSeconds: 60 },
    };
    applyRestTimerStagePacing(stage, T0, 'anchorNow');
    expect(actions).toEqual([]);
    armRestTimer('afterTick', T0, SESSION);
    applyRestTimerStagePacing({ ...stage, queueItemUuid: 'item-2' }, T0 + 1_000, 'anchorNow');
    expect(actions.at(-1)).toEqual({
      type: 'stagePacing',
      sessionId: SESSION,
      transition: 'anchorNow',
      atMs: T0 + 1_000,
    });
  });
});

describe('a crew’s fixed beat', () => {
  it('is never moved by coming back from the background', () => {
    const actions = recordActions();
    adoptCrewCadence(
      crewClock({
        config: {
          mode: 'onTheMinute',
          targetSeconds: 60,
          autoAdvance: true,
          advanceOn: 'deadline',
          source: 'settings',
          setByParticipantId: 'participant-sam',
        },
      }),
    );
    reanchorRestTimerAfterBackground(T0 + 500_000, T0 + 120_000);
    expect(getRestTimerState().anchorMs).toBe(T0);
    expect(actions).toEqual([]);
  });

  it('while an after-tick crew rest restarts as it always did', () => {
    adoptCrewCadence(crewClock());
    reanchorRestTimerAfterBackground(T0 + 500_000, T0 + 60_000);
    expect(getRestTimerState().anchorMs).toBe(T0 + 500_000);
  });
});

describe('a late tick under a crew clock’s tick rule (the wall climb keeps its tick)', () => {
  const sendRule = crewClock({
    config: {
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: true,
      advanceOn: 'send',
      source: 'stage',
      setByParticipantId: 'participant-sam',
    },
    lastTick: { status: 'send', queueItemUuid: 'item-wall' },
  });

  it('keeps the wall climb’s send and leaves the rest where it is', () => {
    setRestTimerWallQueueItemReader(() => 'item-wall');
    adoptCrewCadence(sendRule);
    const actions = recordActions();
    noteRestTimerTick(new Date(T0 - 50_000).toISOString(), 'afterTick', T0 + 2_000, {
      status: 'attempt',
      queueItemUuid: 'item-previous',
    });
    const state = getRestTimerState();
    expect(state.lastTick).toEqual({ status: 'send', queueItemUuid: 'item-wall' });
    expect(state.anchorMs).toBe(T0);
    expect(actions).toEqual([expect.objectContaining({ type: 'tick', tickRecorded: false })]);
  });

  it('still takes a tick on the climb on the wall', () => {
    setRestTimerWallQueueItemReader(() => 'item-wall');
    adoptCrewCadence({ ...sendRule, lastTick: null });
    noteRestTimerTick(new Date(T0 + 5_000).toISOString(), 'afterTick', T0 + 5_000, {
      status: 'send',
      queueItemUuid: 'item-wall',
    });
    expect(getRestTimerState().lastTick).toEqual({ status: 'send', queueItemUuid: 'item-wall' });
    expect(getRestTimerState().anchorMs).toBe(T0 + 5_000);
  });

  it('judges a go whose save lands 90 s late on landing, as the server judges its TICK: not recorded', () => {
    setRestTimerWallQueueItemReader(() => 'item-wall');
    adoptCrewCadence({ ...sendRule, lastTick: null });
    const actions = recordActions();
    // Logged at T0 + 5 s, climbed then; the save lands at T0 + 95 s.
    noteRestTimerTick(
      new Date(T0 + 5_000).toISOString(),
      'afterTick',
      T0 + 95_000,
      { status: 'send', queueItemUuid: 'item-wall' },
      T0 + 5_000,
    );
    // The server reads its TICK (elapsedMs 90 s) as history, so the phone must
    // too, or it would fire beats the server refuses, one every rest.
    expect(getRestTimerState()).toMatchObject({ lastTick: null, anchorMs: T0 });
    expect(actions).toEqual([expect.objectContaining({ type: 'tick', tickRecorded: false })]);
  });

  it('takes the same late go when it lands inside a minute of its climb', () => {
    setRestTimerWallQueueItemReader(() => 'item-wall');
    adoptCrewCadence({ ...sendRule, lastTick: null });
    noteRestTimerTick(
      new Date(T0 + 5_000).toISOString(),
      'afterTick',
      T0 + 65_000,
      { status: 'send', queueItemUuid: 'item-wall' },
      T0 + 5_000,
    );
    expect(getRestTimerState()).toMatchObject({
      lastTick: { status: 'send', queueItemUuid: 'item-wall' },
      anchorMs: T0 + 5_000,
    });
  });

  it('takes every tick under the deadline rule, as before', () => {
    const reader = vi.fn(() => 'item-wall');
    setRestTimerWallQueueItemReader(reader);
    adoptCrewCadence(crewClock({ lastTick: { status: 'send', queueItemUuid: 'item-wall' } }));
    noteRestTimerTick(new Date(T0 + 5_000).toISOString(), 'afterTick', T0 + 5_000, {
      status: 'attempt',
      queueItemUuid: 'item-previous',
    });
    expect(getRestTimerState().lastTick).toEqual({ status: 'attempt', queueItemUuid: 'item-previous' });
    expect(reader).not.toHaveBeenCalled();
  });
});

const ON_THE_MINUTE: NonNullable<CrewRestCadence['config']> = {
  mode: 'onTheMinute',
  targetSeconds: 60,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
  setByParticipantId: 'participant-sam',
};

describe('a better clock offset', () => {
  it('leaves the held anchor alone for a small move, and converts it again past 250 ms', () => {
    adoptCrewCadence(crewClock());
    const { cycleId } = getRestTimerState();
    // The same server anchor, converted with an offset 100 ms better.
    adoptCrewCadence(crewClock({ revision: 6, anchorMs: T0 - 100 }));
    expect(getRestTimerState().anchorMs).toBe(T0);
    expect(getRestTimerState().cycleId).toBe(cycleId);
    // A cold start's first estimate was 4 s out.
    adoptCrewCadence(crewClock({ revision: 7, anchorMs: T0 - 4_000 }));
    expect(getRestTimerState().anchorMs).toBe(T0 - 4_000);
    expect(getRestTimerState().crew?.anchorMs).toBe(T0 - 4_000);
    expect(getRestTimerState().cycleId).toBe(cycleId + 1);
  });

  it('adds up small moves against the conversion held, not the last one seen', () => {
    adoptCrewCadence(crewClock());
    adoptCrewCadence(crewClock({ revision: 6, anchorMs: T0 - 200 }));
    adoptCrewCadence(crewClock({ revision: 7, anchorMs: T0 - 400 }));
    expect(getRestTimerState().anchorMs).toBe(T0 - 400);
  });

  it('never moves an action of this phone’s own that is waiting for its echo', () => {
    adoptCrewCadence(crewClock());
    resetRestTimer(T0 + 20_000);
    adoptCrewCadence(crewClock({ revision: 6, anchorMs: T0 - 4_000 }));
    expect(getRestTimerState().anchorMs).toBe(T0 + 20_000);
  });

  it('moves the last beat fired with the grid on the minute', () => {
    adoptCrewCadence(
      crewClock({ config: ON_THE_MINUTE, lastFiredBeatMs: T0 + 60_000, lastFiredBeatServerMs: T0 + 60_000 }),
    );
    adoptCrewCadence(
      crewClock({
        revision: 6,
        config: ON_THE_MINUTE,
        anchorMs: T0 - 4_000,
        lastFiredBeatMs: T0 + 56_000,
        lastFiredBeatServerMs: T0 + 60_000,
      }),
    );
    expect(getRestTimerState().anchorMs).toBe(T0 - 4_000);
    expect(getRestTimerState().lastFiredDeadlineMs).toBe(T0 + 56_000);
  });
});

describe('noteRestTimerCrewBeatSkipped', () => {
  it('spends a crew beat on the minute without announcing anything', () => {
    adoptCrewCadence(crewClock({ config: ON_THE_MINUTE }));
    const actions = recordActions();
    const { cycleId } = getRestTimerState();
    noteRestTimerCrewBeatSkipped(T0 + 60_000);
    expect(getRestTimerState().crewBeatSkippedMs).toBe(T0 + 60_000);
    expect(getRestTimerState().cycleId).toBe(cycleId + 1);
    expect(getRestTimerState().anchorMs).toBe(T0);
    expect(actions).toEqual([]);
    // Never back past a beat already spent.
    noteRestTimerCrewBeatSkipped(T0 + 30_000);
    expect(getRestTimerState().crewBeatSkippedMs).toBe(T0 + 60_000);
  });

  it('never records a beat the server did not take as an advance (Fable, #6757)', () => {
    // The server's last advance was T0; this phone let the T0 + 60 s beat go.
    adoptCrewCadence(crewClock({ config: ON_THE_MINUTE, lastFiredBeatMs: T0, lastFiredBeatServerMs: T0 }));
    noteRestTimerCrewBeatSkipped(T0 + 60_000);
    expect(getRestTimerState().lastFiredDeadlineMs).toBe(T0);

    // The crew switches to after the tick (anchor CLEAR): the skipped beat goes with on the minute.
    adoptCrewCadence(
      crewClock({
        revision: 6,
        anchorMs: null,
        anchorServerMs: null,
        lastFiredBeatMs: T0,
        lastFiredBeatServerMs: T0,
      }),
    );
    expect(getRestTimerState().crewBeatSkippedMs).toBeNull();

    // A fresh tick dated between the server's last advance and the skipped beat
    // starts its rest at its own time, as the server's TICK floor does, never at
    // the beat nobody took.
    noteRestTimerTick(new Date(T0 + 50_000).toISOString(), 'afterTick', T0 + 80_000, {
      status: 'send',
      queueItemUuid: 'item-1',
    });
    expect(getRestTimerState().anchorMs).toBe(T0 + 50_000);
  });

  it('leaves a rest after a tick, and a timer with no crew clock, alone', () => {
    adoptCrewCadence(crewClock());
    const before = getRestTimerState();
    noteRestTimerCrewBeatSkipped(T0 + 60_000);
    expect(getRestTimerState()).toBe(before);

    armRestTimer('onTheMinute', T0, SESSION);
    const ownTimer = getRestTimerState();
    noteRestTimerCrewBeatSkipped(T0 + 60_000);
    expect(getRestTimerState()).toBe(ownTimer);
  });
});

describe('crewPacingDraft', () => {
  const draft = {
    mode: 'afterTick' as const,
    targetSeconds: 90,
    autoAdvance: true,
    advanceOn: 'deadline' as const,
    source: 'settings' as const,
    setByParticipantId: 'participant-sam',
  };

  it('is held only while this phone follows a crew clock, and announced to the publisher', () => {
    const actions = recordActions();
    expect(setCrewRestPacingDraft(draft)).toBe(false);
    armRestTimer('afterTick', T0, SESSION);
    expect(setCrewRestPacingDraft(draft)).toBe(false);
    expect(getRestTimerState().crewPacingDraft).toBeNull();

    adoptCrewCadence(crewClock());
    expect(setCrewRestPacingDraft(draft)).toBe(true);
    expect(getRestTimerState().crewPacingDraft).toEqual(draft);
    expect(actions.at(-1)).toEqual({ type: 'crewPacingEdited', sessionId: SESSION });
  });

  it('never moves the timer itself: the crew’s config still runs it', () => {
    adoptCrewCadence(crewClock());
    const before = getRestTimerState();
    setCrewRestPacingDraft(draft);
    const after = getRestTimerState();
    expect(after.cycleId).toBe(before.cycleId);
    expect(after.anchorMs).toBe(before.anchorMs);
    expect(after.crew).toBe(before.crew);
  });

  it('goes once the crew’s config matches it, and stays through a change that does not', () => {
    adoptCrewCadence(crewClock());
    setCrewRestPacingDraft(draft);
    adoptCrewCadence(crewClock({ revision: 6, lastTick: { status: 'send', queueItemUuid: 'item-1' } }));
    expect(getRestTimerState().crewPacingDraft).toEqual(draft);
    adoptCrewCadence(crewClock({ revision: 7, config: { ...draft, setByParticipantId: 'participant-me' } }));
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });

  it('settles only the draft that was sent, never a newer one', () => {
    adoptCrewCadence(crewClock());
    setCrewRestPacingDraft({ ...draft, targetSeconds: 120 });
    settleCrewRestPacingDraft(draft);
    expect(getRestTimerState().crewPacingDraft?.targetSeconds).toBe(120);
    settleCrewRestPacingDraft({ ...draft, targetSeconds: 120 });
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });

  it('goes with the crew clock and with a disarm', () => {
    adoptCrewCadence(crewClock());
    setCrewRestPacingDraft(draft);
    clearCrewCadence();
    expect(getRestTimerState().crewPacingDraft).toBeNull();

    adoptCrewCadence(crewClock());
    setCrewRestPacingDraft(draft);
    disarmRestTimer();
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });
});
