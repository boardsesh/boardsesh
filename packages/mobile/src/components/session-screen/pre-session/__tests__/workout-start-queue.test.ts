// What Start queues from a preview (#5380): a 4x4's rows once per round,
// round-major, under fresh uuids past round 1, with the queue's cap applied after
// the expansion. The summary line counts the same queue.
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
import { countFilledSlots, stagePreviewQueue, summarizeStartQueue, withoutQueuedSlots } from '../workout-start-queue';

const workout = (options: GeneratorOptions): WorkoutBlockSpec => ({ kind: 'workout', options });
const fourByFour = (rounds = 4) => workout({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18, rounds });
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

/** `mintPrefix` names one hand-over's round copies, so two hand-overs of a preview mint different ones, as `randomUUID` does. */
function stage(previews: readonly PreviewItem[], plan: WorkoutPlan, mintPrefix = 'copy') {
  let minted = 0;
  return stagePreviewQueue({
    previews,
    plan,
    stageIdOf: (preview) => preview.slot.stageId,
    mintUuid: () => `${mintPrefix}-${minted++}`,
  });
}

describe('stagePreviewQueue', () => {
  it('queues a 4x4 round-major, round 1 under the rows own uuids and every copy under a fresh one', () => {
    const previews = rowsFor('four', 4);
    const staged = stage(previews, planOf(['four'], [fourByFour()]));

    expect(staged.items.map((item) => item.climb.uuid)).toEqual([
      'climb-0',
      'climb-1',
      'climb-2',
      'climb-3',
      'climb-0',
      'climb-1',
      'climb-2',
      'climb-3',
      'climb-0',
      'climb-1',
      'climb-2',
      'climb-3',
      'climb-0',
      'climb-1',
      'climb-2',
      'climb-3',
    ]);
    expect(staged.items.slice(0, 4)).toEqual(previews.map((preview) => preview.item));
    expect(new Set(staged.items.map((item) => item.uuid)).size).toBe(16);

    const [runStage] = staged.run?.stages ?? [];
    expect(runStage).toMatchObject({ id: 'four', kind: 'fourByFour', rounds: 4 });
    expect(runStage.itemUuids).toEqual(staged.items.map((item) => item.uuid));
    expect(staged.items.map((item) => runStage.roundByUuid?.[item.uuid])).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
    ]);
  });

  it('counts a row once however many rounds it runs, and maps each copy to its row', () => {
    const staged = stage(rowsFor('four', 4), planOf(['four'], [fourByFour()]));

    expect(staged.filledSlotCount).toBe(4);
    expect(staged.items.map((item) => staged.slotIndexByUuid.get(item.uuid))).toEqual([
      0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3,
    ]);
  });

  it('queues the rows of a stage without rounds once and with no round', () => {
    const previews = [...rowsFor('warm', 3), ...rowsFor('four', 4, 3)];
    const staged = stage(
      previews,
      planOf(['warm', 'four'], [{ kind: 'warmUp', warmUpType: 'standard' }, fourByFour(2)]),
    );

    expect(staged.items).toHaveLength(3 + 8);
    expect(staged.items.slice(0, 3)).toEqual(previews.slice(0, 3).map((preview) => preview.item));
    const [warmUpStage, fourStage] = staged.run?.stages ?? [];
    expect(warmUpStage).toEqual({
      id: 'warm',
      kind: 'warmUp',
      itemUuids: previews.slice(0, 3).map((p) => p.item.uuid),
    });
    expect(fourStage.itemUuids).toHaveLength(8);
    expect(Object.values(fourStage.roundByUuid ?? {})).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(staged.filledSlotCount).toBe(7);
  });

  it('still numbers the one round of a single-round 4x4', () => {
    const staged = stage(rowsFor('four', 3), planOf(['four'], [fourByFour(1)]));

    expect(staged.items).toHaveLength(3);
    expect(staged.run?.stages[0].roundByUuid).toEqual(Object.fromEntries(staged.items.map((item) => [item.uuid, 1])));
  });

  it('applies the queue cap after the rounds, and a climb it cuts gets no stage', () => {
    // 490 volume rows, then a 4x4 of 4 x 4: 506 climbs, so the last six go.
    const previews = [...rowsFor('vol', 490), ...rowsFor('four', 4, 490)];
    const staged = stage(previews, planOf(['vol', 'four'], [volume, fourByFour()]));

    expect(staged.items).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    const fourStage = staged.run?.stages[1];
    expect(fourStage?.itemUuids).toEqual(staged.items.slice(490).map((item) => item.uuid));
    expect(Object.values(fourStage?.roundByUuid ?? {})).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    expect(staged.filledSlotCount).toBe(494);
  });

  it('counts only the slots a cut leaves queued', () => {
    // The cap lands inside the 4x4's first round: two of its four slots queue.
    const previews = [...rowsFor('vol', 498), ...rowsFor('four', 4, 498)];
    const staged = stage(previews, planOf(['vol', 'four'], [volume, fourByFour()]));

    expect(staged.run?.stages[1].itemUuids).toHaveLength(2);
    expect(staged.filledSlotCount).toBe(500);
  });

  it('queues a row whose stage is unknown with no stage', () => {
    const previews = [...rowsFor('vol', 2), ...rowsFor(undefined, 1, 2)];
    const staged = stage(previews, planOf(['vol'], [volume]));

    expect(staged.items).toHaveLength(3);
    expect(staged.run?.stages.map((runStage) => runStage.itemUuids)).toEqual([['vol-row-0', 'vol-row-1']]);
  });

  it('queues nothing for an empty preview', () => {
    expect(stage([], planOf(['four'], [fourByFour()]))).toEqual({
      items: [],
      run: null,
      slotIndexByUuid: new Map(),
      filledSlotCount: 0,
    });
  });
});

