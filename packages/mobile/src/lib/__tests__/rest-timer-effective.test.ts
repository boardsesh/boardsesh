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

import { armRestTimerForWorkout, syncRestTimerStagePacing } from '../rest-timer-effective';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
} from '../rest-timer-store';
import type { RestTimerStagePacing } from '../rest-timer-pacing';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

const fourByFourClimb = (queueItemUuid: string, closesRound = false): RestTimerStagePacing => ({
  sessionId: 'session-1',
  stageId: 'stage-4x4',
  kind: 'fourByFour',
  queueItemUuid,
  mode: 'afterTick',
  targetSeconds: closesRound ? 180 : 10,
  advanceOn: 'tick',
  closesRound,
  stagePacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 180, advanceOn: 'tick' },
});

const onTheMinuteClimb = (queueItemUuid: string, intervalSeconds = 60): RestTimerStagePacing => ({
  sessionId: 'session-1',
  stageId: 'stage-emom',
  kind: 'onTheMinute',
  queueItemUuid,
  mode: 'onTheMinute',
  targetSeconds: intervalSeconds,
  advanceOn: 'deadline',
  closesRound: false,
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
    syncRestTimerStagePacing(fourByFourClimb('b1', true), T0 + 35_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs: null, stagePacing: fourByFourClimb('b1', true) });
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
