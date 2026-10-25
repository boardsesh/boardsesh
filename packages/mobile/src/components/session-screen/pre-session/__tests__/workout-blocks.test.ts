import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  TIMED_WORKOUT_TYPES,
  generateStagedPlan,
  planFromBlocks,
  type GeneratorGradeScale,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';
import {
  DEFAULT_WORKOUT_FILTERS,
  MAX_WORKOUT_BLOCKS,
  NO_WORKOUT,
  addBlock,
  addBlockTypes,
  buildDefaultOptions,
  canAddBlock,
  changeBlockType,
  clearUnavailableSizeFilters,
  coolDownSource,
  firstWorkoutType,
  hasWorkoutBlocks,
  moveBlock,
  nextBlockType,
  removeBlock,
  selectionWorkoutTypes,
  singleBlockSelection,
  updateBlock,
  timedWorkoutBlocksOffered,
  updateBlockFilters,
  warmUpTarget,
  withAvailableSizeFilters,
  workoutBlockTypes,
  type GeneratorSelection,
  type WorkoutBlock,
  type WorkoutFilters,
} from '../workout-blocks';

const FALLBACK_GRADE = 15;
const GRADES: GeneratorGradeScale = Array.from({ length: 30 }, (_, index) => ({ difficulty_id: index + 1 }));

const counterIds = () => {
  let nextId = 0;
  return () => `block-${nextId++}`;
};

const STRICT: WorkoutFilters = {
  climbBias: 'attempted',
  minAscents: 50,
  minRating: 3,
  onlyTallClimbs: true,
  onlyWideClimbs: false,
};

const workout = (id: string, options: GeneratorOptions, filters = DEFAULT_WORKOUT_FILTERS): WorkoutBlock => ({
  id,
  kind: 'workout',
  options,
  filters,
});
const warmUp = (id: string, filters = DEFAULT_WORKOUT_FILTERS): WorkoutBlock => ({
  id,
  kind: 'warmUp',
  warmUpType: 'standard',
  filters,
});

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
  it('is no workout', () => {
    expect(hasWorkoutBlocks(NO_WORKOUT)).toBe(false);
    expect(hasWorkoutBlocks(removeBlock(addedBlocks(1), 'block-0'))).toBe(false);
  });
});

describe('nextBlockType', () => {
  it('walks the workout types and wraps round', () => {
    expect(nextBlockType('volume')).toBe('pyramid');
    expect(nextBlockType('pyramid')).toBe('ladder');
    expect(nextBlockType('ladder')).toBe('gradeFocus');
    expect(nextBlockType('gradeFocus')).toBe('volume');
  });

  it('never steps onto a timed type, and steps off one back to volume', () => {
    for (const type of TIMED_WORKOUT_TYPES) expect(nextBlockType(type)).toBe('volume');
    for (const type of ['volume', 'pyramid', 'ladder', 'gradeFocus'] as const) {
      expect(TIMED_WORKOUT_TYPES).not.toContain(nextBlockType(type));
    }
  });
});

const UNTIMED_CHIPS = ['warmUp', 'volume', 'pyramid', 'ladder', 'gradeFocus'];

