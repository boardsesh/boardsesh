import { describe, expect, it } from 'vitest';
import { WORKOUT_STAGE_KINDS, type WorkoutRun } from '@boardsesh/playlist-generator';
import {
  describeWorkoutRun,
  formatWorkoutStageParts,
  formatWorkoutStagePosition,
  formatWorkoutStagePositionWithGo,
  workoutStageName,
} from '../workout-run-readout';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1', 'w2'] },
    { id: 'main', kind: 'pyramid', itemUuids: ['m1', 'm2', 'm3'] },
  ],
};

// Echoes the key and its options so the assertions read the inputs directly.
const t = (key: string, options?: Record<string, string | number>) =>
  options
    ? `${key}(${Object.entries(options)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')})`
    : key;

describe('describeWorkoutRun', () => {
  it('marks the current stage and counts what is left in it', () => {
    const readout = describeWorkoutRun(run, ['w1', 'w2', 'm1', 'm2', 'm3'], 'm1');

    expect(readout?.stages).toEqual([
      { id: 'warm', kind: 'warmUp', size: 2, isCurrent: false, remainingAfterCurrent: null, isCoolDown: false },
      { id: 'main', kind: 'pyramid', size: 3, isCurrent: true, remainingAfterCurrent: 2, isCoolDown: false },
    ]);
    expect(readout?.current).toMatchObject({ stageId: 'main', positionInStage: 1, stageSize: 3 });
  });

  it('orders stages the way the queue does after the climber moves one', () => {
    const readout = describeWorkoutRun(run, ['m1', 'm2', 'm3', 'w1', 'w2'], null);

    expect(readout?.stages.map((stage) => stage.id)).toEqual(['main', 'warm']);
    expect(readout?.current).toBeNull();
  });

  it('counts only climbs still queued and hides stages with none', () => {
    const readout = describeWorkoutRun(run, ['m2', 'hand-queued'], 'hand-queued');

    expect(readout?.stages).toEqual([
      { id: 'main', kind: 'pyramid', size: 1, isCurrent: false, remainingAfterCurrent: null, isCoolDown: false },
    ]);
    expect(readout?.current).toBeNull();
  });

  it('is null once none of the workout is left in the queue', () => {
    expect(describeWorkoutRun(run, ['hand-queued'], 'hand-queued')).toBeNull();
  });
});

