// The stage half of the rest timer's pacing (#5380, #6231): what a workout stage
// says the rest after the climb on the wall is, and what a change of stage does
// to a running timer. Pure; the store and scheduler tests drive these end to end.
import { describe, expect, it } from 'vitest';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import {
  planRestTimerPacingTransition,
  resolveEffectiveRestPacing,
  resolveStageRestPacing,
  sameStagePacing,
  type RestPacingSettings,
  type RestTimerStagePacing,
} from '../rest-timer-pacing';

const SESSION_ID = 'session-1';

// A warm-up, a 4x4 of 2 climbs x 2 rounds (0 s between climbs, 30 s between
// rounds), a limit block (3:00, moves on after a send) and an on-the-minute
// block every 0:45.
const RUN: WorkoutRun = {
  stages: [
    { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a1', 'b1', 'a2', 'b2'],
      targetGrade: 18,
      pacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 30, advanceOn: 'tick' },
      rounds: 2,
      roundByUuid: { a1: 1, b1: 1, a2: 2, b2: 2 },
    },
    {
      id: 'stage-limit',
      kind: 'limitBouldering',
      itemUuids: ['l1'],
      targetGrade: 22,
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
    {
      id: 'stage-emom',
      kind: 'onTheMinute',
      itemUuids: ['e1', 'e2'],
      targetGrade: 16,
      pacing: { mode: 'onTheMinute', restSeconds: 45 },
    },
  ],
};
const QUEUE = ['w1', 'a1', 'b1', 'a2', 'b2', 'l1', 'e1', 'e2', 'hand-queued'];

function stageFor(
  queueItemUuid: string,
  queue: readonly string[] = QUEUE,
  run: WorkoutRun = RUN,
): RestTimerStagePacing | null {
  return resolveStageRestPacing({
    sessionId: SESSION_ID,
    run,
    position: locateInRun(run, queueItemUuid, queue),
    queueItemUuid,
  });
}

const SETTINGS: RestPacingSettings = { targetSeconds: 120, mode: 'afterTick', autoAdvance: false };

function effective(stage: RestTimerStagePacing | null, settings: RestPacingSettings = SETTINGS) {
  return resolveEffectiveRestPacing({ settings, stage, crew: null });
}

describe('resolveStageRestPacing', () => {
  it('leaves an untimed stage, and a climb in no stage, to the climber’s own settings', () => {
    expect(stageFor('w1')).toBeNull();
    expect(stageFor('hand-queued')).toBeNull();
    expect(resolveStageRestPacing({ sessionId: SESSION_ID, run: RUN, position: null, queueItemUuid: 'a1' })).toBeNull();
  });

  it('runs a 4x4 rest of 0 as the 10 s changeover, and moves on after any tick', () => {
    expect(stageFor('a1')).toEqual({
      sessionId: SESSION_ID,
      stageId: 'stage-4x4',
      kind: 'fourByFour',
      queueItemUuid: 'a1',
      mode: 'afterTick',
      targetSeconds: 10,
      advanceOn: 'tick',
      closesRound: false,
      stagePacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 30, advanceOn: 'tick' },
    });
  });

  it('rests the round rest after the last climb of a round', () => {
    expect(stageFor('b1')).toMatchObject({ closesRound: true, targetSeconds: 30 });
    expect(stageFor('a2')).toMatchObject({ closesRound: false, targetSeconds: 10 });
    expect(stageFor('b2')).toMatchObject({ closesRound: true, targetSeconds: 30 });
  });

  it('closes a round on its last QUEUED climb once the climber removed one', () => {
    const withoutB1 = QUEUE.filter((uuid) => uuid !== 'b1');
    expect(stageFor('a1', withoutB1)).toMatchObject({ closesRound: true, targetSeconds: 30 });
  });

  it('moves limit bouldering on only after a send', () => {
    expect(stageFor('l1')).toMatchObject({
      kind: 'limitBouldering',
      mode: 'afterTick',
      targetSeconds: 180,
      advanceOn: 'send',
      closesRound: false,
    });
  });

  it('beats on the minute at the interval, whether or not anything was logged', () => {
    expect(stageFor('e1')).toMatchObject({ mode: 'onTheMinute', targetSeconds: 45, advanceOn: 'deadline' });
  });
});