describe('timed block types', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const TIMED_CHIPS = ['onTheMinute', 'fourByFour', 'limitBouldering'];

  // A release bundle reaches store binaries by OTA: no timed chip until launch,
  // unless the tester's flag is on.
  it('are on no chip in a release build with the flag off', () => {
    vi.stubGlobal('__DEV__', false);

    expect(timedWorkoutBlocksOffered(false)).toBe(false);
    expect(workoutBlockTypes(timedWorkoutBlocksOffered(false))).toEqual(UNTIMED_CHIPS);
    expect(addBlockTypes(timedWorkoutBlocksOffered(false))).toEqual(UNTIMED_CHIPS.slice(1));
  });

  it('follow the untimed chips in a release build with the flag on: 8 chips', () => {
    vi.stubGlobal('__DEV__', false);

    expect(timedWorkoutBlocksOffered(true)).toBe(true);
    expect(workoutBlockTypes(timedWorkoutBlocksOffered(true))).toEqual([...UNTIMED_CHIPS, ...TIMED_CHIPS]);
    expect(workoutBlockTypes(true)).toHaveLength(8);
    expect(addBlockTypes(true)).toEqual([...UNTIMED_CHIPS.slice(1), ...TIMED_CHIPS]);
  });

  it('follow the untimed chips in a dev build whatever the flag says', () => {
    vi.stubGlobal('__DEV__', true);

    expect(timedWorkoutBlocksOffered(false)).toBe(true);
    expect(timedWorkoutBlocksOffered(true)).toBe(true);
    expect(workoutBlockTypes(true)).toEqual([...UNTIMED_CHIPS, ...TIMED_CHIPS]);
    expect(addBlockTypes(true)).toEqual(['volume', 'pyramid', 'ladder', 'gradeFocus', ...TIMED_WORKOUT_TYPES]);
    // The same arrays every call, so a list a component passes on stays put.
    expect(workoutBlockTypes(true)).toBe(workoutBlockTypes(true));
    expect(workoutBlockTypes(false)).toBe(workoutBlockTypes(false));
    expect(addBlockTypes(true)).toBe(addBlockTypes(true));
    expect(addBlockTypes(false)).toBe(addBlockTypes(false));
  });

  // The store captures run dev builds in screenshot mode; they keep today's
  // chips, and a tester's flag cannot put the timed ones in.
  it('stay off in screenshot mode unless the capture opens on a timed block', async () => {
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(timedWorkoutBlocksOffered(false)).toBe(false);
    expect(timedWorkoutBlocksOffered(true)).toBe(false);

    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_WORKOUT', 'fourByFour');
    vi.resetModules();
    const reloaded = await import('../workout-blocks');
    expect(reloaded.timedWorkoutBlocksOffered(false)).toBe(true);

    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_WORKOUT', 'volume');
    vi.resetModules();
    const untimed = await import('../workout-blocks');
    expect(untimed.timedWorkoutBlocksOffered(false)).toBe(false);
    expect(untimed.timedWorkoutBlocksOffered(true)).toBe(false);
  });

  it('build their defaults at the grade asked for', () => {
    expect(buildDefaultOptions('onTheMinute', 18)).toEqual({ ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 18 });
    expect(buildDefaultOptions('fourByFour', 18)).toEqual({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18 });
    expect(buildDefaultOptions('limitBouldering', 22)).toEqual({
      ...DEFAULT_LIMIT_BOULDERING_OPTIONS,
      targetGrade: 22,
    });
  });

  it('keep the grade and filters when a block changes to one', () => {
    const selection = withBlocks([workout('block-0', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 19 }, STRICT)]);

    expect(changeBlockType(selection, 'block-0', 'fourByFour', FALLBACK_GRADE).blocks).toEqual([
      workout('block-0', { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 19 }, STRICT),
    ]);
  });

  it('add a block after a timed one as volume at its grade', () => {
    const selection = withBlocks([workout('block-0', { ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 24 })]);

    expect(addBlock(selection, () => 'block-1', FALLBACK_GRADE).blocks[1]).toEqual(
      workout('block-1', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 24 }),
    );
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

  it('gives the first block the generator defaults as filters', () => {
    expect(addedBlocks(1).blocks[0].filters).toEqual(DEFAULT_WORKOUT_FILTERS);
  });

  it("copies the last block's filters, a warm-up's included, into a block of its own", () => {
    const selection = withBlocks([
      workout('pyramid', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 20 }),
      warmUp('warm', STRICT),
    ]);
    const added = addBlock(selection, () => 'added', FALLBACK_GRADE);
    const addedBlock = added.blocks[2];

    expect(addedBlock.filters).toEqual(STRICT);
    expect(addedBlock.filters).not.toBe(STRICT);
    // Editing the new block's filters leaves the block it copied alone.
    expect(updateBlockFilters(added, 'added', { minRating: 0 }).blocks[1].filters).toEqual(STRICT);
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

  it('keeps the filters whichever type the block turns into', () => {
    const selection = withBlocks([
      warmUp('warm', STRICT),
      workout('volume', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12 }, STRICT),
    ]);

    expect(changeBlockType(selection, 'warm', 'pyramid', FALLBACK_GRADE).blocks[0].filters).toEqual(STRICT);
    expect(changeBlockType(selection, 'volume', 'warmUp', FALLBACK_GRADE).blocks[1].filters).toEqual(STRICT);
    expect(changeBlockType(selection, 'volume', 'ladder', FALLBACK_GRADE).blocks[1].filters).toEqual(STRICT);
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

    expect(updated.blocks[0]).toEqual({
      id: 'warm',
      kind: 'warmUp',
      warmUpType: 'extended',
      filters: DEFAULT_WORKOUT_FILTERS,
    });
    expect(updated.blocks[1]).toBe(selection.blocks[1]);
  });

  it("keeps the block's filters", () => {
    const selection = withBlocks([warmUp('warm', STRICT)]);

    expect(updateBlock(selection, 'warm', { kind: 'warmUp', warmUpType: 'extended' }).blocks[0].filters).toBe(STRICT);
  });
});