describe('cool-downs', () => {
  const coolDownRun: WorkoutRun = {
    stages: [
      { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
      { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] },
      { id: 'cool', kind: 'warmUp', itemUuids: ['c1', 'c2', 'c3'], coolDown: true },
    ],
  };
  const queue = ['w1', 'm1', 'm2', 'c1', 'c2', 'c3'];

  it('flags the warm-up planned as a cool-down, and only that one', () => {
    const readout = describeWorkoutRun(coolDownRun, queue, 'c2');

    expect(readout?.stages.map((stage) => [stage.id, stage.isCoolDown])).toEqual([
      ['warm', false],
      ['main', false],
      ['cool', true],
    ]);
    expect(readout?.stages[2]).toMatchObject({ isCurrent: true, remainingAfterCurrent: 1 });
  });

  it('reads "Cool-down" on the card and in the player', () => {
    const readout = describeWorkoutRun(coolDownRun, queue, 'c2');
    const coolDown = readout?.stages[2];
    const position = readout?.current;
    expect(coolDown && position).toBeTruthy();
    if (!coolDown || !position) return;

    expect(workoutStageName(coolDown.kind, t, coolDown.isCoolDown)).toBe('mobile.session.preWorkoutSectionCoolDown');
    expect(formatWorkoutStagePosition(position, t)).toBe(
      'mobile.session.workoutStagePosition(stage=mobile.session.preWorkoutSectionCoolDown,position=2,total=3)',
    );
  });

  it('still reads "Cool-down" once the climber queues its climbs before the workout', () => {
    const readout = describeWorkoutRun(coolDownRun, ['c1', 'c2', 'c3', 'w1', 'm1', 'm2'], 'c1');

    expect(readout?.stages.map((stage) => [stage.id, stage.isCoolDown])).toEqual([
      ['cool', true],
      ['warm', false],
      ['main', false],
    ]);
    if (!readout?.current) throw new Error('expected a current climb');
    expect(formatWorkoutStagePosition(readout.current, t)).toBe(
      'mobile.session.workoutStagePosition(stage=mobile.session.preWorkoutSectionCoolDown,position=1,total=3)',
    );
  });

  it('reads "Warm-up" for a warm-up queued last that was not planned as a cool-down', () => {
    const rampsUp: WorkoutRun = {
      stages: [
        { id: 'main', kind: 'volume', itemUuids: ['m1'] },
        { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
      ],
    };
    const readout = describeWorkoutRun(rampsUp, ['m1', 'w1'], 'w1');

    expect(readout?.stages.every((stage) => !stage.isCoolDown)).toBe(true);
  });

  it('never names a workout stage a cool-down', () => {
    expect(workoutStageName('volume', t, true)).toBe('mobile.session.preGeneratorVolume');
  });
});

describe('workout stage labels', () => {
  it('names each stage with the workout picker labels', () => {
    expect(workoutStageName('warmUp', t)).toBe('mobile.session.preWorkoutSectionWarmUp');
    expect(workoutStageName('gradeFocus', t)).toBe('mobile.session.preGeneratorGradeFocus');
  });

  it('names the timed stages', () => {
    expect(workoutStageName('onTheMinute', t)).toBe('mobile.session.preGeneratorOnTheMinute');
    expect(workoutStageName('fourByFour', t)).toBe('mobile.session.preGeneratorFourByFour');
    expect(workoutStageName('limitBouldering', t)).toBe('mobile.session.preGeneratorLimitBouldering');
  });

  it('names every stage kind', () => {
    for (const kind of WORKOUT_STAGE_KINDS) expect(workoutStageName(kind, t)).toMatch(/^mobile\.session\./);
  });

  it('counts a 4x4 climb as a set, and the rep the climber is on with it', () => {
    const fourByFour: WorkoutRun = { stages: [{ id: 'four', kind: 'fourByFour', itemUuids: ['a', 'b', 'c', 'd'] }] };
    const position = describeWorkoutRun(fourByFour, ['a', 'b', 'c', 'd'], 'b')?.current;
    if (!position) throw new Error('expected a current climb');
    expect(formatWorkoutStagePositionWithGo(position, { kind: 'rep', number: 3, total: 4 }, t)).toBe(
      'mobile.session.workoutStageSetPosition(stage=mobile.session.preGeneratorFourByFour,rep=3,reps=4,set=2,sets=4)',
    );
    // With no go to say (a stored 4x4 from before sets, unpaced), it reads like any stage.
    expect(formatWorkoutStagePositionWithGo(position, null, t)).toBe(
      'mobile.session.workoutStagePosition(stage=mobile.session.preGeneratorFourByFour,position=2,total=4)',
    );
  });

  it('adds the try to a limit climb', () => {
    const position = describeWorkoutRun(run, ['w1', 'w2', 'm1'], 'm1')?.current;
    if (!position) throw new Error('expected a current climb');
    expect(formatWorkoutStagePositionWithGo(position, { kind: 'try', number: 3 }, t)).toBe(
      'mobile.workoutRunner.positionWithTry(position=mobile.session.workoutStagePosition(stage=mobile.session.preGeneratorPyramid,position=1,total=1),number=3)',
    );
  });

  it('formats the player subtitle part', () => {
    const position = describeWorkoutRun(run, ['w1', 'w2', 'm1'], 'w2')?.current;
    expect(position).toBeTruthy();
    if (!position) return;
    expect(formatWorkoutStagePosition(position, t)).toBe(
      'mobile.session.workoutStagePosition(stage=mobile.session.preWorkoutSectionWarmUp,position=2,total=2)',
    );
  });
});

// The player's top bar (#6745): the stage name and its numbers apart, so a
// cut name never takes the numbers with it.
describe('formatWorkoutStageParts', () => {
  it('splits a stage climb into its name and the list-style count', () => {
    const position = describeWorkoutRun(run, ['w1', 'w2', 'm1'], 'w2')?.current;
    if (!position) throw new Error('expected a current climb');
    expect(formatWorkoutStageParts(position, null, t)).toEqual({
      stage: 'mobile.session.preWorkoutSectionWarmUp',
      count: 'playView.track.position(position=2,total=2)',
      accessibilityLabel:
        'mobile.session.workoutStageTopBarAria(stage=mobile.session.preWorkoutSectionWarmUp,position=2,total=2)',
    });
  });

  it('counts a 4x4 climb as a set, with the rep the climber is on', () => {
    const fourByFour: WorkoutRun = { stages: [{ id: 'four', kind: 'fourByFour', itemUuids: ['a', 'b'] }] };
    const position = describeWorkoutRun(fourByFour, ['a', 'b'], 'b')?.current;
    if (!position) throw new Error('expected a current climb');
    expect(formatWorkoutStageParts(position, { kind: 'rep', number: 1, total: 4 }, t)).toEqual({
      stage: 'mobile.session.preGeneratorFourByFour',
      count: 'mobile.session.workoutStageSetCount(rep=1,reps=4,set=2,sets=2)',
      accessibilityLabel:
        'mobile.session.workoutStageTopBarSetAria(stage=mobile.session.preGeneratorFourByFour,rep=1,reps=4,set=2,sets=2)',
    });
  });

  it("carries a limit climb's try with the numbers, never with the name", () => {
    const position = describeWorkoutRun(run, ['w1', 'w2', 'm1'], 'm1')?.current;
    if (!position) throw new Error('expected a current climb');
    const parts = formatWorkoutStageParts(position, { kind: 'try', number: 3 }, t);
    expect(parts.stage).toBe('mobile.session.preGeneratorPyramid');
    expect(parts.count).toBe(
      'mobile.workoutRunner.positionWithTry(position=playView.track.position(position=1,total=1),number=3)',
    );
    expect(parts.accessibilityLabel).toBe(
      'mobile.session.workoutStageTopBarTryAria(position=mobile.session.workoutStageTopBarAria(stage=mobile.session.preGeneratorPyramid,position=1,total=1),number=3)',
    );
  });
});
