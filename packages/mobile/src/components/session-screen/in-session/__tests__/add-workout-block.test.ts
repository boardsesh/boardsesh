import { describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { addWorkoutBlock, appendBlockToRun, defaultMidSessionBlock } from '../add-workout-block';

const item = (uuid: string) => ({ uuid, climb: { uuid: `climb-${uuid}` } }) as unknown as ClimbQueueItem;

const existingRun: WorkoutRun = {
  stages: [
    { id: 'stage-warm', kind: 'warmUp', itemUuids: ['w1'] },
    { id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1', 'p2'], targetGrade: 18 },
  ],
};
const blockRun: WorkoutRun = {
  stages: [{ id: 'b1e4c0de-uuid', kind: 'ladder', itemUuids: ['l1', 'l2', 'l3'], targetGrade: 20 }],
};
const blockItems = [item('l1'), item('l2'), item('l3')];

describe('addWorkoutBlock', () => {
  it('appends with no options, so the climb on the wall never changes', () => {
    const appendQueueItems = vi.fn((items: ClimbQueueItem[]) => items.length);
    addWorkoutBlock({ items: blockItems, blockRun, existingRun, appendQueueItems });

    expect(appendQueueItems).toHaveBeenCalledTimes(1);
    // Exactly one argument: no `activateFirstWhenIdle`.
    expect(appendQueueItems.mock.calls[0]).toEqual([blockItems]);
  });

  it('adds the block as a new stage after the existing run, keeping its uuid id and grade', () => {
    const result = addWorkoutBlock({
      items: blockItems,
      blockRun,
      existingRun,
      appendQueueItems: (items) => items.length,
    });

    expect(result).toEqual({
      landedCount: 3,
      addedStageCount: 1,
      run: {
        stages: [
          ...existingRun.stages,
          { id: 'b1e4c0de-uuid', kind: 'ladder', itemUuids: ['l1', 'l2', 'l3'], targetGrade: 20 },
        ],
      },
    });
    // The stored run is not mutated in place.
    expect(existingRun.stages).toHaveLength(2);
  });

  it('starts a run from the block when the session had none', () => {
    const result = addWorkoutBlock({
      items: blockItems,
      blockRun,
      existingRun: null,
      appendQueueItems: (items) => items.length,
    });

    expect(result.run).toEqual(blockRun);
    expect(result.addedStageCount).toBe(1);
  });

  it('stages only the climbs the queue took when its cap clamps the batch', () => {
    const result = addWorkoutBlock({ items: blockItems, blockRun, existingRun: null, appendQueueItems: () => 2 });

    expect(result.landedCount).toBe(2);
    expect(result.run?.stages[0].itemUuids).toEqual(['l1', 'l2']);
  });

  it('returns no run when the queue took nothing', () => {
    const result = addWorkoutBlock({ items: blockItems, blockRun, existingRun, appendQueueItems: () => 0 });

    expect(result).toEqual({ landedCount: 0, run: null, addedStageCount: 0 });
  });

  it('does not touch the queue for an empty block', () => {
    const appendQueueItems = vi.fn(() => 0);
    addWorkoutBlock({ items: [], blockRun, existingRun, appendQueueItems });

    expect(appendQueueItems).not.toHaveBeenCalled();
  });
});

describe('appendBlockToRun', () => {
  it('skips a climb that is already in the run', () => {
    const run = appendBlockToRun(
      existingRun,
      { stages: [{ id: 'stage-new', kind: 'volume', itemUuids: ['p1', 'v1'] }] },
      ['p1', 'v1'],
    );

    expect(run.stages[2]).toEqual({ id: 'stage-new', kind: 'volume', itemUuids: ['v1'] });
  });
});

describe('defaultMidSessionBlock', () => {
  it('follows the last workout stage, skipping a warm-up after it', () => {
    const run: WorkoutRun = {
      stages: [...existingRun.stages, { id: 'late-warm', kind: 'warmUp', itemUuids: ['w9'] }],
    };
    const options = defaultMidSessionBlock(run, 12);

    expect(options.type).toBe('pyramid');
    expect(options.targetGrade).toBe(18);
    expect(options.warmUp).toBe('none');
  });

  it('opens on a volume block at the fallback grade without a run', () => {
    const options = defaultMidSessionBlock(null, 12);

    expect(options.type).toBe('volume');
    expect(options.targetGrade).toBe(12);
  });

  it('keeps the type but takes the fallback grade for a stage stored without one', () => {
    const options = defaultMidSessionBlock({ stages: [{ id: 'old', kind: 'ladder', itemUuids: ['l1'] }] }, 12);

    expect(options.type).toBe('ladder');
    expect(options.targetGrade).toBe(12);
  });
});