describe('updateBlockFilters', () => {
  it("changes only that block's filters", () => {
    const selection = addedBlocks(2);
    const updated = updateBlockFilters(selection, 'block-1', { climbBias: 'any', minAscents: 100 });

    expect(updated.blocks[1].filters).toEqual({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any', minAscents: 100 });
    expect(updated.blocks[0]).toBe(selection.blocks[0]);
  });

  it('returns the same selection when nothing changes or the block is unknown', () => {
    const selection = addedBlocks(1);

    expect(updateBlockFilters(selection, 'block-0', { minAscents: DEFAULT_WORKOUT_FILTERS.minAscents })).toBe(
      selection,
    );
    expect(updateBlockFilters(selection, 'missing', { minAscents: 100 })).toBe(selection);
  });
});

describe('size filters the board does not offer', () => {
  it('turns off only the ones the board lacks', () => {
    const both = { ...DEFAULT_WORKOUT_FILTERS, onlyTallClimbs: true, onlyWideClimbs: true };

    expect(withAvailableSizeFilters(both, { tall: true, wide: false })).toEqual({ ...both, onlyWideClimbs: false });
    expect(withAvailableSizeFilters(both, { tall: true, wide: true })).toBe(both);
  });

  it('clears every block, and returns the same selection when nothing is on', () => {
    const selection = withBlocks([
      warmUp('warm', STRICT),
      workout('volume', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12 }),
    ]);
    const cleared = clearUnavailableSizeFilters(selection, { tall: false, wide: false });

    expect(cleared.blocks[0].filters).toEqual({ ...STRICT, onlyTallClimbs: false });
    expect(cleared.blocks[1]).toBe(selection.blocks[1]);
    expect(clearUnavailableSizeFilters(cleared, { tall: false, wide: false })).toBe(cleared);
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

  it('eases a warm-up with no workout block after it off from the block before it', () => {
    expect(warmUpTarget(blocks, 3)).toBeNull();
    expect(coolDownSource(blocks, 3)).toEqual({ targetGrade: 20, blockNumber: 3 });
    expect(
      plannedSlots()
        .filter((slot) => slot.stageId === 'trailing')
        .map((slot) => [slot.section, slot.grade]),
    ).toEqual([
      ['coolDown', 19],
      ['coolDown', 18],
      ['coolDown', 17],
      ['coolDown', 16],
    ]);
  });

  it('gives a warm-up with a workout block after it nothing to ease off from', () => {
    expect(coolDownSource(blocks, 1)).toBeNull();
  });

  it('skips warm-ups between the trailing warm-up and the last workout block', () => {
    const trailing = [...blocks, warmUp('after-trailing')];

    expect(coolDownSource(trailing, 4)).toEqual({ targetGrade: 20, blockNumber: 3 });
  });

  it('gives a warm-up with no workout block on either side nothing to ramp to or ease off from, and plans none', () => {
    const lone = [warmUp('first'), warmUp('second')];

    expect(warmUpTarget(lone, 1)).toBeNull();
    expect(coolDownSource(lone, 1)).toBeNull();
    expect(
      generateStagedPlan(
        planFromBlocks(lone, (position) => lone[position].id),
        GRADES,
      ),
    ).toEqual([]);
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
      blocks: [workout('only', options, { ...DEFAULT_WORKOUT_FILTERS, minAscents: 25 })],
    });
  });

  it('takes the filters it is given over the copies in the options', () => {
    const options = { ...DEFAULT_LADDER_OPTIONS, targetGrade: 15 };

    expect(singleBlockSelection(options, 'only', STRICT).blocks[0].filters).toBe(STRICT);
  });
});
