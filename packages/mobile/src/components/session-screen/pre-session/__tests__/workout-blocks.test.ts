import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  generateStagedPlan,
  planFromBlocks,
  type GeneratorGradeScale,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';
import {
  MAX_WORKOUT_BLOCKS,
  NO_WORKOUT,
  addBlock,
  canAddBlock,
  changeBlockType,
  firstWorkoutType,
  hasWorkoutBlocks,
  moveBlock,
  nextBlockType,
  removeBlock,
  selectionWorkoutTypes,
  singleBlockSelection,
  updateBlock,
  updateFilters,
  warmUpTarget,
  type GeneratorSelection,
  type WorkoutBlock,
} from '../workout-blocks';

const FALLBACK_GRADE = 15;
const GRADES: GeneratorGradeScale = Array.from({ length: 30 }, (_, index) => ({ difficulty_id: index + 1 }));

const counterIds = () => {
  let nextId = 0;
  return () => `block-${nextId++}`;
};

const workout = (id: string, options: GeneratorOptions): WorkoutBlock => ({ id, kind: 'workout', options });
const warmUp = (id: string): WorkoutBlock => ({ id, kind: 'warmUp', warmUpType: 'standard' });

function withBlocks(blocks: WorkoutBlock[]): GeneratorSelection {
  return { ...NO_WORKOUT, blocks };
}

function addedBlocks(count: number): GeneratorSelection {
  const makeId = counterIds();
  let selection = NO_WORKOUT;
  for (let added = 0; added < count; added++) selection = addBlock(selection, makeId, FALLBACK_GRADE);
  return selection;
}

const ids = (selection: GeneratorSelection) => selection.blocks.map((block) => block.id);

describe('no blocks', () => {
  it('is no workout, and keeps the filters the climber set', () => {
    const filtered = updateFilters(addedBlocks(1), { minAscents: 50, climbBias: 'attempted' });
    const emptied = removeBlock(filtered, 'block-0');

    expect(hasWorkoutBlocks(NO_WORKOUT)).toBe(false);
    expect(hasWorkoutBlocks(emptied)).toBe(false);
    expect(emptied.filters).toMatchObject({ minAscents: 50, climbBias: 'attempted' });
  });
});

describe('nextBlockType', () => {
  it('walks the workout types and wraps round', () => {
    expect(nextBlockType('volume')).toBe('pyramid');
    expect(nextBlockType('pyramid')).toBe('ladder');
    expect(nextBlockType('ladder')).toBe('gradeFocus');
    expect(nextBlockType('gradeFocus')).toBe('volume');
  });
});

describe('addBlock', () => {
  it('starts a workout with Volume at the fallback grade', () => {
    expect(addedBlocks(1).blocks).toEqual([
      workout('block-0', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: FALLBACK_GRADE }),
    ]);
  });

  it("follows the last workout block's type and grade, past a warm-up after it", () => {
    const selection = withBlocks([workout('pyramid', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 20 }), warmUp('warm')]);

    expect(addBlock(selection, () => 'added', FALLBACK_GRADE).blocks.at(-1)).toEqual(
      workout('added', { ...DEFAULT_LADDER_OPTIONS, targetGrade: 20 }),
    );
  });

  it(`stops at ${MAX_WORKOUT_BLOCKS} blocks, warm-ups counted like any block`, () => {
    const full = withBlocks([warmUp('w0'), ...addedBlocks(MAX_WORKOUT_BLOCKS - 2).blocks, warmUp('w1')]);

    expect(full.blocks).toHaveLength(MAX_WORKOUT_BLOCKS);
    expect(canAddBlock(full)).toBe(false);
    expect(addBlock(full, () => 'one-too-many', FALLBACK_GRADE)).toBe(full);
    expect(canAddBlock(removeBlock(full, 'w0'))).toBe(true);
  });
});

describe('removeBlock', () => {
  it('drops any block, the first included, and keeps the rest in order', () => {
    const selection = addedBlocks(3);

    expect(ids(removeBlock(selection, 'block-0'))).toEqual(['block-1', 'block-2']);
    expect(ids(removeBlock(selection, 'block-1'))).toEqual(['block-0', 'block-2']);
  });

  it('returns the same selection for an unknown block', () => {
    const selection = addedBlocks(1);

    expect(removeBlock(selection, 'missing')).toBe(selection);
  });
});

describe('moveBlock', () => {
  it('moves any block, the first included', () => {
    const selection = addedBlocks(3);

    expect(ids(moveBlock(selection, 'block-0', 'down'))).toEqual(['block-1', 'block-0', 'block-2']);
    expect(ids(moveBlock(selection, 'block-1', 'up'))).toEqual(['block-1', 'block-0', 'block-2']);
    expect(ids(moveBlock(selection, 'block-1', 'down'))).toEqual(['block-0', 'block-2', 'block-1']);
  });

  it('never moves a block past either end', () => {
    const selection = addedBlocks(2);

    expect(moveBlock(selection, 'block-0', 'up')).toBe(selection);
    expect(moveBlock(selection, 'block-1', 'down')).toBe(selection);
    expect(moveBlock(selection, 'missing', 'down')).toBe(selection);
  });
});

