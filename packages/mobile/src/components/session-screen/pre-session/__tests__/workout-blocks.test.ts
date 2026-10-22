import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';
import {
  MAX_WORKOUT_BLOCKS,
  addBlock,
  canAddBlock,
  changeBlockType,
  moveBlock,
  nextBlockType,
  removeBlock,
  selectionBlocks,
  selectionWorkoutTypes,
  singleBlockSelection,
  updateBlockOptions,
  type ActiveGeneratorSelection,
  type GeneratorSelection,
} from '../workout-blocks';

const FIRST: GeneratorOptions = {
  ...DEFAULT_PYRAMID_OPTIONS,
  targetGrade: 20,
  warmUp: 'standard',
  climbBias: 'attempted',
  minAscents: 10,
  minRating: 3,
  onlyTallClimbs: true,
  onlyWideClimbs: true,
};

const counterIds = () => {
  let nextId = 0;
  return () => `block-${nextId++}`;
};

function activeSelection(selection: GeneratorSelection): ActiveGeneratorSelection {
  if (selection.type !== 'on') throw new Error('expected the generator on');
  return selection;
}

function withBlocks(count: number): ActiveGeneratorSelection {
  const makeId = counterIds();
  let selection: GeneratorSelection = singleBlockSelection(FIRST);
  for (let added = 0; added < count; added++) selection = addBlock(selection, makeId);
  return activeSelection(selection);
}

describe('nextBlockType', () => {
  it('walks the picker order and wraps round', () => {
    expect(nextBlockType('volume')).toBe('pyramid');
    expect(nextBlockType('pyramid')).toBe('ladder');
    expect(nextBlockType('ladder')).toBe('gradeFocus');
    expect(nextBlockType('gradeFocus')).toBe('volume');
  });
});

describe('addBlock', () => {
  it('appends a block of a different type from the last, at the same target grade, with defaults', () => {
    const selection = withBlocks(1);

    expect(selection.extraBlocks).toEqual([{ id: 'block-0', options: { ...DEFAULT_LADDER_OPTIONS, targetGrade: 20 } }]);
  });

  it('follows the last extra block, not the first card', () => {
    const selection = activeSelection(
      addBlock(
        updateBlockOptions(withBlocks(1), 'block-0', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12 }),
        () => 'added',
      ),
    );

    expect(selection.extraBlocks[1]).toEqual({
      id: 'added',
      options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 12 },
    });
  });

  it(`stops at ${MAX_WORKOUT_BLOCKS} blocks, the first card included`, () => {
    const full = withBlocks(MAX_WORKOUT_BLOCKS - 1);

    expect(full.extraBlocks).toHaveLength(MAX_WORKOUT_BLOCKS - 1);
    expect(canAddBlock(full)).toBe(false);
    expect(addBlock(full, () => 'one-too-many')).toBe(full);
  });

  it('does nothing with the generator off', () => {
    const off: GeneratorSelection = { type: 'off' };

    expect(canAddBlock(off)).toBe(false);
    expect(addBlock(off, () => 'never')).toBe(off);
  });
});

describe('removeBlock', () => {
  it('drops the block and keeps the rest in order', () => {
    const selection = activeSelection(removeBlock(withBlocks(3), 'block-1'));

    expect(selection.extraBlocks.map((block) => block.id)).toEqual(['block-0', 'block-2']);
    expect(selection.options).toBe(FIRST);
  });

  it('returns the same selection for an unknown block', () => {
    const selection = withBlocks(1);

    expect(removeBlock(selection, 'missing')).toBe(selection);
  });
});

describe('moveBlock', () => {
  it('swaps a block with its neighbour', () => {
    const selection = withBlocks(3);

    expect(activeSelection(moveBlock(selection, 'block-1', 'up')).extraBlocks.map((block) => block.id)).toEqual([
      'block-1',
      'block-0',
      'block-2',
    ]);
    expect(activeSelection(moveBlock(selection, 'block-1', 'down')).extraBlocks.map((block) => block.id)).toEqual([
      'block-0',
      'block-2',
      'block-1',
    ]);
  });

  it('never moves a block above the first card or past the end', () => {
    const selection = withBlocks(2);

    expect(moveBlock(selection, 'block-0', 'up')).toBe(selection);
    expect(moveBlock(selection, 'block-1', 'down')).toBe(selection);
    expect(moveBlock(selection, 'missing', 'down')).toBe(selection);
  });
});

describe('changeBlockType', () => {
  it("switches to the new type's defaults and keeps the block's target grade", () => {
    const edited = updateBlockOptions(withBlocks(1), 'block-0', {
      ...DEFAULT_LADDER_OPTIONS,
      targetGrade: 14,
      numberOfSteps: 9,
    });
    const selection = activeSelection(changeBlockType(edited, 'block-0', 'gradeFocus'));

    expect(selection.extraBlocks[0].options).toEqual({ ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 14 });
  });

  it('keeps the block untouched when its type is picked again', () => {
    const selection = withBlocks(1);

    expect(changeBlockType(selection, 'block-0', 'ladder')).toBe(selection);
  });
});

describe('selectionBlocks', () => {
  it('is just the first card for a one-block workout', () => {
    expect(selectionBlocks(singleBlockSelection(FIRST))).toEqual([FIRST]);
  });

  it("gives every extra block the first card's filters and no warm-up of its own", () => {
    const blocks = selectionBlocks(withBlocks(2));

    expect(blocks[0]).toBe(FIRST);
    for (const block of blocks.slice(1)) {
      expect(block).toMatchObject({
        warmUp: 'none',
        climbBias: 'attempted',
        minAscents: 10,
        minRating: 3,
        onlyTallClimbs: true,
        onlyWideClimbs: true,
        targetGrade: 20,
      });
    }
    expect(blocks.map((block) => block.type)).toEqual(['pyramid', 'ladder', 'gradeFocus']);
  });
});

describe('selectionWorkoutTypes', () => {
  it('joins the block types in run order, unsorted', () => {
    const selection = activeSelection(moveBlock(withBlocks(2), 'block-1', 'up'));

    expect(selectionWorkoutTypes(singleBlockSelection(FIRST))).toBe('pyramid');
    expect(selectionWorkoutTypes(selection)).toBe('pyramid,gradeFocus,ladder');
  });
});
