// The stage half of the rest timer's pacing (#5380, #6231): what a workout stage
// says the rest after the climb on the wall is, and what a change of stage does
// to a running timer. Pure; the store and scheduler tests drive these end to end.
import { describe, expect, it } from 'vitest';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import {
  planRestTimerPacingTransition,
  resolveEffectiveRestPacing,
  resolveStageRestPacing,
  restAdvanceAllowed,
  sameStagePacing,
  stageHasRepsLeft,
  type RestPacingSettings,
  type RestTimerStagePacing,
} from '../rest-timer-pacing';

const SESSION_ID = 'session-1';

const FOUR_BY_FOUR_PACING = {
  mode: 'afterTick',
  restSeconds: 0,
  advanceOn: 'set',
  sets: { repsPerSet: 2, restBetweenSetsSeconds: 30 },
} as const;

// A warm-up, a 4x4 of 2 sets x 2 reps (no rest between reps, 30 s between
// sets), a limit block (3:00, moves on after a send) and an on-the-minute
// block every 0:45.
const RUN: WorkoutRun = {
  stages: [
    { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      itemUuids: ['a', 'b'],
      targetGrade: 18,
      pacing: FOUR_BY_FOUR_PACING,
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
const QUEUE = ['w1', 'a', 'b', 'l1', 'e1', 'e2', 'hand-queued'];

function stageFor(
  queueItemUuid: string,
  {
    repsLogged = 0,
    queue = QUEUE,
    run = RUN,
  }: { repsLogged?: number; queue?: readonly string[]; run?: WorkoutRun } = {},
): RestTimerStagePacing | null {
  return resolveStageRestPacing({
    sessionId: SESSION_ID,
    run,
    position: locateInRun(run, queueItemUuid, queue),
    queueItemUuid,
    repsLogged,
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
    expect(
      resolveStageRestPacing({ sessionId: SESSION_ID, run: RUN, position: null, queueItemUuid: 'a', repsLogged: 0 }),
    ).toBeNull();
  });

  it('runs no rest between 4x4 reps when the rest between reps is 0, and counts the reps', () => {
    expect(stageFor('a')).toEqual({
      sessionId: SESSION_ID,
      stageId: 'stage-4x4',
      kind: 'fourByFour',
      queueItemUuid: 'a',
      mode: 'afterTick',
      targetSeconds: null,
      advanceOn: 'tick',
      closesSet: false,
      reps: { logged: 0, perSet: 2 },
      stagePacing: FOUR_BY_FOUR_PACING,
    });
    expect(stageFor('a', { repsLogged: 1 })).toMatchObject({
      targetSeconds: null,
      closesSet: false,
      reps: { logged: 1, perSet: 2 },
    });
  });

  it('rests the set rest once every rep of the set is logged, an extra rep included', () => {
    expect(stageFor('a', { repsLogged: 2 })).toMatchObject({
      targetSeconds: 30,
      closesSet: true,
      reps: { logged: 2, perSet: 2 },
    });
    expect(stageFor('b', { repsLogged: 3 })).toMatchObject({
      targetSeconds: 30,
      closesSet: true,
      reps: { logged: 2, perSet: 2 },
    });
    // Capped at the set, so the extra go changes no pacing either.
    expect(sameStagePacing(stageFor('a', { repsLogged: 2 }), stageFor('a', { repsLogged: 3 }))).toBe(true);
  });

  it('runs the rest between reps when there is one, and the changeover for a set rest of 0', () => {
    const triples: WorkoutRun = {
      stages: [
        {
          id: 'stage-4x4',
          kind: 'fourByFour',
          itemUuids: ['t'],
          pacing: {
            mode: 'afterTick',
            restSeconds: 45,
            advanceOn: 'set',
            sets: { repsPerSet: 3, restBetweenSetsSeconds: 0 },
          },
        },
      ],
    };
    const options = { run: triples, queue: ['t'] };
    expect(stageFor('t', { ...options, repsLogged: 1 })).toMatchObject({ targetSeconds: 45, closesSet: false });
    expect(stageFor('t', { ...options, repsLogged: 2 })).toMatchObject({ targetSeconds: 45, closesSet: false });
    expect(stageFor('t', { ...options, repsLogged: 3 })).toMatchObject({ targetSeconds: 10, closesSet: true });
  });

  it('leaves the rep count off every stage but a 4x4', () => {
    for (const uuid of ['l1', 'e1']) expect(stageFor(uuid, { repsLogged: 3 })).not.toHaveProperty('reps');
    expect(stageFor('l1', { repsLogged: 3 })).toMatchObject({ targetSeconds: 180, closesSet: false });
  });

  it('moves limit bouldering on only after a send', () => {
    expect(stageFor('l1')).toMatchObject({
      kind: 'limitBouldering',
      mode: 'afterTick',
      targetSeconds: 180,
      advanceOn: 'send',
      closesSet: false,
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
    const coolDownQueue = { queue: COOL_DOWN_QUEUE };
    expect(stageFor('c1', { ...coolDownQueue, run: COOL_DOWN_RUN })).toMatchObject({
      kind: 'warmUp',
      isCoolDown: true,
    });
    expect(stageFor('c1', { ...coolDownQueue, run: WARM_UP_RUN })).not.toHaveProperty('isCoolDown');
    expect(stageFor('l1', { ...coolDownQueue, run: COOL_DOWN_RUN })).not.toHaveProperty('isCoolDown');
  });

  it('is display only: it never makes a pacing change, so the timer is not re-anchored', () => {
    const coolDown = stageFor('c1', { queue: COOL_DOWN_QUEUE, run: COOL_DOWN_RUN });
    if (!coolDown) throw new Error('the cool-down is paced');
    const { isCoolDown: _dropped, ...asWarmUp } = coolDown;
    expect(sameStagePacing(coolDown, asWarmUp)).toBe(true);
    expect(planRestTimerPacingTransition(effective(asWarmUp), effective(coolDown))).toBe('none');
  });
});

describe('sameStagePacing', () => {
  it('compares field by field, so a rebuilt object is the same pacing', () => {
    expect(sameStagePacing(stageFor('a'), stageFor('a'))).toBe(true);
    expect(sameStagePacing(stageFor('a', { repsLogged: 1 }), stageFor('a', { repsLogged: 1 }))).toBe(true);
    expect(sameStagePacing(null, null)).toBe(true);
  });

  it('tells apart another climb, another stage, another rep, the set rest and no stage', () => {
    expect(sameStagePacing(stageFor('a'), stageFor('b'))).toBe(false);
    expect(sameStagePacing(stageFor('b'), stageFor('l1'))).toBe(false);
    expect(sameStagePacing(stageFor('a'), null)).toBe(false);
    expect(sameStagePacing(null, stageFor('e1'))).toBe(false);
    expect(sameStagePacing(stageFor('a'), stageFor('a', { repsLogged: 1 }))).toBe(false);
    expect(sameStagePacing(stageFor('a', { repsLogged: 1 }), stageFor('a', { repsLogged: 2 }))).toBe(false);
    const a = stageFor('a');
    if (!a) throw new Error('a is paced');
    expect(
      sameStagePacing(a, {
        ...a,
        stagePacing: { ...FOUR_BY_FOUR_PACING, sets: { repsPerSet: 2, restBetweenSetsSeconds: 60 } },
      }),
    ).toBe(false);
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
    expect(planRestTimerPacingTransition(effective(stageFor('a', { repsLogged: 2 })), effective(stageFor('b')))).toBe(
      'waitForTick',
    );
    expect(planRestTimerPacingTransition(effective(stageFor('b', { repsLogged: 2 })), effective(stageFor('l1')))).toBe(
      'waitForTick',
    );
    expect(planRestTimerPacingTransition(effective(null), effective(stageFor('a')))).toBe('waitForTick');
  });

  it('keeps the rest running from one rep to the next on the same climb, the set rest included', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('a')), effective(stageFor('a', { repsLogged: 1 })))).toBe(
      'none',
    );
    expect(
      planRestTimerPacingTransition(
        effective(stageFor('a', { repsLogged: 1 })),
        effective(stageFor('a', { repsLogged: 2 })),
      ),
    ).toBe('none');
  });

  it('leaves a timed stage for the climber’s own after-tick rest without touching the anchor', () => {
    expect(planRestTimerPacingTransition(effective(stageFor('l1')), effective(null))).toBe('none');
  });

  it('keeps the rest when the climb on the wall moves into another after-tick stage', () => {
    // The run is re-planned with b still up: it now opens the limit block. The
    // climb on the wall did not change, so its rest carries (running from its
    // tick, or still waiting for it), and the limit block's send rule reads the
    // same last tick. Clearing the anchor here would throw away a tick the
    // climber already logged on this climb.
    const RESTAGED: WorkoutRun = {
      stages: RUN.stages.map((runStage) => {
        if (runStage.id === 'stage-4x4') return { ...runStage, itemUuids: ['a'] };
        if (runStage.id === 'stage-limit') return { ...runStage, itemUuids: ['b', 'l1'] };
        return runStage;
      }),
    };
    const inFourByFour = stageFor('b');
    const inLimit = stageFor('b', { run: RESTAGED });
    expect(inFourByFour).toMatchObject({ stageId: 'stage-4x4', queueItemUuid: 'b', advanceOn: 'tick' });
    expect(inLimit).toMatchObject({ stageId: 'stage-limit', queueItemUuid: 'b', advanceOn: 'send' });

    expect(planRestTimerPacingTransition(effective(inFourByFour), effective(inLimit))).toBe('none');
    expect(planRestTimerPacingTransition(effective(inLimit), effective(inFourByFour))).toBe('none');
  });
});

