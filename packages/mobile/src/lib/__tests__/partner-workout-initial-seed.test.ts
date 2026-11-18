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
          pacing: { mode: 'afterTick', advanceOn: 'tick', restSeconds: 20 },
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

  it('trims accepted queue items and both plans to the same v1 item budget', () => {
    const items = Array.from({ length: MAX_SESSION_WORKOUT_ITEMS + 1 }, (_, index) => item(`partner-${index}`));
    const result = seed(items);
    expect(result.landedItems).toHaveLength(MAX_SESSION_WORKOUT_ITEMS);
    expect(result.seed.queue).toHaveLength(MAX_SESSION_WORKOUT_ITEMS);
    expect(result.seed.sessionPlan.stages[0].items).toHaveLength(MAX_SESSION_WORKOUT_ITEMS);
    expect(result.seed.plan[0].climbUuids).toHaveLength(MAX_SESSION_WORKOUT_ITEMS);
  });

  it('preserves the solo queue when only one generated climb fits', () => {
    const old = Array.from({ length: MAX_SYNCED_QUEUE_ITEMS - 1 }, (_, index) => item(`old-${index}`));
    const result = seed([item('first'), item('second')], old);
    expect(result.seed.queue.slice(0, old.length)).toEqual(old);
    expect(result.landedItems.map(({ uuid }) => uuid)).toEqual(['first']);
    expect(result.seed.plan[0].climbUuids).toEqual(['climb-first']);
  });

  it('after restart restores the persisted winner and pacing, excluding a regenerated preview', () => {
    const winning = seed([item('winning')]).seed.sessionPlan;
    seed([item('regenerated')]);
    const restored = restorePartnerWorkoutRun(JSON.parse(JSON.stringify(winning)));
    expect(restored?.run.stages[0].itemUuids).toEqual(['winning']);
    expect(restored?.run.stages[0].pacing).toEqual({ mode: 'afterTick', advanceOn: 'tick', restSeconds: 20 });
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
