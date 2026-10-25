// What a workout writes to the rest timer (#5380, #6231): the stage pacing of
// the climb on the wall, with the anchor move it calls for, and the arm at Start
// or "Add a block". The store is real; only the settings are faked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

const settingsValues = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../../settings', () => ({
  useSetting: (key: string) => [settingsValues.current[key], vi.fn()],
  getSetting: (key: string) => settingsValues.current[key],
}));

import {
  armRestTimerForWorkout,
  resetRestTimerEffectiveForTests,
  syncRestTimerStagePacing,
} from '../rest-timer-effective';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
  subscribeLocalRestTimerActions,
} from '../rest-timer-store';
import type { RestTimerStagePacing } from '../rest-timer-pacing';
import { handleCrewCadenceChange, resetCrewCadenceForTests } from '../crew-rest-cadence';
import type { SessionRestCadenceWire } from '../graphql/operations';
import { resetServerClock } from '../server-clock';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

const FOUR_BY_FOUR_PACING = {
  mode: 'afterTick',
  restSeconds: 0,
  advanceOn: 'set',
  sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
} as const;

/** A 4x4 set on the wall with `repsLogged` of its 4 reps logged. */
const fourByFourClimb = (queueItemUuid: string, repsLogged = 0): RestTimerStagePacing => ({
  sessionId: 'session-1',
  stageId: 'stage-4x4',
  kind: 'fourByFour',
  queueItemUuid,
  mode: 'afterTick',
  targetSeconds: repsLogged >= 4 ? 180 : null,
  advanceOn: 'tick',
  closesSet: repsLogged >= 4,
  reps: { logged: repsLogged, perSet: 4 },
  stagePacing: FOUR_BY_FOUR_PACING,
});

const onTheMinuteClimb = (queueItemUuid: string, intervalSeconds = 60): RestTimerStagePacing => ({
  sessionId: 'session-1',
  stageId: 'stage-emom',
  kind: 'onTheMinute',
  queueItemUuid,
  mode: 'onTheMinute',
  targetSeconds: intervalSeconds,
  advanceOn: 'deadline',
  closesSet: false,
  stagePacing: { mode: 'onTheMinute', restSeconds: intervalSeconds },
});