describe('the last set of a 4x4', () => {
  it('rests its own set rest before the next block, not the next block’s rest', () => {
    // b is the 4x4's last set and l1 opens the limit block. The rest after b's
    // last rep is the 4x4's 30 s set rest, not the limit block's 3:00, which is
    // l1's rest after l1.
    const lastOfFourByFour = stageFor('b', { repsLogged: 2 });
    expect(lastOfFourByFour).toMatchObject({ stageId: 'stage-4x4', closesSet: true, targetSeconds: 30 });
    expect(effective(lastOfFourByFour)).toMatchObject({ targetSeconds: 30, advanceOn: 'tick', source: 'stage' });
    expect(stageFor('l1')).toMatchObject({ stageId: 'stage-limit', targetSeconds: 180 });
  });
});

describe('a 4x4 set holds the wall until its last rep', () => {
  const tickOn = (queueItemUuid: string) => ({ status: 'attempt' as const, queueItemUuid });

  it('says the set has reps left until every one is logged', () => {
    expect(stageHasRepsLeft(stageFor('a'))).toBe(true);
    expect(stageHasRepsLeft(stageFor('a', { repsLogged: 1 }))).toBe(true);
    expect(stageHasRepsLeft(stageFor('a', { repsLogged: 2 }))).toBe(false);
    expect(stageHasRepsLeft(stageFor('l1'))).toBe(false);
    expect(stageHasRepsLeft(null)).toBe(false);
  });

  it('turns auto-advance off until the set is done, so a clock with no rep count never fires mid-set', () => {
    expect(effective(stageFor('a', { repsLogged: 1 }))).toMatchObject({ autoAdvance: false, advanceOn: 'tick' });
    expect(effective(stageFor('a', { repsLogged: 2 }))).toMatchObject({ autoAdvance: true, advanceOn: 'tick' });
    expect(effective(stageFor('l1'))).toMatchObject({ autoAdvance: true });
  });

  it('moves the wall only once the set’s last rep is logged on the climb on the wall', () => {
    const allowed = (stage: RestTimerStagePacing | null, current = 'a') =>
      restAdvanceAllowed({ advanceOn: 'tick', currentQueueItemUuid: current, lastTick: tickOn(current), stage });

    expect(allowed(stageFor('a', { repsLogged: 1 }))).toBe(false);
    expect(allowed(stageFor('a', { repsLogged: 2 }))).toBe(true);
    expect(allowed(stageFor('a', { repsLogged: 3 }))).toBe(true);
    // A 4x4 stage resolved for another climb than the one on the wall says
    // nothing about this climb's reps.
    expect(allowed(stageFor('a', { repsLogged: 2 }), 'b')).toBe(false);
    // Without a stage (a crew phone with no run) the tick rule alone applies.
    expect(allowed(null)).toBe(true);
    // The deadline rule never reads reps.
    expect(
      restAdvanceAllowed({
        advanceOn: 'deadline',
        currentQueueItemUuid: 'a',
        lastTick: null,
        stage: stageFor('a', { repsLogged: 1 }),
      }),
    ).toBe(true);
  });

  it('still needs a tick on the climb on the wall once the set is done', () => {
    const done = stageFor('a', { repsLogged: 2 });
    expect(restAdvanceAllowed({ advanceOn: 'tick', currentQueueItemUuid: 'a', lastTick: null, stage: done })).toBe(
      false,
    );
    expect(
      restAdvanceAllowed({ advanceOn: 'tick', currentQueueItemUuid: 'a', lastTick: tickOn('b'), stage: done }),
    ).toBe(false);
  });
});
