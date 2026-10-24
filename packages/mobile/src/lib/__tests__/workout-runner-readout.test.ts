import { describe, expect, it } from 'vitest';
import { locateInRun, type WorkoutRun, type WorkoutStagePacing } from '@boardsesh/playlist-generator';
import { resolveStageRestPacing, type RestTimerLastTick } from '../rest-timer-pacing';
import type { WorkoutTickLogEntry, WorkoutTickStatus } from '../workout-run-store';
import {
  describeWorkoutRunner,
  stageHoldsUntilSent,
  workoutTryNumber,
  type WorkoutRunnerInput,
  type WorkoutRunnerRestSnapshot,
} from '../workout-runner-readout';
import { formatWorkoutStagePositionWithTry } from '../workout-run-readout';

const FOUR_BY_FOUR: WorkoutStagePacing = {
  mode: 'afterTick',
  restSeconds: 0,
  restBetweenRoundsSeconds: 180,
  advanceOn: 'tick',
};
const LIMIT: WorkoutStagePacing = { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' };
const ON_THE_MINUTE: WorkoutStagePacing = { mode: 'onTheMinute', restSeconds: 60 };

// Warm-up, a 2-climb 4x4 over 2 rounds, then 2 limit climbs.
const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1', 'w2'] },
    {
      id: 'four',
      kind: 'fourByFour',
      itemUuids: ['a', 'b', 'a2', 'b2'],
      pacing: FOUR_BY_FOUR,
      rounds: 2,
      roundByUuid: { a: 1, b: 1, a2: 2, b2: 2 },
    },
    { id: 'limit', kind: 'limitBouldering', itemUuids: ['l1', 'l2'], pacing: LIMIT },
  ],
};
const queue = ['w1', 'w2', 'a', 'b', 'a2', 'b2', 'l1', 'l2'];

const IDLE: WorkoutRunnerRestSnapshot = {
  armed: false,
  isRunning: false,
  anchorMs: null,
  lastTick: null,
  stagePacing: null,
  queueEnded: false,
};

/** The stage pacing RestTimerPacingSync would have stored for `uuid`. */
function stagePacingFor(uuid: string, workoutRun: WorkoutRun = run, queueUuids: readonly string[] = queue) {
  return resolveStageRestPacing({
    sessionId: 'session-1',
    run: workoutRun,
    position: locateInRun(workoutRun, uuid, queueUuids),
    queueItemUuid: uuid,
  });
}

/** Armed and running, with the store's stage pacing for `uuid` and the given last tick. */
function armedOn(
  uuid: string,
  lastTick: RestTimerLastTick | null,
  anchorMs: number | null = 1000,
): WorkoutRunnerRestSnapshot {
  return { armed: true, isRunning: true, anchorMs, lastTick, stagePacing: stagePacingFor(uuid), queueEnded: false };
}

let tickSecond = 0;
function tick(queueItemUuid: string, status: WorkoutTickStatus): WorkoutTickLogEntry {
  tickSecond += 1;
  return { queueItemUuid, status, climbedAt: new Date(Date.UTC(2026, 9, 24, 12, 0, tickSecond)).toISOString() };
}

function readoutFor(overrides: Partial<WorkoutRunnerInput> & Pick<WorkoutRunnerInput, 'currentUuid'>) {
  const readout = describeWorkoutRunner({
    run,
    queueUuids: queue,
    nextUuid: null,
    log: [],
    rest: IDLE,
    canAdvanceQueue: true,
    ...overrides,
  });
  if (!readout) throw new Error('expected a readout');
  return readout;
}

