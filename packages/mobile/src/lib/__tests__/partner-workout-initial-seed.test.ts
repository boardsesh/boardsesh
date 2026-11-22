import { describe, expect, it } from 'vite-plus/test';
import { MAX_SYNCED_QUEUE_ITEMS, type ClimbQueueItem } from '@boardsesh/queue';
import { MAX_SESSION_WORKOUT_ITEMS } from '@boardsesh/workout-summary';
import { buildPartnerWorkoutInitialSeed, restorePartnerWorkoutRun } from '../partner-workout-initial-seed';

function item(uuid: string): ClimbQueueItem {
  return { uuid, climb: { uuid: `climb-${uuid}`, angle: 40, mirrored: true } } as ClimbQueueItem;
}
function seed(
  items: ClimbQueueItem[],
  queue: ClimbQueueItem[] = [],
  current: ClimbQueueItem | null = null,
  historyCount?: number,
  advanceOn: 'tick' | 'send' = 'tick',
) {
  return buildPartnerWorkoutInitialSeed({
    workoutId: 'wk',
    blockCount: 2,
    items,
    queue,
    currentClimbQueueItem: current,
    historyCount,
    run: {
      stages: [
        {
          id: 'wk:0',
          kind: 'volume',
          itemUuids: items.map(({ uuid }) => uuid),
          pacing: { mode: 'afterTick', advanceOn, restSeconds: 20 },
        },
      ],
    },
  });
}

describe('atomic partner first seed', () => {
  it('retains solo History with nothing current and places partner climbs in Up next', () => {
    const old = [item('old-1'), item('old-2')];
    const next = item('next');
    const result = seed([next], old, null, 2).seed;
    expect(result.queue).toEqual([...old, next]);
    expect(result.currentClimbQueueItem).toBeNull();
    expect(result.historyCount).toBe(2);
    expect(result.plan).toEqual([
      { index: 0, climbUuids: ['climb-next'] },
      { index: 1, climbUuids: [] },
    ]);
    expect(result.sessionPlan.stages[0].items.map(({ queueItemUuid }) => queueItemUuid)).toEqual(['next']);
  });

  it('normalizes an orphan current at the saved solo boundary before appending', () => {
    const solo = [item('history'), item('waiting')];
    const current = item('current');
    const result = seed([item('partner')], solo, current, 1).seed;
    expect(result.queue.map(({ uuid }) => uuid)).toEqual(['history', 'current', 'waiting', 'partner']);
    expect(result.currentClimbQueueItem).toBe(current);
    expect(result.historyCount).toBe(1);
  });

  it('rejects oversized plans without truncating their requested visits', () => {
    const items = Array.from({ length: MAX_SESSION_WORKOUT_ITEMS + 1 }, (_, index) => item(`partner-${index}`));
    expect(() => seed(items)).toThrow('capacity');
  });

  it('refuses Start when the complete workout does not fit beside the solo queue', () => {
    const old = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS - 1 }, (_, index) => item(`old-${index}`));
    expect(() => seed([item('first'), item('second')], old)).toThrow('capacity');
    expect(old).toHaveLength(MAX_SYNCED_QUEUE_ITEMS - 1);
  });

  it.each(['tick', 'send'] as const)('after restart restores the persisted winner and %s pacing', (advanceOn) => {
    const winning = seed([item('winning')], [], null, undefined, advanceOn).seed.sessionPlan;
    seed([item('regenerated')]);
    const restored = restorePartnerWorkoutRun(JSON.parse(JSON.stringify(winning)));
    expect(restored?.run.stages[0].itemUuids).toEqual(['winning']);
    expect(restored?.run.stages[0].pacing).toEqual({ mode: 'afterTick', advanceOn, restSeconds: 20 });
    expect(restored?.climbs).toEqual({ winning: { climbUuid: 'climb-winning', angle: 40, isMirror: true } });
  });

  it('keeps all empty freeform blocks without inventing native stages', () => {
    const result = seed([]).seed;
    expect(result.queue).toEqual([]);
    expect(result.plan).toEqual([
      { index: 0, climbUuids: [] },
      { index: 1, climbUuids: [] },
    ]);
    expect(result.sessionPlan).toEqual({ version: 1, stages: [] });
  });
});

it('restores exact round ordinals after a lost Start reply even when a visit was removed', () => {
  const winning = {
    version: 1,
    stages: [
      {
        id: 'wk:0',
        kind: 'fourByFour',
        pacing: {
          mode: 'afterTick',
          restSeconds: 0,
          advanceOn: 'round',
          roundCount: 4,
          climbsPerRound: 4,
          restBetweenRoundsSeconds: 180,
        },
        items: [
          { queueItemUuid: 'round-two-A', climbUuid: 'A', angle: 40, position: 4 },
          { queueItemUuid: 'round-four-D', climbUuid: 'D', angle: 40, position: 15 },
        ],
      },
    ],
  };
  const restored = restorePartnerWorkoutRun(JSON.parse(JSON.stringify(winning)));
  expect(restored?.run.stages[0].pacing).toEqual({
    mode: 'afterTick',
    restSeconds: 0,
    advanceOn: 'round',
    rounds: {
      climbCount: 4,
      roundCount: 4,
      restBetweenRoundsSeconds: 180,
      positionByItemUuid: { 'round-two-A': 4, 'round-four-D': 15 },
    },
  });
});
