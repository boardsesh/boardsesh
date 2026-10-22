// The pre-session workout selection as an ordered list of blocks (#5379): the
// first block is the workout card (type, target grade, warm-up and the shared
// filters), and each extra block adds a type, a target grade and its counts.
// Pure: every helper returns a new selection, so the picker and the preview
// hook can share them and tests need no React.

import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
  type WorkoutType,
} from '@boardsesh/playlist-generator';

/** One block after the first. `id` keys its editor; stage ids are minted when the plan is built. */
export type ExtraWorkoutBlock = { id: string; options: GeneratorOptions };

export type GeneratorSelection =
  | { type: 'off' }
  | {
      type: 'on';
      /** The first block. Its warm-up opens the session and its filters apply to every block. */
      options: GeneratorOptions;
      /** Blocks after the first, in the order they run. */
      extraBlocks: readonly ExtraWorkoutBlock[];
    };

export type ActiveGeneratorSelection = Extract<GeneratorSelection, { type: 'on' }>;

/** Most workout blocks one session can hold, the first card included. */
export const MAX_WORKOUT_BLOCKS = 4;

// Picker order. "Add a block" walks it to pick a type that differs from the last block.
const WORKOUT_BLOCK_TYPES: readonly WorkoutType[] = ['volume', 'pyramid', 'ladder', 'gradeFocus'];

export function buildDefaultOptions(type: WorkoutType, targetGrade: number): GeneratorOptions {
  switch (type) {
    case 'volume':
      return { ...DEFAULT_VOLUME_OPTIONS, targetGrade };
    case 'pyramid':
      return { ...DEFAULT_PYRAMID_OPTIONS, targetGrade };
    case 'ladder':
      return { ...DEFAULT_LADDER_OPTIONS, targetGrade };
    case 'gradeFocus':
      return { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade };
  }
}

/** A selection with only the first block, as the picker starts one. */
export function singleBlockSelection(options: GeneratorOptions): ActiveGeneratorSelection {
  return { type: 'on', options, extraBlocks: [] };
}

/** The workout type after `type` in picker order, wrapping round, so a new block never repeats the last one. */
export function nextBlockType(type: WorkoutType): WorkoutType {
  const position = WORKOUT_BLOCK_TYPES.indexOf(type);
  return WORKOUT_BLOCK_TYPES[(position + 1) % WORKOUT_BLOCK_TYPES.length];
}

export function canAddBlock(selection: GeneratorSelection): selection is ActiveGeneratorSelection {
  return selection.type === 'on' && 1 + selection.extraBlocks.length < MAX_WORKOUT_BLOCKS;
}

/**
 * Appends a block with a type that differs from the last block's and the same
 * target grade. Returns the same selection at the cap or with the generator off.
 */
export function addBlock(selection: GeneratorSelection, makeBlockId: () => string): GeneratorSelection {
  if (!canAddBlock(selection)) return selection;
  const lastOptions = selection.extraBlocks.at(-1)?.options ?? selection.options;
  const block: ExtraWorkoutBlock = {
    id: makeBlockId(),
    options: buildDefaultOptions(nextBlockType(lastOptions.type), lastOptions.targetGrade),
  };
  return { ...selection, extraBlocks: [...selection.extraBlocks, block] };
}

export function removeBlock(selection: GeneratorSelection, blockId: string): GeneratorSelection {
  if (selection.type !== 'on' || !selection.extraBlocks.some((block) => block.id === blockId)) return selection;
  return { ...selection, extraBlocks: selection.extraBlocks.filter((block) => block.id !== blockId) };
}

/**
 * Swaps a block with its neighbour among the extra blocks. The first card stays
 * first: it carries the warm-up and the shared filters. Returns the same
 * selection when the block is already at that end.
 */
export function moveBlock(
  selection: GeneratorSelection,
  blockId: string,
  direction: 'up' | 'down',
): GeneratorSelection {
  if (selection.type !== 'on') return selection;
  const position = selection.extraBlocks.findIndex((block) => block.id === blockId);
  const targetPosition = direction === 'up' ? position - 1 : position + 1;
  if (position < 0 || targetPosition < 0 || targetPosition >= selection.extraBlocks.length) return selection;
  const extraBlocks = selection.extraBlocks.slice();
  [extraBlocks[position], extraBlocks[targetPosition]] = [extraBlocks[targetPosition], extraBlocks[position]];
  return { ...selection, extraBlocks };
}

export function updateBlockOptions(
  selection: GeneratorSelection,
  blockId: string,
  options: GeneratorOptions,
): GeneratorSelection {
  if (selection.type !== 'on') return selection;
  return {
    ...selection,
    extraBlocks: selection.extraBlocks.map((block) => (block.id === blockId ? { ...block, options } : block)),
  };
}

/** Switches a block to another type with that type's defaults, keeping its target grade. */
export function changeBlockType(selection: GeneratorSelection, blockId: string, type: WorkoutType): GeneratorSelection {
  if (selection.type !== 'on') return selection;
  const block = selection.extraBlocks.find((extraBlock) => extraBlock.id === blockId);
  if (!block || block.options.type === type) return selection;
  return updateBlockOptions(selection, blockId, buildDefaultOptions(type, block.options.targetGrade));
}

/**
 * Every block's generator options in run order, ready for `planFromBlocks`. The
 * extra blocks take the first card's filters (rating, ascents, bias, tall and
 * wide), which are set once for the whole session, and never a warm-up of their own.
 */
export function selectionBlocks(selection: ActiveGeneratorSelection): GeneratorOptions[] {
  const { climbBias, minAscents, minRating, onlyTallClimbs, onlyWideClimbs } = selection.options;
  const sharedFilters = { climbBias, minAscents, minRating, onlyTallClimbs, onlyWideClimbs, warmUp: 'none' } as const;
  return [selection.options, ...selection.extraBlocks.map((block) => ({ ...block.options, ...sharedFilters }))];
}

/**
 * The block types in run order as one comma-joined string (`pyramid,volume`),
 * for analytics. A string, not an array: the web `track()` types arrays out
 * (docs/gym-funnel-analytics.md). Not sorted, because the order is the workout.
 */
export function selectionWorkoutTypes(selection: ActiveGeneratorSelection): string {
  return [selection.options.type, ...selection.extraBlocks.map((block) => block.options.type)].join(',');
}