describe('countFilledSlots', () => {
  it('counts the slots a subset of the queued climbs fills, each once', () => {
    const staged = stage(rowsFor('four', 4), planOf(['four'], [fourByFour()]));
    const landed = staged.items.slice(0, 6).map((item) => item.uuid);

    expect(countFilledSlots(staged.slotIndexByUuid, landed)).toBe(4);
    expect(countFilledSlots(staged.slotIndexByUuid, landed.slice(0, 2))).toBe(2);
    expect(countFilledSlots(staged.slotIndexByUuid, ['not-queued'])).toBe(0);
  });
});

describe('withoutQueuedSlots', () => {
  it('drops every round of a slot whose first round is queued, and keeps the other slots whole', () => {
    const plan = planOf(['four'], [fourByFour()]);
    const previews = rowsFor('four', 4);
    // A second hand-over of the same preview: round 1 again, fresh copies.
    const firstAdd = stage(previews, plan, 'first');
    const secondAdd = stage(previews, plan, 'second');
    const queued = new Set(firstAdd.items.slice(0, 1).map((item) => item.uuid));

    const kept = withoutQueuedSlots(secondAdd.items, secondAdd.slotIndexByUuid, queued);

    expect(kept).toHaveLength(12);
    expect(kept.some((item) => item.climb.uuid === 'climb-0')).toBe(false);
  });

  it('keeps nothing when the whole preview is already queued', () => {
    const plan = planOf(['four'], [fourByFour()]);
    const previews = rowsFor('four', 4);
    const firstAdd = stage(previews, plan, 'first');
    const secondAdd = stage(previews, plan, 'second');
    const queued = new Set(firstAdd.items.map((item) => item.uuid));
    // Rounds 2 to 4 come back under uuids the queue has never seen, so a uuid
    // check alone would queue 12 climbs again.
    expect(secondAdd.items.filter((item) => !queued.has(item.uuid))).toHaveLength(12);

    expect(withoutQueuedSlots(secondAdd.items, secondAdd.slotIndexByUuid, queued)).toEqual([]);
  });

  it('drops a queued climb that has no slot and keeps one that is not queued', () => {
    const items = rowsFor(undefined, 2).map((preview) => preview.item);

    expect(withoutQueuedSlots(items, new Map(), new Set([items[0].uuid]))).toEqual([items[1]]);
  });
});

describe('summarizeStartQueue', () => {
  it('counts every round of a 4x4 and gives its time', () => {
    const plan = planOf(['four'], [fourByFour()]);

    expect(summarizeStartQueue(rowsFor('four', 4), plan.stages)).toEqual({ climbCount: 16, estimatedMinutes: 25 });
  });

  it('gives a limit block its time', () => {
    const plan = planOf(['limit'], [workout({ ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 22 })]);

    expect(summarizeStartQueue(rowsFor('limit', 3), plan.stages)).toEqual({ climbCount: 3, estimatedMinutes: 15 });
  });

  it('counts the rows of an untimed workout and gives no time', () => {
    const plan = planOf(['vol'], [volume]);

    expect(summarizeStartQueue(rowsFor('vol', 20), plan.stages)).toEqual({ climbCount: 20, estimatedMinutes: null });
  });

  it('is empty for no rows', () => {
    expect(summarizeStartQueue([], [])).toEqual({ climbCount: 0, estimatedMinutes: null });
  });
});
