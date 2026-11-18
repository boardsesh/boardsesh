// A partner app's 4x4 runs as the partner wrote it (#6734, workoutbash1 D1):
// `climbCount` climbs, one go each, then the same climbs again for every round,
// each visit its own queue item, with the rest between climbs after a climb and
// the rest between rounds after a round's last climb. Followed end to end: the
// plan, the queued climbs, the rest timer, the readout, the rest card, the copy
// stored on the server, and where each round's tick lands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { CreateWorkout } from '@boardsesh/public-api';
import { getGradesForBoard } from '@boardsesh/board-config';

const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: () => `qi-${counter++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import { locateInRun, roundPacing, type WorkoutRun } from '@boardsesh/playlist-generator';
import { deriveWorkoutStages, type SessionWorkoutTick } from '@boardsesh/workout-summary';
import { buildPartnerWorkoutPlan } from '../partner-workout-plan';
import { buildPartnerWorkoutPreview } from '../partner-workout-preview';
import { restorePartnerWorkoutRun } from '../partner-workout-initial-seed';
import { NO_TOP_UPS, type FetchGradePool } from '../../components/session-screen/pre-session/workout-preview-pool';
import { resolveStageRestPacing, restAdvanceAllowed, type RestTimerTickStatus } from '../rest-timer-pacing';
import { formatWorkoutStageParts, formatWorkoutStagePositionWithGo } from '../workout-run-readout';
import { describeWorkoutRunner, workoutClimbGo } from '../workout-runner-readout';
import { countWorkoutRunTicks, type WorkoutTickLogEntry } from '../workout-run-store';
import { buildSessionWorkoutPlan, buildSessionWorkoutTickMap, captureWorkoutRunClimbs } from '../session-workout-plan';
import { resolveWorkoutRestCard } from '../../components/play-drawer/workout-runner-cards';

const kilterGrades = getGradesForBoard('kilter');
const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard;

const fetchPool: FetchGradePool = async (grade: number) => ({
  climbs: Array.from(
    { length: 10 },
    (_, index) => ({ uuid: `g${grade}-${index}`, name: `g${grade}-${index}`, angle: 40 }) as Climb,
  ),
  topUpTiers: NO_TOP_UPS,
  exhausted: true,
});

const fourByFour = (
  fields: Partial<Extract<CreateWorkout['blocks'][number], { type: 'fourByFour' }>> = {},
): CreateWorkout => ({
  title: 'Board 4x4s',
  externalRef: 'four',
  blocks: [
    {
      type: 'fourByFour',
      targetGrade: { scale: 'font', value: '6B' },
      climbCount: 4,
      rounds: 3,
      restBetweenClimbsSeconds: 30,
      restBetweenRoundsSeconds: 180,
      ...fields,
    },
  ],
});

async function queueWorkout(spec: CreateWorkout) {
  return buildPartnerWorkoutPreview({
    spec,
    partnerPlan: buildPartnerWorkoutPlan(spec, kilterGrades, 'wk_four'),
    grades: kilterGrades,
    ctx: { board, isAuthenticated: true },
    fetchPool,
  });
}

// Echoes the key and its options so the assertions read the inputs directly.
const t = (key: string, options?: Record<string, string | number>) =>
  options
    ? `${key}(${Object.entries(options)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')})`
    : key;

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a partner 4x4 in the queue', () => {
  it('queues round 1’s climbs, then the same climbs again for every round, each visit a new queue item', async () => {
    const { items, run } = await queueWorkout(fourByFour());
    const climbs = items.map((item) => item.climb.uuid);
    expect(climbs).toHaveLength(12);
    expect(new Set(climbs.slice(0, 4)).size).toBe(4);
    expect(climbs.slice(4, 8)).toEqual(climbs.slice(0, 4));
    expect(climbs.slice(8, 12)).toEqual(climbs.slice(0, 4));
    expect(new Set(items.map((item) => item.uuid)).size).toBe(12);
    expect(run.stages).toEqual([
      {
        id: 'wk_four:0',
        kind: 'fourByFour',
        itemUuids: items.map((item) => item.uuid),
        targetGrade: 18,
        pacing: roundPacing({ climbsPerRound: 4, restBetweenClimbsSeconds: 30, restBetweenRoundsSeconds: 180 }),
      },
    ]);
  });

  it('runs a 4x4 of one climb as one set on one queue item, a rep per round', async () => {
    const { items, run } = await queueWorkout(fourByFour({ climbCount: 1, rounds: 4 }));
    expect(items).toHaveLength(1);
    expect(run.stages[0].pacing).toEqual({
      mode: 'afterTick',
      restSeconds: 180,
      advanceOn: 'set',
      sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
    });
  });
});