const TIMED_RUN: WorkoutRun = {
  stages: [
    { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'stage-limit',
      kind: 'limitBouldering',
      itemUuids: ['l1'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ],
};

const UNTIMED_RUN: WorkoutRun = {
  stages: [
    { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
    { id: 'stage-volume', kind: 'volume', itemUuids: ['v1', 'v2'], targetGrade: 18 },
  ],
};

beforeEach(() => {
  resetRestTimerStoreForTests();
  settingsValues.current = { restTimerTargetSeconds: 120, restTimerMode: 'afterTick', restTimerAutoAdvance: true };
});

describe('syncRestTimerStagePacing', () => {
  it('starts an on-the-minute beat when its first climb comes up, so climb 1 gets a whole interval', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(new Date(T0 + 240_000).toISOString(), 'afterTick', T0 + 240_000);

    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 300_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs: T0 + 300_000, stagePacing: onTheMinuteClimb('e1') });
  });

  it('keeps the beat from one on-the-minute climb to the next', () => {
    armRestTimer('onTheMinute', T0, 'session-1');
    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 5_000);
    const { anchorMs, cycleId } = getRestTimerState();

    syncRestTimerStagePacing(onTheMinuteClimb('e2'), T0 + 65_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs, cycleId, stagePacing: onTheMinuteClimb('e2') });
  });

  it('makes every new 4x4 climb wait for its own tick', () => {
    armRestTimer('afterTick', T0, 'session-1');
    syncRestTimerStagePacing(fourByFourClimb('a1'), T0);
    noteRestTimerTick(new Date(T0 + 30_000).toISOString(), 'afterTick', T0 + 30_000, {
      status: 'send',
      queueItemUuid: 'a1',
    });
    expect(getRestTimerState().anchorMs).toBe(T0 + 30_000);

    // A manual Next mid-rest: the next climb did nothing yet, so no rest runs.
    syncRestTimerStagePacing(fourByFourClimb('b1'), T0 + 35_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs: null, stagePacing: fourByFourClimb('b1') });
  });

  it('keeps the rest from each rep running as the set’s count moves on, the set rest included', () => {
    armRestTimer('afterTick', T0, 'session-1');
    const transitions: string[] = [];
    subscribeLocalRestTimerActions((action) => {
      if (action.type === 'stagePacing') transitions.push(action.transition);
    });
    syncRestTimerStagePacing(fourByFourClimb('a1'), T0);
    for (let rep = 1; rep <= 4; rep++) {
      const tickedAtMs = T0 + rep * 50_000;
      noteRestTimerTick(new Date(tickedAtMs).toISOString(), 'afterTick', tickedAtMs, {
        status: rep === 4 ? 'send' : 'attempt',
        queueItemUuid: 'a1',
      });
      // The tick log's count reaches the store one effect after the tick.
      syncRestTimerStagePacing(fourByFourClimb('a1', rep), tickedAtMs + 50);
      expect(getRestTimerState()).toMatchObject({ anchorMs: tickedAtMs, stagePacing: fourByFourClimb('a1', rep) });
    }
    expect(transitions).toEqual(['waitForTick', 'none', 'none', 'none', 'none']);
  });

  it('waits for a tick when on the minute ends into an after-tick rest', () => {
    armRestTimer('onTheMinute', T0, 'session-1');
    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0);

    syncRestTimerStagePacing(null, T0 + 600_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs: null, stagePacing: null });
  });

  it('rolls the cycle only when the anchor moves, and ignores a repeat', () => {
    armRestTimer('afterTick', T0, 'session-1');
    syncRestTimerStagePacing(fourByFourClimb('a1'), T0);
    const before = getRestTimerState();

    syncRestTimerStagePacing(fourByFourClimb('a1'), T0 + 1_000);
    syncRestTimerStagePacing(null, T0 + 2_000);
    syncRestTimerStagePacing(null, T0 + 3_000);

    expect(getRestTimerState().stagePacing).toBeNull();
    expect(getRestTimerState().cycleId).toBe(before.cycleId);
  });

  it('moves a paused timer’s anchor too, and leaves it paused', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', T0);
    pauseRestTimer(T0 + 20_000);

    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 30_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs: T0 + 30_000, isRunning: false, pausedElapsedSeconds: 0 });
  });
});

describe('armRestTimerForWorkout', () => {
  it('turns the timer on for a workout with a timed block', () => {
    expect(armRestTimerForWorkout('session-1', TIMED_RUN, T0)).toBe(true);
    expect(getRestTimerState()).toMatchObject({ armed: true, armedForSessionId: 'session-1', anchorMs: null });
  });

  it('leaves the timer off for a workout of untimed blocks', () => {
    expect(armRestTimerForWorkout('session-1', UNTIMED_RUN, T0)).toBe(false);
    expect(getRestTimerState().armed).toBe(false);
  });

  it('never re-arms a timer the climber already has running', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', T0);
    const before = getRestTimerState();

    expect(armRestTimerForWorkout('session-1', TIMED_RUN, T0 + 10_000)).toBe(false);
    expect(getRestTimerState()).toBe(before);
  });

  it('arms in the effective cadence: the stage’s once one paces the wall', () => {
    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0);

    expect(armRestTimerForWorkout('session-1', TIMED_RUN, T0 + 1_000)).toBe(true);
    expect(getRestTimerState()).toMatchObject({ armed: true, anchorMs: T0 + 1_000 });
  });
});

