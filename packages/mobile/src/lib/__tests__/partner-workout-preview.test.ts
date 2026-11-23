// A partner app's workout fills its blocks through the app's own preview
// pipeline (#5399, F6 of workoutbash1): a short grade borrows from the nearest
// one, a climb the session already queued is passed over, and a V target draws
// from its whole band on the board.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { CreateWorkout } from '@boardsesh/public-api';
import { getGradesForBoard } from '@boardsesh/board-config';
import { locateInRun } from '@boardsesh/playlist-generator';
import {
  resolveEffectiveRestPacing,
  resolveStageRestPacing,
  restAdvanceAllowed,
  type RestTimerTickStatus,
} from '../rest-timer-pacing';

const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: () => `qi-${counter++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import { buildPartnerWorkoutPlan } from '../partner-workout-plan';
import { buildPartnerWorkoutPreview, reselectPartnerWorkoutPreview } from '../partner-workout-preview';
import { NO_TOP_UPS, type FetchGradePool } from '../../components/session-screen/pre-session/workout-preview-pool';

const kilterGrades = getGradesForBoard('kilter');
const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard;
const ctx = { board, isAuthenticated: true };

const climbsAt = (grade: number, count: number): Climb[] =>
  Array.from({ length: count }, (_, index) => ({ uuid: `g${grade}-${index}`, name: `g${grade}-${index}` }) as Climb);

/** A catalogue that holds `countByGrade[grade]` climbs at each grade, every one the search can find. */
function catalogue(countByGrade: Record<number, number>): FetchGradePool & { mock: { calls: unknown[][] } } {
  return vi.fn(async (grade: number) => ({
    climbs: climbsAt(grade, countByGrade[grade] ?? 0),
    topUpTiers: NO_TOP_UPS,
    exhausted: true,
  }));
}

function workout(block: CreateWorkout['blocks'][number]): CreateWorkout {
  return { title: 'Partner', externalRef: 'partner', blocks: [block] };
}

async function preview(spec: CreateWorkout, fetchPool: FetchGradePool, avoided?: ReadonlySet<string>) {
  return buildPartnerWorkoutPreview({
    spec,
    partnerPlan: buildPartnerWorkoutPlan(spec, kilterGrades, 'wk_one'),
    grades: kilterGrades,
    ctx,
    fetchPool,
    getAvoidedClimbUuids: avoided ? () => avoided : undefined,
  });
}

beforeEach(() => {
  // Keep every pool in the order the catalogue returns it (Fisher-Yates swaps nothing).
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('partner block advance setting', () => {
  const blocks = [
    { type: 'volume', climbCount: 2, targetGrade: { scale: 'font', value: '6B' }, restSeconds: 120 },
    { type: 'pyramid', climbCount: 2, gradeRange: { scale: 'font', from: '6B', to: '6B' }, restSeconds: 120 },
    { type: 'ladder', climbCount: 2, gradeRange: { scale: 'font', from: '6B', to: '6B' }, restSeconds: 120 },
    { type: 'gradeFocus', climbCount: 2, targetGrade: { scale: 'font', value: '6B' }, restSeconds: 120 },
  ] satisfies CreateWorkout['blocks'];

  async function pacingFor(block: CreateWorkout['blocks'][number]) {
    const built = await preview(workout(block), catalogue({ 18: 4 }));
    const queueItemUuid = built.items[0].uuid;
    const stage = resolveStageRestPacing({
      sessionId: 'session-1',
      run: built.run,
      position: locateInRun(
        built.run,
        queueItemUuid,
        built.items.map((item) => item.uuid),
      ),
      queueItemUuid,
      repsLogged: 1,
    });
    const pacing = resolveEffectiveRestPacing({
      settings: { targetSeconds: 150, mode: 'afterTick', autoAdvance: false },
      stage,
      crew: null,
    });
    const advancesAfter = (status: RestTimerTickStatus) =>
      restAdvanceAllowed({
        advanceOn: pacing.advanceOn,
        currentQueueItemUuid: queueItemUuid,
        lastTick: { status, queueItemUuid },
        stage: pacing.stage,
      });
    return { pacing, advancesAfter };
  }

  it.each(blocks)('lets $type choose whether falls advance', async (block) => {
    for (const advanceOn of ['tick', 'send'] as const) {
      const { pacing, advancesAfter } = await pacingFor({ ...block, advanceOn });
      expect(pacing).toMatchObject({ source: 'stage', targetSeconds: 120, advanceOn, autoAdvance: true });
      expect(advancesAfter('attempt')).toBe(advanceOn === 'tick');
      expect(advancesAfter('send')).toBe(true);
      expect(advancesAfter('flash')).toBe(true);
    }
  });

  it.each(blocks)('preserves $type advancing after falls when the setting is omitted', async (block) => {
    const { pacing, advancesAfter } = await pacingFor(block);
    expect(pacing.advanceOn).toBe('tick');
    expect(advancesAfter('attempt')).toBe(true);
  });

  it('keeps zero rests immediate and missing rests on the climber settings', async () => {
    for (const advanceOn of ['tick', 'send'] as const) {
      const { pacing, advancesAfter } = await pacingFor({ ...blocks[0], restSeconds: 0, advanceOn });
      expect(pacing).toMatchObject({ source: 'stage', targetSeconds: 0, advanceOn });
      expect(advancesAfter('attempt')).toBe(advanceOn === 'tick');
    }
    const { pacing } = await pacingFor({ ...blocks[0], restSeconds: undefined, advanceOn: 'send' });
    expect(pacing).toEqual({
      targetSeconds: 150,
      mode: 'afterTick',
      autoAdvance: false,
      advanceOn: 'deadline',
      source: 'settings',
      stage: null,
    });
  });

  it('keeps the selected rule when reselecting around climbs added by a crewmate', async () => {
    const spec = workout({ ...blocks[0], advanceOn: 'send' });
    const built = await preview(spec, catalogue({ 18: 4 }));
    const again = reselectPartnerWorkoutPreview(
      built,
      spec,
      buildPartnerWorkoutPlan(spec, kilterGrades, 'wk_one').plan,
      new Set([built.items[0].climb.uuid]),
    );
    expect(again.run.stages[0].pacing).toEqual({ mode: 'afterTick', restSeconds: 120, advanceOn: 'send' });
  });
});

describe('partner workout preview', () => {
  it('fills a block short at its grade from the nearest grade, and says so on the row', async () => {
    // Font 6B is one grade (18). It holds 1 climb; 6b+ (19) holds plenty.
    const spec = workout({ type: 'gradeFocus', climbCount: 3, targetGrade: { scale: 'font', value: '6B' } });
    const built = await preview(spec, catalogue({ 18: 1, 19: 10 }));
    expect(built.items).toHaveLength(3);
    expect(built.built.items.map((row) => row.borrowedFrom?.plannedGrade ?? null)).toEqual([null, 18, 18]);
    expect(built.built.items.map((row) => row.slot.grade)).toEqual([18, 19, 19]);
    // Every queued climb belongs to the partner block's stage.
    expect(built.run.stages).toHaveLength(1);
    expect(built.run.stages[0].itemUuids).toEqual(built.items.map((item) => item.uuid));
  });

  it('passes over a climb the session already queued while its grade has others', async () => {
    const spec = workout({ type: 'gradeFocus', climbCount: 2, targetGrade: { scale: 'font', value: '6B' } });
    const queued = new Set(['g18-0', 'g18-1']);
    const built = await preview(spec, catalogue({ 18: 4 }), queued);
    expect(built.items.map((item) => item.climb.uuid)).toEqual(['g18-2', 'g18-3']);
  });

  it('draws a V4 target on Kilter from both 6b and 6b+', async () => {
    const fetchPool = catalogue({ 18: 10, 19: 10 });
    const built = await preview(
      workout({ type: 'volume', climbCount: 4, targetGrade: { scale: 'v', value: 4 } }),
      fetchPool,
    );
    expect(new Set(fetchPool.mock.calls.map(([grade]) => grade))).toEqual(new Set([18, 19]));
    expect(built.built.items.map((row) => row.slot.grade)).toEqual([18, 19, 18, 19]);
  });

  it('fills a thin half of a V band from the other half before the next V grade', async () => {
    // V4 on Kilter is 6b (18) and 6b+ (19). 6b has one climb; 6a+ (17, V3) has
    // plenty, but 6b+ is still V4 and has spare.
    const built = await preview(
      workout({ type: 'gradeFocus', climbCount: 4, targetGrade: { scale: 'v', value: 4 } }),
      catalogue({ 18: 1, 19: 10, 17: 10 }),
    );
    expect(built.items).toHaveLength(4);
    expect(built.built.items.map((row) => row.slot.grade).sort((left, right) => left - right)).toEqual([
      18, 19, 19, 19,
    ]);
  });

  it('keeps the partner block rest on its stage', async () => {
    const built = await preview(
      workout({ type: 'volume', climbCount: 1, restSeconds: 90, targetGrade: { scale: 'font', value: '6B' } }),
      catalogue({ 18: 3 }),
    );
    expect(built.run.stages[0].pacing).toEqual({ mode: 'afterTick', restSeconds: 90, advanceOn: 'tick' });
  });

  it('re-picks the rows whose climb is in the queue now, from the pools it has', async () => {
    const spec = workout({ type: 'gradeFocus', climbCount: 2, targetGrade: { scale: 'font', value: '6B' } });
    const fetchPool = catalogue({ 18: 4 });
    const built = await preview(spec, fetchPool);
    const [first, second] = built.items;
    const plan = buildPartnerWorkoutPlan(spec, kilterGrades, 'wk_one').plan;
    const again = reselectPartnerWorkoutPreview(built, spec, plan, new Set([first.climb.uuid]));
    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(again.items).toHaveLength(2);
    expect(again.items.map((item) => item.climb.uuid)).not.toContain(first.climb.uuid);
    // The untouched row keeps its queue item.
    expect(again.items.find((item) => item.climb.uuid === second.climb.uuid)?.uuid).toBe(second.uuid);
    expect(again.run.stages[0].itemUuids).toEqual(again.items.map((item) => item.uuid));
  });
});

it('queues the same four climbs in four rounds with independent visit identities and durable positions', async () => {
  const spec = workout({
    type: 'fourByFour',
    targetGrade: { scale: 'font', value: '6B' },
    climbCount: 4,
    rounds: 4,
    restBetweenClimbsSeconds: 0,
    restBetweenRoundsSeconds: 180,
  });
  const built = await preview(spec, catalogue({ 18: 10 }));
  expect(built.items).toHaveLength(16);
  expect(new Set(built.items.map((item) => item.uuid)).size).toBe(16);
  const firstRound = built.items.slice(0, 4).map((item) => item.climb.uuid);
  for (let round = 1; round < 4; round++)
    expect(built.items.slice(round * 4, round * 4 + 4).map((item) => item.climb.uuid)).toEqual(firstRound);
  expect(built.run.stages[0]).toMatchObject({
    kind: 'fourByFour',
    pacing: { advanceOn: 'round', rounds: { climbCount: 4, roundCount: 4, restBetweenRoundsSeconds: 180 } },
  });
  const pacing = built.run.stages[0].pacing;
  expect(
    pacing?.mode === 'afterTick' && pacing.advanceOn === 'round'
      ? built.items.map((item) => pacing.rounds.positionByItemUuid[item.uuid])
      : [],
  ).toEqual(Array.from({ length: 16 }, (_, index) => index));
});