describe('changeBlockType', () => {
  it("switches a workout to another type's defaults and keeps its grade", () => {
    const selection = withBlocks([workout('ladder', { ...DEFAULT_LADDER_OPTIONS, targetGrade: 14, numberOfSteps: 9 })]);

    expect(changeBlockType(selection, 'ladder', 'gradeFocus', FALLBACK_GRADE).blocks[0]).toEqual(
      workout('ladder', { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 14 }),
    );
  });

  it('turns a workout into a standard warm-up with no grade of its own', () => {
    expect(changeBlockType(addedBlocks(1), 'block-0', 'warmUp', FALLBACK_GRADE).blocks[0]).toEqual(warmUp('block-0'));
  });

  it("turns a warm-up into a workout at the next workout block's grade, else the previous one's", () => {
    const selection = withBlocks([
      workout('before', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 8 }),
      warmUp('warm'),
      workout('after', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 22 }),
    ]);

    expect(changeBlockType(selection, 'warm', 'ladder', FALLBACK_GRADE).blocks[1]).toEqual(
      workout('warm', { ...DEFAULT_LADDER_OPTIONS, targetGrade: 22 }),
    );
    expect(changeBlockType(removeBlock(selection, 'after'), 'warm', 'ladder', FALLBACK_GRADE).blocks[1]).toEqual(
      workout('warm', { ...DEFAULT_LADDER_OPTIONS, targetGrade: 8 }),
    );
    expect(changeBlockType(withBlocks([warmUp('warm')]), 'warm', 'volume', FALLBACK_GRADE).blocks[0]).toEqual(
      workout('warm', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: FALLBACK_GRADE }),
    );
  });

  it('keeps the block untouched when its type is picked again', () => {
    const selection = withBlocks([warmUp('warm'), ...addedBlocks(1).blocks]);

    expect(changeBlockType(selection, 'block-0', 'volume', FALLBACK_GRADE)).toBe(selection);
    expect(changeBlockType(selection, 'warm', 'warmUp', FALLBACK_GRADE)).toBe(selection);
  });
});

describe('updateBlock', () => {
  it("replaces a block's settings in place, keeping its id", () => {
    const selection = withBlocks([warmUp('warm'), ...addedBlocks(1).blocks]);
    const updated = updateBlock(selection, 'warm', { kind: 'warmUp', warmUpType: 'extended' });

    expect(updated.blocks[0]).toEqual({ id: 'warm', kind: 'warmUp', warmUpType: 'extended' });
    expect(updated.blocks[1]).toBe(selection.blocks[1]);
  });
});

describe('warm-ups in the plan', () => {
  const blocks = [
    workout('first', { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 10, numberOfClimbs: 1 }),
    warmUp('middle'),
    workout('third', { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 20, numberOfClimbs: 2 }),
    warmUp('trailing'),
  ];
  const plannedSlots = () =>
    generateStagedPlan(
      planFromBlocks(blocks, (position) => blocks[position].id),
      GRADES,
    );

  it("ramps a warm-up at position 2 to block 3's grade", () => {
    expect(warmUpTarget(blocks, 1)).toEqual({ targetGrade: 20, blockNumber: 3 });
    expect(
      plannedSlots()
        .filter((slot) => slot.stageId === 'middle')
        .map((slot) => slot.grade),
    ).toEqual([16, 17, 18, 19]);
  });

  it('plans no climbs for a warm-up with no workout block after it', () => {
    expect(warmUpTarget(blocks, 3)).toBeNull();
    expect(plannedSlots().map((slot) => slot.stageId)).toEqual([
      'first',
      'middle',
      'middle',
      'middle',
      'middle',
      'third',
      'third',
    ]);
  });
});

describe('analytics helpers', () => {
  it('lists every block in run order, warm-ups included, and names the first workout type', () => {
    const selection = withBlocks([
      warmUp('warm'),
      workout('pyramid', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 12 }),
      workout('volume', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12 }),
    ]);

    expect(selectionWorkoutTypes(selection)).toBe('warmUp,pyramid,volume');
    expect(firstWorkoutType(selection)).toBe('pyramid');
    expect(firstWorkoutType(withBlocks([warmUp('warm')]))).toBeNull();
  });
});

describe('singleBlockSelection', () => {
  it('holds one workout block and takes its filters from the options', () => {
    const options = { ...DEFAULT_LADDER_OPTIONS, targetGrade: 15, minAscents: 25 };

    expect(singleBlockSelection(options, 'only')).toEqual({
      blocks: [workout('only', options)],
      filters: expect.objectContaining({ minAscents: 25, climbBias: 'unfamiliar' }),
    });
  });
});