describe('a workout started over a crewmate’s crew clock (#5382)', () => {
  const ME = 'participant-me';
  const SAM = 'participant-sam';

  const EMOM_RUN: WorkoutRun = {
    stages: [
      { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
      {
        id: 'stage-emom',
        kind: 'onTheMinute',
        itemUuids: ['e1', 'e2'],
        pacing: { mode: 'onTheMinute', restSeconds: 60 },
      },
    ],
  };

  /** The crew clock as the session's event brings it: on the minute, anchored 20 s ago. */
  function followCrewClock(clock: Partial<SessionRestCadenceWire> = {}) {
    handleCrewCadenceChange(
      {
        restCadence: {
          mode: 'onTheMinute',
          targetSeconds: 60,
          autoAdvance: true,
          advanceOn: 'deadline',
          source: 'settings',
          isRunning: true,
          anchorAt: String(T0 - 20_000),
          pausedElapsedSeconds: 0,
          lastFiredBeatAt: null,
          lastTickQueueItemUuid: null,
          lastTickStatus: null,
          setByParticipantId: SAM,
          ...clock,
        },
        revision: 10,
        serverNow: String(T0),
        isSnapshot: false,
        action: 'ARM',
      },
      { sessionId: 'session-1', ownParticipantId: ME, receivedAtMs: T0 },
    );
  }

  function recordStageTransitions(): string[] {
    const transitions: string[] = [];
    subscribeLocalRestTimerActions((action) => {
      if (action.type === 'stagePacing') transitions.push(action.transition);
    });
    return transitions;
  }

  beforeEach(() => {
    resetCrewCadenceForTests();
    resetServerClock();
    resetRestTimerEffectiveForTests();
    // The climber's own cadence happens to match the crewmate's.
    settingsValues.current = { restTimerTargetSeconds: 60, restTimerMode: 'onTheMinute', restTimerAutoAdvance: true };
  });

  it('starts the workout’s beat on its first paced climb, not on the crewmate’s grid', () => {
    followCrewClock();
    const transitions = recordStageTransitions();
    expect(armRestTimerForWorkout('session-1', EMOM_RUN, T0)).toBe(false);

    // The warm-up has no pacing: the crew clock carries on through it.
    syncRestTimerStagePacing(null, T0 + 1_000);
    expect(getRestTimerState().anchorMs).toBe(T0 - 20_000);

    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 90_000);
    expect(transitions).toEqual(['anchorNow']);
    expect(getRestTimerState().anchorMs).toBe(T0 + 90_000);

    // Only the first: the next climb of the block keeps the beat.
    syncRestTimerStagePacing(onTheMinuteClimb('e2'), T0 + 150_000);
    expect(transitions).toEqual(['anchorNow', 'none']);
  });

  it('keeps the beat for the same climb without a workout started here', () => {
    followCrewClock();
    const transitions = recordStageTransitions();
    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 90_000);
    expect(transitions).toEqual(['none']);
    expect(getRestTimerState().anchorMs).toBe(T0 - 20_000);
  });

  it('keeps the beat of a clock this phone set: the climber’s own timer keeps going as it is', () => {
    armRestTimer('onTheMinute', T0 - 20_000, 'session-1');
    followCrewClock({ setByParticipantId: ME });
    expect(getRestTimerState().crew?.config?.setByParticipantId).toBe(ME);
    const transitions = recordStageTransitions();
    expect(armRestTimerForWorkout('session-1', EMOM_RUN, T0)).toBe(false);
    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 90_000);
    expect(transitions).toEqual(['none']);
  });

  it('makes a 4x4 started over a crewmate’s after-tick rest wait for its first tick', () => {
    followCrewClock({ mode: 'afterTick', targetSeconds: 120, anchorAt: String(T0 - 30_000) });
    const fourByFourRun: WorkoutRun = {
      stages: [
        {
          id: 'stage-4x4',
          kind: 'fourByFour',
          itemUuids: ['f1', 'f2'],
          pacing: FOUR_BY_FOUR_PACING,
        },
      ],
    };
    armRestTimerForWorkout('session-1', fourByFourRun, T0);
    syncRestTimerStagePacing(fourByFourClimb('f1'), T0 + 1_000);
    expect(getRestTimerState().anchorMs).toBeNull();
  });

  it('plans from the crew’s clock: a 1:00 stage entered from a crewmate’s 1:30 grid starts its own beat', () => {
    followCrewClock({ targetSeconds: 90 });
    const transitions = recordStageTransitions();
    syncRestTimerStagePacing(onTheMinuteClimb('e1'), T0 + 5_000);
    expect(transitions).toEqual(['anchorNow']);
    expect(getRestTimerState().anchorMs).toBe(T0 + 5_000);
  });
});