describe('describeWorkoutRunner', () => {
  it('is null once none of the workout is left in the queue', () => {
    expect(
      describeWorkoutRunner({
        run,
        queueUuids: ['hand-queued'],
        currentUuid: 'hand-queued',
        nextUuid: null,
        log: [],
        rest: IDLE,
        canAdvanceQueue: true,
      }),
    ).toBeNull();
  });

  describe('positions', () => {
    it('places the current climb in its round and in the whole workout', () => {
      const readout = readoutFor({ currentUuid: 'b' });

      expect(readout.position).toMatchObject({
        stageId: 'four',
        kind: 'fourByFour',
        round: { round: 1, roundCount: 2, positionInRound: 2, roundSize: 2 },
      });
      expect(readout.overall).toEqual({ position: 4, total: 8 });
      expect(readout.current).toEqual({ queueItemUuid: 'b', attempts: 0, sent: false, tryNumber: null });
    });

    it('marks the next climb as the start of the next round at a round boundary', () => {
      expect(readoutFor({ currentUuid: 'b', nextUuid: 'a2' }).next).toEqual({
        queueItemUuid: 'a2',
        stageId: 'four',
        kind: 'fourByFour',
        startsStage: false,
        startsRound: true,
      });
      expect(readoutFor({ currentUuid: 'a', nextUuid: 'b' }).next).toMatchObject({
        startsStage: false,
        startsRound: false,
      });
    });

    it('marks the next climb as the start of the next block at a block boundary', () => {
      expect(readoutFor({ currentUuid: 'b2', nextUuid: 'l1' }).next).toEqual({
        queueItemUuid: 'l1',
        stageId: 'limit',
        kind: 'limitBouldering',
        startsStage: true,
        startsRound: false,
      });
    });

    it('takes Next from the list being walked, which belongs to no stage', () => {
      expect(readoutFor({ currentUuid: 'w2', nextUuid: 'track-climb' }).next).toEqual({
        queueItemUuid: 'track-climb',
        stageId: null,
        kind: null,
        startsStage: false,
        startsRound: false,
      });
    });

    it('counts only queued climbs, in queue order, after a removal and a reorder', () => {
      const reordered = ['w1', 'a', 'b', 'w2', 'a2', 'l1', 'l2'];
      const readout = readoutFor({ queueUuids: reordered, currentUuid: 'w2' });

      expect(readout.overall).toEqual({ position: 4, total: 7 });
      expect(readout.stages.find((stage) => stage.id === 'four')?.climbs.map((climb) => climb.queueItemUuid)).toEqual([
        'a',
        'b',
        'a2',
      ]);
    });
  });

  describe('phases', () => {
    it('is climbing before the climb on the wall is logged', () => {
      expect(readoutFor({ currentUuid: 'a', rest: armedOn('a', null, null) }).phase).toBe('climbing');
    });

    it('rests after a tick on the climb on the wall, and the rest moves the wall on', () => {
      const readout = readoutFor({
        currentUuid: 'b',
        nextUuid: 'a2',
        log: [tick('b', 'send')],
        rest: armedOn('b', { status: 'send', queueItemUuid: 'b' }),
      });

      expect(readout.phase).toBe('resting');
      expect(readout.rest).toEqual({
        mode: 'afterTick',
        targetSeconds: 180,
        advanceOn: 'tick',
        advances: true,
        staysOnClimb: false,
        drivesWall: true,
        endsWorkout: false,
        closesRound: true,
        armed: true,
        paused: false,
        timing: true,
      });
    });

    it('never says the rest moves the wall on a crew phone that does not hold it', () => {
      // A passenger (or nobody holding the wall): the scheduler never calls
      // nextClimb from this phone, so the rest still times, but moves nothing.
      const readout = readoutFor({
        currentUuid: 'b',
        nextUuid: 'a2',
        log: [tick('b', 'send')],
        rest: armedOn('b', { status: 'send', queueItemUuid: 'b' }),
        canAdvanceQueue: false,
      });

      expect(readout.phase).toBe('resting');
      expect(readout.rest).toMatchObject({ advances: false, staysOnClimb: false, drivesWall: false, timing: true });
    });

    it('is not resting on a tick logged on the previous climb', () => {
      const readout = readoutFor({
        currentUuid: 'a2',
        rest: armedOn('a2', { status: 'send', queueItemUuid: 'b' }),
      });

      expect(readout.phase).toBe('climbing');
      expect(readout.rest).toMatchObject({ advances: false, staysOnClimb: true, timing: false });
    });

    it('rests after a fall on a limit climb without moving the wall, and counts the next try', () => {
      const readout = readoutFor({
        currentUuid: 'l1',
        log: [tick('l1', 'attempt')],
        rest: armedOn('l1', { status: 'attempt', queueItemUuid: 'l1' }),
      });

      expect(readout.phase).toBe('resting');
      expect(readout.rest).toMatchObject({
        advanceOn: 'send',
        advances: false,
        staysOnClimb: true,
        drivesWall: true,
        targetSeconds: 180,
      });
      expect(readout.current).toEqual({ queueItemUuid: 'l1', attempts: 1, sent: false, tryNumber: 2 });
    });

    it('keeps resting while the rest is paused', () => {
      const readout = readoutFor({
        currentUuid: 'a',
        log: [tick('a', 'send')],
        rest: { ...armedOn('a', { status: 'send', queueItemUuid: 'a' }), isRunning: false },
      });

      expect(readout.phase).toBe('resting');
      expect(readout.rest).toMatchObject({ paused: true, timing: true });
    });

    it('times every beat on the minute, logged or not', () => {
      const emom: WorkoutRun = {
        stages: [{ id: 'emom', kind: 'onTheMinute', itemUuids: ['e1', 'e2'], pacing: ON_THE_MINUTE }],
      };
      const emomQueue = ['e1', 'e2'];
      const readout = describeWorkoutRunner({
        run: emom,
        queueUuids: emomQueue,
        currentUuid: 'e1',
        nextUuid: 'e2',
        log: [],
        rest: {
          armed: true,
          isRunning: true,
          anchorMs: 1000,
          lastTick: null,
          stagePacing: stagePacingFor('e1', emom, emomQueue),
          queueEnded: false,
        },
        canAdvanceQueue: true,
      });

      expect(readout?.phase).toBe('climbing');
      expect(readout?.rest).toMatchObject({
        mode: 'onTheMinute',
        targetSeconds: 60,
        advances: true,
        endsWorkout: false,
        timing: true,
      });
    });

    describe('an on-the-minute finisher', () => {
      // A warm-up, then two climbs on the minute to end the workout.
      const emomFinish: WorkoutRun = {
        stages: [
          { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
          { id: 'emom', kind: 'onTheMinute', itemUuids: ['e1', 'e2'], pacing: ON_THE_MINUTE },
        ],
      };
      const finishQueue = ['w1', 'e1', 'e2'];
      const onTheMinuteOn = (uuid: string, queueEnded: boolean): WorkoutRunnerRestSnapshot => ({
        armed: true,
        isRunning: true,
        anchorMs: 1000,
        lastTick: null,
        stagePacing: stagePacingFor(uuid, emomFinish, finishQueue),
        queueEnded,
      });
      const finisherReadout = (queueEnded: boolean, log: WorkoutTickLogEntry[] = []) =>
        describeWorkoutRunner({
          run: emomFinish,
          queueUuids: finishQueue,
          currentUuid: 'e2',
          nextUuid: null,
          log,
          rest: onTheMinuteOn('e2', queueEnded),
          canAdvanceQueue: true,
        });

      it('counts down to the end of the workout on the last climb', () => {
        const readout = finisherReadout(false, [tick('w1', 'send')]);

        expect(readout?.phase).toBe('climbing');
        expect(readout?.rest).toMatchObject({ endsWorkout: true, timing: true });
      });

      it('is done once the last beat runs out with nothing after it, logged or not', () => {
        const readout = finisherReadout(true, [tick('w1', 'send'), tick('e1', 'send')]);

        expect(readout?.phase).toBe('done');
        expect(readout?.rest?.timing).toBe(false);
        const emomStage = readout?.stages.find((stage) => stage.id === 'emom');
        expect(emomStage?.finished).toBe(true);
        expect(emomStage?.climbs.at(-1)).toMatchObject({ queueItemUuid: 'e2', outcome: 'skipped' });
        expect(readout?.totals).toEqual({ sent: 2, tried: 0, skipped: 1, total: 3 });
      });

      it('stops the clock mid-workout once a beat finds nothing to move on to', () => {
        const readout = describeWorkoutRunner({
          run: emomFinish,
          queueUuids: finishQueue,
          currentUuid: 'e1',
          nextUuid: null,
          log: [],
          rest: onTheMinuteOn('e1', true),
          canAdvanceQueue: true,
        });

        expect(readout?.phase).toBe('climbing');
        expect(readout?.rest).toMatchObject({ endsWorkout: false, timing: false });
      });
    });

    it('says the paced stage has its timer off', () => {
      const readout = readoutFor({ currentUuid: 'a', rest: { ...IDLE, stagePacing: stagePacingFor('a') } });

      expect(readout.phase).toBe('climbing');
      expect(readout.rest).toMatchObject({ armed: false, timing: false });
    });

    it('describes no rest for a stage that keeps the climber’s own settings', () => {
      expect(readoutFor({ currentUuid: 'w1', rest: armedOn('w1', null) }).rest).toBeNull();
    });

    it('describes no rest until the store has the climb on the wall’s stage pacing', () => {
      expect(readoutFor({ currentUuid: 'a2', rest: armedOn('b', null) }).rest).toBeNull();
    });

    it('is done once the last climb meets its stage’s rule', () => {
      const lastQueue = ['a', 'b', 'a2', 'b2'];
      const fourOnly: WorkoutRun = { stages: [run.stages[1]] };
      const done = describeWorkoutRunner({
        run: fourOnly,
        queueUuids: lastQueue,
        currentUuid: 'b2',
        nextUuid: null,
        log: [tick('b2', 'attempt')],
        rest: armedOn('b2', { status: 'attempt', queueItemUuid: 'b2' }),
        canAdvanceQueue: true,
      });

      expect(done?.phase).toBe('done');
      expect(done?.rest?.timing).toBe(false);
    });

    it('is not done after a fall on the last limit climb, and is once it is sent', () => {
      const fall = readoutFor({
        currentUuid: 'l2',
        log: [tick('l2', 'attempt')],
        rest: armedOn('l2', { status: 'attempt', queueItemUuid: 'l2' }),
      });
      expect(fall.phase).toBe('resting');

      const sent = readoutFor({
        currentUuid: 'l2',
        log: [tick('l2', 'attempt'), tick('l2', 'send')],
        rest: armedOn('l2', { status: 'send', queueItemUuid: 'l2' }),
      });
      expect(sent.phase).toBe('done');
      expect(sent.current).toMatchObject({ attempts: 2, sent: true, tryNumber: null });
    });

    it('is done once the climber is past every workout climb', () => {
      const readout = readoutFor({
        queueUuids: [...queue, 'hand-queued'],
        currentUuid: 'hand-queued',
        log: [tick('l2', 'attempt')],
      });

      expect(readout.phase).toBe('done');
      expect(readout.resumeUuid).toBeNull();
    });

    it('is not done while the last workout climb, left for another one, has nothing logged', () => {
      const readout = readoutFor({ queueUuids: [...queue, 'from-search'], currentUuid: 'from-search' });

      expect(readout.phase).toBe('climbing');
      expect(readout.resumeUuid).toBe('l2');
      expect(readout.stages.find((stage) => stage.id === 'limit')?.climbs).toEqual([
        { queueItemUuid: 'l1', attempts: 0, sent: false, outcome: 'skipped' },
        { queueItemUuid: 'l2', attempts: 0, sent: false, outcome: 'upcoming' },
      ]);
    });
  });

  describe('tallies', () => {
    it('counts sent, tried and skipped per stage, and totals the stages logged on this phone', () => {
      const readout = readoutFor({
        currentUuid: 'a2',
        log: [
          tick('w1', 'flash'),
          tick('a', 'attempt'),
          tick('a', 'attempt'),
          // A hand-queued climb's tick never counts.
          tick('hand-queued', 'send'),
        ],
      });

      const byStage = Object.fromEntries(readout.stages.map((stage) => [stage.id, stage]));
      expect(byStage.warm.tally).toEqual({ sent: 1, tried: 0, skipped: 1, total: 2 });
      expect(byStage.warm.finished).toBe(true);
      expect(byStage.four.tally).toEqual({ sent: 0, tried: 1, skipped: 1, total: 4 });
      expect(byStage.four.finished).toBe(false);
      expect(byStage.four.climbs).toEqual([
        { queueItemUuid: 'a', attempts: 2, sent: false, outcome: 'tried' },
        { queueItemUuid: 'b', attempts: 0, sent: false, outcome: 'skipped' },
        { queueItemUuid: 'a2', attempts: 0, sent: false, outcome: 'upcoming' },
        { queueItemUuid: 'b2', attempts: 0, sent: false, outcome: 'upcoming' },
      ]);
      expect(byStage.limit.tally).toEqual({ sent: 0, tried: 0, skipped: 0, total: 2 });
      expect([byStage.warm.logged, byStage.four.logged, byStage.limit.logged]).toEqual([true, true, false]);
      expect(readout.totals).toEqual({ sent: 1, tried: 1, skipped: 2, total: 6 });
    });

    it('leaves a stage with nothing logged here out of the totals: it may have been logged on another phone', () => {
      // The 4x4 was logged on a partner's phone; only the limit climbs were logged here.
      const readout = readoutFor({
        currentUuid: 'l2',
        log: [tick('l1', 'send'), tick('l2', 'send')],
      });

      expect(readout.phase).toBe('done');
      const byStage = Object.fromEntries(readout.stages.map((stage) => [stage.id, stage]));
      expect(byStage.four.tally).toMatchObject({ skipped: 4 });
      expect(byStage.four.logged).toBe(false);
      expect(readout.totals).toEqual({ sent: 2, tried: 0, skipped: 0, total: 2 });
    });

    it('counts a send after falls as sent, and a climb ticked out of order where it is', () => {
      const readout = readoutFor({
        currentUuid: 'w2',
        log: [tick('l1', 'attempt'), tick('l1', 'send')],
      });

      expect(readout.stages.find((stage) => stage.id === 'limit')?.climbs[0]).toEqual({
        queueItemUuid: 'l1',
        attempts: 2,
        sent: true,
        outcome: 'sent',
      });
    });

    it('finishes every stage once the workout is done', () => {
      const readout = readoutFor({
        queueUuids: [...queue, 'hand-queued'],
        currentUuid: 'hand-queued',
        log: [tick('l2', 'send')],
      });

      expect(readout.stages.every((stage) => stage.finished)).toBe(true);
      // Only the limit block was logged here.
      expect(readout.totals).toEqual({ sent: 1, tried: 0, skipped: 1, total: 2 });
    });
  });

  describe('off the plan', () => {
    it('points at the first workout climb when Start left another climb on the wall', () => {
      const readout = readoutFor({ queueUuids: ['earlier', ...queue], currentUuid: 'earlier', nextUuid: 'w1' });

      expect(readout.position).toBeNull();
      expect(readout.overall).toBeNull();
      expect(readout.current).toBeNull();
      expect(readout.phase).toBe('climbing');
      expect(readout.resumeUuid).toBe('w1');
    });

    it('points back at the first workout climb not reached yet', () => {
      const readout = readoutFor({
        queueUuids: ['w1', 'w2', 'a', 'detour', 'b', 'a2', 'b2', 'l1', 'l2'],
        currentUuid: 'detour',
        log: [tick('w1', 'send'), tick('w2', 'send'), tick('a', 'send')],
      });

      expect(readout.resumeUuid).toBe('b');
    });

    it('points back at the workout climb the climber left unclimbed, and never counts it skipped', () => {
      // On 'a', nothing logged, the climber opens a climb from search: it goes in
      // right after 'a' and onto the wall.
      const readout = readoutFor({
        queueUuids: ['w1', 'w2', 'a', 'from-search', 'b', 'a2', 'b2', 'l1', 'l2'],
        currentUuid: 'from-search',
        log: [tick('w1', 'send'), tick('w2', 'send')],
      });

      expect(readout.resumeUuid).toBe('a');
      expect(readout.phase).toBe('climbing');
      const fourByFour = readout.stages.find((stage) => stage.id === 'four');
      expect(fourByFour?.climbs[0]).toEqual({ queueItemUuid: 'a', attempts: 0, sent: false, outcome: 'upcoming' });
      expect(fourByFour?.tally).toEqual({ sent: 0, tried: 0, skipped: 0, total: 4 });
      expect(fourByFour?.finished).toBe(false);
    });

    it('still counts the workout climbs before the one left as skipped', () => {
      const readout = readoutFor({
        queueUuids: ['w1', 'w2', 'a', 'from-search', 'b', 'a2', 'b2', 'l1', 'l2'],
        currentUuid: 'from-search',
        log: [tick('w1', 'send')],
      });

      expect(readout.resumeUuid).toBe('a');
      const warmUp = readout.stages.find((stage) => stage.id === 'warm');
      expect(warmUp?.climbs.map(({ outcome }) => outcome)).toEqual(['sent', 'skipped']);
      expect(warmUp?.finished).toBe(true);
    });

    it('counts a left climb as skipped once the climber moves on in the workout', () => {
      const readout = readoutFor({
        queueUuids: ['w1', 'w2', 'a', 'from-search', 'b', 'a2', 'b2', 'l1', 'l2'],
        currentUuid: 'b',
        log: [tick('w1', 'send'), tick('w2', 'send')],
      });

      expect(readout.stages.find((stage) => stage.id === 'four')?.climbs[0]).toMatchObject({
        queueItemUuid: 'a',
        outcome: 'skipped',
      });
    });

    it('points at the first workout climb with nothing on the wall', () => {
      expect(readoutFor({ currentUuid: null }).resumeUuid).toBe('w1');
    });

    it('has nothing to point at while the climb on the wall is in the workout', () => {
      expect(readoutFor({ currentUuid: 'a' }).resumeUuid).toBeNull();
    });
  });
});

describe('workoutTryNumber', () => {
  it('counts the try a limit climber is on, and stops once the climb is sent', () => {
    expect(workoutTryNumber(run, 'limit', 'l1', [])).toBe(1);
    expect(workoutTryNumber(run, 'limit', 'l1', [tick('l1', 'attempt'), tick('l2', 'attempt')])).toBe(2);
    expect(workoutTryNumber(run, 'limit', 'l1', [tick('l1', 'attempt'), tick('l1', 'send')])).toBeNull();
    expect(workoutTryNumber(run, 'limit', 'l1', [tick('l1', 'flash')])).toBeNull();
  });

  it('is null on a stage that moves on after any tick', () => {
    expect(workoutTryNumber(run, 'four', 'a', [tick('a', 'attempt')])).toBeNull();
    expect(workoutTryNumber(run, 'warm', 'w1', [])).toBeNull();
  });

  it('follows the stage’s advance rule, not its name', () => {
    expect(stageHoldsUntilSent({ pacing: LIMIT })).toBe(true);
    expect(stageHoldsUntilSent({ pacing: FOUR_BY_FOUR })).toBe(false);
    expect(stageHoldsUntilSent({ pacing: ON_THE_MINUTE })).toBe(false);
    expect(stageHoldsUntilSent({})).toBe(false);
    expect(stageHoldsUntilSent(undefined)).toBe(false);
  });
});

describe('formatWorkoutStagePositionWithTry', () => {
  const t = (key: string, options?: Record<string, string | number>) =>
    options
      ? `${key}(${Object.entries(options)
          .map(([name, value]) => `${name}=${value}`)
          .join(',')})`
      : key;

  it('adds the try to the stage position, and leaves it alone without one', () => {
    const position = locateInRun(run, 'l1', queue);
    if (!position) throw new Error('expected a position');

    expect(formatWorkoutStagePositionWithTry(position, 3, t)).toBe(
      'mobile.workoutRunner.positionWithTry(position=mobile.session.workoutStagePosition(stage=mobile.session.preGeneratorLimitBouldering,position=1,total=2),number=3)',
    );
    expect(formatWorkoutStagePositionWithTry(position, null, t)).toBe(
      'mobile.session.workoutStagePosition(stage=mobile.session.preGeneratorLimitBouldering,position=1,total=2)',
    );
  });
});