// A paced warm-up queued after a workout stage: only the `coolDown` flag tells
// it from a warm-up.
const PACED_WARM_UP = {
  mode: 'afterTick',
  restSeconds: 30,
  advanceOn: 'tick',
} as const;
const COOL_DOWN_RUN: WorkoutRun = {
  stages: [
    { id: 'stage-limit', kind: 'limitBouldering', itemUuids: ['l1'], pacing: RUN.stages[2]?.pacing },
    { id: 'stage-cool', kind: 'warmUp', itemUuids: ['c1', 'c2'], coolDown: true, pacing: PACED_WARM_UP },
  ],
};
const COOL_DOWN_QUEUE = ['l1', 'c1', 'c2'];
const WARM_UP_RUN: WorkoutRun = {
  stages: [{ id: 'stage-warm', kind: 'warmUp', itemUuids: ['c1', 'c2'], pacing: PACED_WARM_UP }],
};

describe('isCoolDown on the stage pacing', () => {
  it('is set for a cool-down stage and absent for a warm-up and any other stage', () => {
    expect(stageFor('c1', COOL_DOWN_QUEUE, COOL_DOWN_RUN)).toMatchObject({ kind: 'warmUp', isCoolDown: true });
    expect(stageFor('c1', COOL_DOWN_QUEUE, WARM_UP_RUN)).not.toHaveProperty('isCoolDown');
    expect(stageFor('l1', COOL_DOWN_QUEUE, COOL_DOWN_RUN)).not.toHaveProperty('isCoolDown');
  });

  it('is display only: it never makes a pacing change, so the timer is not re-anchored', () => {
    const coolDown = stageFor('c1', COOL_DOWN_QUEUE, COOL_DOWN_RUN);
    if (!coolDown) throw new Error('the cool-down is paced');
    const { isCoolDown: _dropped, ...asWarmUp } = coolDown;
    expect(sameStagePacing(coolDown, asWarmUp)).toBe(true);
    expect(planRestTimerPacingTransition(effective(asWarmUp), effective(coolDown))).toBe('none');
  });
});

describe('sameStagePacing', () => {
  it('compares field by field, so a rebuilt object is the same pacing', () => {
    expect(sameStagePacing(stageFor('a1'), stageFor('a1'))).toBe(true);
    expect(sameStagePacing(null, null)).toBe(true);
  });

  it('tells apart another climb, another stage, a round rest and no stage', () => {
    expect(sameStagePacing(stageFor('a1'), stageFor('a2'))).toBe(false);
    expect(sameStagePacing(stageFor('b1'), stageFor('l1'))).toBe(false);
    expect(sameStagePacing(stageFor('a1'), null)).toBe(false);
    expect(sameStagePacing(null, stageFor('e1'))).toBe(false);
    const a1 = stageFor('a1');
    if (!a1) throw new Error('a1 is paced');
    expect(sameStagePacing(a1, { ...a1, closesRound: true, targetSeconds: 30 })).toBe(false);
  });
});

