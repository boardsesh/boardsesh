import { describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutRun, WorkoutStageFilters } from '@boardsesh/playlist-generator';
import { DEFAULT_WORKOUT_FILTERS, buildDefaultOptions } from '../../pre-session/workout-blocks';
import {
  addWorkoutBlock,
  appendBlockToRun,
  defaultMidSessionBlock,
  defaultMidSessionFilters,
} from '../add-workout-block';

const STRICT: WorkoutStageFilters = {
  climbBias: 'any',
  minAscents: 50,
  minRating: 3,
  onlyTallClimbs: true,
  onlyWideClimbs: false,
};

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

  it("keeps the block's filters on its stage", () => {
    const run = appendBlockToRun(
      existingRun,
      { stages: [{ id: 'stage-new', kind: 'volume', itemUuids: ['v1'], targetGrade: 16, filters: STRICT }] },
      ['v1'],
    );

    expect(run.stages[2]).toEqual({
      id: 'stage-new',
      kind: 'volume',
      itemUuids: ['v1'],
      targetGrade: 16,
      filters: STRICT,
    });
  });
});

describe('defaultMidSessionFilters', () => {
  it("takes the last stage's filters, a warm-up's included", () => {
    const run: WorkoutRun = {
      stages: [
        { id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18, filters: DEFAULT_WORKOUT_FILTERS },
        { id: 'late-warm', kind: 'warmUp', itemUuids: ['w9'], filters: STRICT },
      ],
    };

    expect(defaultMidSessionFilters(run)).toEqual(STRICT);
    expect(defaultMidSessionFilters(run)).not.toBe(STRICT);
  });

  it('skips a stage stored without filters for an earlier one that kept them', () => {
    const run: WorkoutRun = {
      stages: [
        { id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18, filters: STRICT },
        { id: 'old', kind: 'volume', itemUuids: ['v1'] },
      ],
    };

    expect(defaultMidSessionFilters(run)).toEqual(STRICT);
  });

  it('falls back to the generator defaults with no run, or a run stored before stages kept filters', () => {
    expect(defaultMidSessionFilters(null)).toEqual(DEFAULT_WORKOUT_FILTERS);
    expect(defaultMidSessionFilters(existingRun)).toEqual(DEFAULT_WORKOUT_FILTERS);
  });
});

describe('defaultMidSessionBlock', () => {
  it('follows the last workout stage, skipping a warm-up after it', () => {
    const run: WorkoutRun = {
      stages: [...existingRun.stages, { id: 'late-warm', kind: 'warmUp', itemUuids: ['w9'] }],
    };
    const options = defaultMidSessionBlock(run, 12, false);

    expect(options.type).toBe('pyramid');
    expect(options.targetGrade).toBe(18);
    expect(options.warmUp).toBe('none');
  });

  it('opens on a volume block at the fallback grade without a run', () => {
    const options = defaultMidSessionBlock(null, 12, false);

    expect(options.type).toBe('volume');
    expect(options.targetGrade).toBe(12);
  });

  it('keeps the type but takes the fallback grade for a stage stored without one', () => {
    const options = defaultMidSessionBlock({ stages: [{ id: 'old', kind: 'ladder', itemUuids: ['l1'] }] }, 12, false);

    expect(options.type).toBe('ladder');
    expect(options.targetGrade).toBe(12);
  });

  describe('after a timed stage', () => {
    const runEndingWith = (kind: 'fourByFour' | 'limitBouldering' | 'onTheMinute'): WorkoutRun => ({
      stages: [...existingRun.stages, { id: 'timed', kind, itemUuids: ['t1', 't2'], targetGrade: 22 }],
    });

    // A store build with the flag off offers no timed chip, and a timed stage can
    // still reach it: a run stored with the flag on, or read after an OTA rollback.
    it.each(['fourByFour', 'limitBouldering', 'onTheMinute'] as const)(
      'opens on a volume block at the stage grade after a %s stage when timed blocks are not offered',
      (kind) => {
        const options = defaultMidSessionBlock(runEndingWith(kind), 12, false);

        // The same as a volume block opened at that grade: no reps or rest fields carried over.
        expect(options).toEqual(defaultMidSessionBlock(null, 22, false));
        expect(options.type).toBe('volume');
      },
    );

    it.each(['fourByFour', 'limitBouldering', 'onTheMinute'] as const)(
      'opens on another %s block at the stage grade when timed blocks are offered',
      (kind) => {
        expect(defaultMidSessionBlock(runEndingWith(kind), 12, true)).toEqual({
          ...buildDefaultOptions(kind, 22),
          warmUp: 'none',
        });
      },
    );
  });
});