describe('a partner 4x4 on the wall', () => {
  async function onTheWall() {
    const { items, run } = await queueWorkout(fourByFour());
    const queue = items.map((item) => item.uuid);
    const pacingAt = (position: number, log: readonly WorkoutTickLogEntry[] = []) => {
      const uuid = queue[position - 1];
      return resolveStageRestPacing({
        sessionId: 'session-1',
        run,
        position: locateInRun(run, uuid, queue),
        queueItemUuid: uuid,
        repsLogged: countWorkoutRunTicks(log, uuid),
      });
    };
    return { items, run, queue, pacingAt };
  }

  it('rests between climbs after a climb, and between rounds after a round’s last climb', async () => {
    const { pacingAt } = await onTheWall();
    const rests = Array.from({ length: 12 }, (_, index) => pacingAt(index + 1)?.targetSeconds);
    expect(rests).toEqual([30, 30, 30, 180, 30, 30, 30, 180, 30, 30, 30, 180]);
    expect(pacingAt(4)).toMatchObject({ advanceOn: 'tick', closesRound: true, closesSet: false });
    expect(pacingAt(3)?.closesRound).toBeUndefined();
  });

  it('moves on after any logged go, a fall included: a round is one go a climb', async () => {
    const { pacingAt, queue } = await onTheWall();
    for (const status of ['attempt', 'send', 'flash'] as RestTimerTickStatus[]) {
      const stage = pacingAt(2);
      expect(
        restAdvanceAllowed({
          advanceOn: stage!.advanceOn,
          currentQueueItemUuid: queue[1],
          lastTick: { status, queueItemUuid: queue[1] },
          stage,
        }),
      ).toBe(true);
    }
  });

  it('reads "Round 2 of 3 · Climb 3 of 4" in the player and on the card', async () => {
    const { run, queue } = await onTheWall();
    const position = locateInRun(run, queue[6], queue);
    if (!position) throw new Error('expected a position');
    expect(workoutClimbGo(run, position.stageId, queue[6], [])).toBeNull();
    expect(formatWorkoutStageParts(position, null, t)).toEqual({
      stage: 'mobile.session.preGeneratorFourByFour',
      count: 'mobile.session.workoutStageRoundCount(round=2,rounds=3,climb=3,climbs=4)',
      accessibilityLabel:
        'mobile.session.workoutStageTopBarRoundAria(stage=mobile.session.preGeneratorFourByFour,round=2,rounds=3,climb=3,climbs=4)',
    });
    expect(formatWorkoutStagePositionWithGo(position, null, t)).toBe(
      'mobile.session.workoutStageRoundPosition(stage=mobile.session.preGeneratorFourByFour,round=2,rounds=3,climb=3,climbs=4)',
    );
  });

  it('says the round is done after its last climb, and names the next climb', async () => {
    const { run, queue, items, pacingAt } = await onTheWall();
    const log: WorkoutTickLogEntry[] = queue.slice(0, 4).map((queueItemUuid, minute) => ({
      queueItemUuid,
      status: 'attempt',
      climbedAt: `2026-11-18T12:0${minute}:00Z`,
    }));
    const readout = describeWorkoutRunner({
      run,
      queueUuids: queue,
      currentUuid: queue[3],
      nextUuid: queue[4],
      log,
      rest: {
        armed: true,
        isRunning: true,
        anchorMs: 1000,
        lastTick: { status: 'attempt', queueItemUuid: queue[3] },
        stagePacing: pacingAt(4, log),
        queueEnded: false,
      },
      canAdvanceQueue: true,
    });
    expect(readout?.rest).toMatchObject({ closesRound: true, closesSet: false, targetSeconds: 180, advances: true });
    expect(resolveWorkoutRestCard({ readout: readout!, nextItem: items[4], skipAllowed: true })).toMatchObject({
      heading: { kind: 'roundDone', round: 1 },
      caption: { kind: 'nextClimb', item: items[4] },
      action: 'skipRest',
    });
  });
});