describe('planRestTimerPacingTransition', () => {
  it('does nothing while no stage paces the timer: settings edits are the sheet’s', () => {
    expect(planRestTimerPacingTransition(effective(null), effective(null))).toBe('none');
  });

  it('starts the beat when an on-the-minute stage comes on the wall', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('l1')), effective(stageFor('e1')))).toBe('anchorNow');
    expect(planRestTimerPacingTransition(effective(null), effective(stageFor('e1')))).toBe('anchorNow');
  });

  it('keeps the beat from one on-the-minute climb to the next', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('e1')), effective(stageFor('e2')))).toBe('none');
  });

  it('keeps the climber’s own on-the-minute beat when the stage interval matches it', () => {
    const everyFortyFive: RestPacingSettings = { targetSeconds: 45, mode: 'onTheMinute', autoAdvance: true };
    expect(
      planRestTimerPacingTransition(effective(null, everyFortyFive), effective(stageFor('e1'), everyFortyFive)),
    ).toBe('none');
  });

  it('restarts the beat when the interval changes', () => {
    const everyMinute: RestPacingSettings = { targetSeconds: 60, mode: 'onTheMinute', autoAdvance: true };
    expect(planRestTimerPacingTransition(effective(null, everyMinute), effective(stageFor('e1'), everyMinute))).toBe(
      'anchorNow',
    );
  });

  it('waits for a tick when on the minute ends', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('e2')), effective(null))).toBe('waitForTick');
    expect(planRestTimerPacingTransition(effective(stageFor('e2')), effective(stageFor('l1')))).toBe('waitForTick');
  });

  it('waits for the new climb’s own tick on every new climb of a tick or send stage', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('a1')), effective(stageFor('b1')))).toBe('waitForTick');
    expect(planRestTimerPacingTransition(effective(stageFor('b2')), effective(stageFor('l1')))).toBe('waitForTick');
    expect(planRestTimerPacingTransition(effective(null), effective(stageFor('a1')))).toBe('waitForTick');
  });

  it('keeps the rest running when only the round rest of the same climb changed', () => {
    const a1 = stageFor('a1');
    if (!a1) throw new Error('a1 is paced');
    expect(
      planRestTimerPacingTransition(effective(a1), effective({ ...a1, closesRound: true, targetSeconds: 30 })),
    ).toBe('none');
  });

  it('leaves a timed stage for the climber’s own after-tick rest without touching the anchor', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('l1')), effective(null))).toBe('none');
  });

  it('keeps the rest when the climb on the wall moves into another after-tick stage', () => {
    // The run is re-planned with b2 still up: it now opens the limit block. The
    // climb on the wall did not change, so its rest carries (running from its
    // tick, or still waiting for it), and the limit block's send rule reads the
    // same last tick. Clearing the anchor here would throw away a tick the
    // climber already logged on this climb.
    const RESTAGED: WorkoutRun = {
      stages: RUN.stages.map((runStage) => {
        if (runStage.id === 'stage-4x4') return { ...runStage, itemUuids: ['a1', 'b1', 'a2'] };
        if (runStage.id === 'stage-limit') return { ...runStage, itemUuids: ['b2', 'l1'] };
        return runStage;
      }),
    };
    const inFourByFour = stageFor('b2');
    const inLimit = stageFor('b2', QUEUE, RESTAGED);
    expect(inFourByFour).toMatchObject({ stageId: 'stage-4x4', queueItemUuid: 'b2', advanceOn: 'tick' });
    expect(inLimit).toMatchObject({ stageId: 'stage-limit', queueItemUuid: 'b2', advanceOn: 'send' });

    expect(planRestTimerPacingTransition(effective(inFourByFour), effective(inLimit))).toBe('none');
    expect(planRestTimerPacingTransition(effective(inLimit), effective(inFourByFour))).toBe('none');
  });
});

describe('the last climb of a stage', () => {
  it('rests its own stage’s round rest before the next block, not zero and not the next block’s rest', () => {
    // b2 closes the 4x4's last round and l1 opens the limit block. The rest after
    // b2 is the 4x4's 30 s round rest: not the 0 s between climbs (or its 10 s
    // changeover), and not the limit block's 3:00, which is l1's rest after l1.
    const lastOfFourByFour = stageFor('b2');
    expect(lastOfFourByFour).toMatchObject({ stageId: 'stage-4x4', closesRound: true, targetSeconds: 30 });
    expect(effective(lastOfFourByFour)).toMatchObject({ targetSeconds: 30, advanceOn: 'tick', source: 'stage' });
    expect(stageFor('l1')).toMatchObject({ stageId: 'stage-limit', targetSeconds: 180 });
  });
});
