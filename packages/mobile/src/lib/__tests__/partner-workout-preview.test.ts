// A partner app's workout fills its blocks through the app's own preview
// pipeline (#5399, F6 of workoutbash1): a short grade borrows from the nearest
// one, a climb the session already queued is passed over, and a V target draws
// from its whole band on the board.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { CreateWorkout } from '@boardsesh/public-api';
import { getGradesForBoard } from '@boardsesh/board-config';

const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: () => `qi-${counter++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import { locateInRun } from '@boardsesh/playlist-generator';
import { buildPartnerWorkoutPlan } from '../partner-workout-plan';
import { buildPartnerWorkoutPreview, reselectPartnerWorkoutPreview } from '../partner-workout-preview';
import { NO_TOP_UPS, type FetchGradePool } from '../../components/session-screen/pre-session/workout-preview-pool';
import {
  resolveEffectiveRestPacing,
  resolveStageRestPacing,
  restAdvanceAllowed,
  type RestPacingSettings,
  type RestTimerTickStatus,
} from '../rest-timer-pacing';

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

// workoutbash1 D4: a partner block's rest moves the wall on after a send, like
// limit bouldering; a fall rests and keeps the climb up. A rest of 0 hands the
// timer back to the climber's own settings.
describe('partner block rest', () => {
  const climberSettings: RestPacingSettings = { targetSeconds: 150, mode: 'afterTick', autoAdvance: false };

  /** The timer's pacing for the block's first climb, and whether a finished rest after `status` moves the wall. */
  async function restAfter(block: CreateWorkout['blocks'][number], status: RestTimerTickStatus) {
    const built = await preview(workout(block), catalogue({ 18: 3 }));
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
    const pacing = resolveEffectiveRestPacing({ settings: climberSettings, stage, crew: null });
    const movesOn = restAdvanceAllowed({
      advanceOn: pacing.advanceOn,
      currentQueueItemUuid: queueItemUuid,
      lastTick: { status, queueItemUuid },
      stage: pacing.stage,
    });
    return { pacing, movesOn };
  }

  const volume = (restSeconds?: number): CreateWorkout['blocks'][number] => ({
    type: 'volume',
    climbCount: 2,
    targetGrade: { scale: 'font', value: '6B' },
    ...(restSeconds === undefined ? {} : { restSeconds }),
  });

  it('rests 120 s after a fall and keeps the climb on the wall', async () => {
    const { pacing, movesOn } = await restAfter(volume(120), 'attempt');
    expect(pacing).toMatchObject({ source: 'stage', mode: 'afterTick', targetSeconds: 120, autoAdvance: true });
    expect(movesOn).toBe(false);
  });

  it('moves the wall on once the 120 s rest after a send runs out', async () => {
    for (const status of ['send', 'flash'] as const) {
      const { pacing, movesOn } = await restAfter(volume(120), status);
      expect(pacing).toMatchObject({ source: 'stage', targetSeconds: 120, advanceOn: 'send' });
      expect(movesOn).toBe(true);
    }
  });

  it('paces pyramid, ladder and grade focus the same way', async () => {
    const gradeRange = { scale: 'font', from: '6B', to: '6B' } as const;
    const blocks: CreateWorkout['blocks'] = [
      { type: 'pyramid', climbCount: 3, gradeRange, restSeconds: 60 },
      { type: 'ladder', climbCount: 2, gradeRange, restSeconds: 60 },
      { type: 'gradeFocus', climbCount: 2, targetGrade: { scale: 'font', value: '6B' }, restSeconds: 60 },
    ];
    for (const block of blocks) {
      expect((await restAfter(block, 'attempt')).movesOn).toBe(false);
      expect((await restAfter(block, 'send')).movesOn).toBe(true);
    }
  });

  it("runs a rest of 0 on the climber's own settings, with no 10 s changeover", async () => {
    for (const restSeconds of [0, undefined]) {
      const { pacing } = await restAfter(volume(restSeconds), 'attempt');
      expect(pacing).toEqual({
        targetSeconds: 150,
        mode: 'afterTick',
        autoAdvance: false,
        advanceOn: 'deadline',
        source: 'settings',
        stage: null,
      });
    }
  });
});
