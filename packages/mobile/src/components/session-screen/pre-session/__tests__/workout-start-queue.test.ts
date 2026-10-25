// What Start queues from a preview (#5380): every row once, in plan order,
// under the row's own queue item, a 4x4's included (each row is one set, done
// for every rep), with the queue's cap applied. The summary line counts the same
// queue.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  planFromBlocks,
  type GeneratorOptions,
  type WorkoutBlockSpec,
  type WorkoutPlan,
} from '@boardsesh/playlist-generator';
import { MAX_SYNCED_QUEUE_ITEMS, type ClimbQueueItem } from '@boardsesh/queue';
import type { PreviewItem } from '../workout-preview-pool';
import { stagePreviewQueue, summarizeStartQueue } from '../workout-start-queue';

const workout = (options: GeneratorOptions): WorkoutBlockSpec => ({ kind: 'workout', options });
const fourByFour = (repsPerSet = 4) => workout({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18, repsPerSet });
const volume = workout({ ...DEFAULT_VOLUME_OPTIONS, targetGrade: 16 });

/** A plan whose stage ids are the given names, one per block. */
function planOf(stageIds: string[], blocks: WorkoutBlockSpec[]): WorkoutPlan {
  return planFromBlocks(blocks, (position) => stageIds[position]);
}

/** `count` preview rows of one stage, with slot indexes from `firstIndex`. */
function rowsFor(stageId: string | undefined, count: number, firstIndex = 0): PreviewItem[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = firstIndex + offset;
    return {
      item: { uuid: `${stageId ?? 'none'}-row-${index}`, climb: { uuid: `climb-${index}` } } as ClimbQueueItem,
      slot: { grade: 18, section: 'main', index, ...(stageId === undefined ? {} : { stageId }) },
    };
  });
}

function stage(previews: readonly PreviewItem[], plan: WorkoutPlan) {
  return stagePreviewQueue({ previews, plan, stageIdOf: (preview) => preview.slot.stageId });
}

describe('stagePreviewQueue', () => {
  it('queues a 4x4 as one queue item per set, under the rows’ own uuids, with its sets in the pacing', () => {
    const previews = rowsFor('four', 4);
    const staged = stage(previews, planOf(['four'], [fourByFour(3)]));

    expect(staged.items).toEqual(previews.map((preview) => preview.item));
    const [runStage] = staged.run?.stages ?? [];
    expect(runStage).toEqual({
      id: 'four',
      kind: 'fourByFour',
      itemUuids: previews.map((preview) => preview.item.uuid),
      targetGrade: 18,
      pacing: {
        mode: 'afterTick',
        restSeconds: 0,
        advanceOn: 'set',
        sets: { repsPerSet: 3, restBetweenSetsSeconds: 180 },
      },
    });
  });

  it('queues every stage’s rows once, in plan order', () => {
    const previews = [...rowsFor('warm', 3), ...rowsFor('four', 4, 3)];
    const staged = stage(
      previews,
      planOf(['warm', 'four'], [{ kind: 'warmUp', warmUpType: 'standard' }, fourByFour()]),
    );

    expect(staged.items).toEqual(previews.map((preview) => preview.item));
    expect(staged.run?.stages.map((runStage) => runStage.itemUuids)).toEqual([
      previews.slice(0, 3).map((preview) => preview.item.uuid),
      previews.slice(3).map((preview) => preview.item.uuid),
    ]);
  });

  it('applies the queue cap, and a climb it cuts gets no stage', () => {
    // 498 volume rows, then a 4x4 of 4 sets: 502 climbs, so the last two go.
    const previews = [...rowsFor('vol', 498), ...rowsFor('four', 4, 498)];
    const staged = stage(previews, planOf(['vol', 'four'], [volume, fourByFour()]));

    expect(staged.items).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(staged.run?.stages[1].itemUuids).toEqual(staged.items.slice(498).map((item) => item.uuid));
    expect(staged.run?.stages[1].itemUuids).toHaveLength(2);
  });

  it('queues a row whose stage is unknown with no stage', () => {
    const previews = [...rowsFor('vol', 2), ...rowsFor(undefined, 1, 2)];
    const staged = stage(previews, planOf(['vol'], [volume]));

    expect(staged.items).toHaveLength(3);
    expect(staged.run?.stages.map((runStage) => runStage.itemUuids)).toEqual([['vol-row-0', 'vol-row-1']]);
  });

  it('queues nothing for an empty preview', () => {
    expect(stage([], planOf(['four'], [fourByFour()]))).toEqual({ items: [], run: null });
  });
});

describe('summarizeStartQueue', () => {
  it('counts a 4x4’s sets, one climb each, and gives its time with every rep', () => {
    const plan = planOf(['four'], [fourByFour()]);

    expect(summarizeStartQueue(rowsFor('four', 4), plan.stages)).toEqual({ climbCount: 4, estimatedMinutes: 20 });
  });

  it('gives a limit block its time', () => {
    const plan = planOf(['limit'], [workout({ ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 22 })]);

    expect(summarizeStartQueue(rowsFor('limit', 3), plan.stages)).toEqual({ climbCount: 3, estimatedMinutes: 30 });
  });

  it('counts the rows of an untimed workout and gives no time', () => {
    const plan = planOf(['vol'], [volume]);

    expect(summarizeStartQueue(rowsFor('vol', 20), plan.stages)).toEqual({ climbCount: 20, estimatedMinutes: null });
  });

  it('is empty for no rows', () => {
    expect(summarizeStartQueue([], [])).toEqual({ climbCount: 0, estimatedMinutes: null });
  });
});