describe('a partner 4x4 on the server', () => {
  it('stores the round rule, and restores the rounds from the workout’s own blocks', async () => {
    const spec = fourByFour();
    const { items, run } = await queueWorkout(spec);
    const plan = buildSessionWorkoutPlan({ run, climbs: captureWorkoutRunClimbs(items) });
    expect(plan?.stages[0].pacing).toEqual({ mode: 'afterTick', restSeconds: 30, advanceOn: 'round' });
    const stored: unknown = JSON.parse(JSON.stringify(plan));
    expect(restorePartnerWorkoutRun(stored, { workoutId: 'wk_four', spec })?.run.stages[0].pacing).toEqual(
      run.stages[0].pacing,
    );
    // Without the blocks there are no rounds to run: the climbs run on the climber's own rests.
    expect(restorePartnerWorkoutRun(stored)?.run.stages[0].pacing).toBeUndefined();
  });

  it('puts each round’s go on that round’s queue item, the same climb in every round', async () => {
    const { items, run } = await queueWorkout(fourByFour({ climbCount: 2, rounds: 3 }));
    const plan = buildSessionWorkoutPlan({ run, climbs: captureWorkoutRunClimbs(items) });
    if (!plan) throw new Error('expected a plan');
    const log: WorkoutTickLogEntry[] = items.map((item, minute) => ({
      queueItemUuid: item.uuid,
      status: minute === 2 ? 'attempt' : 'send',
      climbedAt: `2026-11-18T12:0${minute}:00Z`,
      tickUuid: `tick-${minute}`,
    }));
    const ticks: SessionWorkoutTick[] = items.map((item, minute) => ({
      uuid: `tick-${minute}`,
      climbUuid: item.climb.uuid,
      angle: 40,
      status: minute === 2 ? 'attempt' : 'send',
      climbedAt: `2026-11-18T12:0${minute}:00Z`,
    }));
    const expected = items.map((item, minute) => [item.uuid, [`tick-${minute}`]]);
    const byItem = (tickMap: Parameters<typeof deriveWorkoutStages>[1]) =>
      deriveWorkoutStages(plan, tickMap, ticks).stages[0].climbs.map((climb) => [climb.queueItemUuid, climb.tickUuids]);
    expect(byItem(buildSessionWorkoutTickMap({ log }, plan))).toEqual(expected);
    // A tick the map lacks (logged on another phone) lands on the same round by climb and order.
    expect(byItem([])).toEqual(expected);
  });
});

describe('the app’s own 4x4 is unchanged', () => {
  it('still reads reps and sets, with no rounds', () => {
    const run: WorkoutRun = {
      stages: [
        {
          id: 'four',
          kind: 'fourByFour',
          itemUuids: ['a', 'b'],
          pacing: {
            mode: 'afterTick',
            restSeconds: 0,
            advanceOn: 'set',
            sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
          },
        },
      ],
    };
    const position = locateInRun(run, 'b', ['a', 'b']);
    expect(position?.round).toBeUndefined();
    const pacing = resolveStageRestPacing({ sessionId: 's', run, position, queueItemUuid: 'b', repsLogged: 4 });
    expect(pacing).toMatchObject({ closesSet: true, targetSeconds: 180, reps: { logged: 4, perSet: 4 } });
    expect(pacing?.closesRound).toBeUndefined();
  });
});
