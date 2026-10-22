// The pre-session workout as an ordered list of blocks (#5379). Every block is
// the same kind of thing, a warm-up or a workout of one type, and any block can
// sit anywhere, the first one included. The climb filters are set once and apply
// to every block. No blocks means no workout: the climber picks every climb.
// Pure: every helper returns a new selection, so the picker and the preview hook
// can share them and tests need no React.

import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
  type WorkoutBlockSpec,
  type WorkoutStageKind,
  type WorkoutType,
} from '@boardsesh/playlist-generator';

/** The filters every block's climbs share. A block's own copies of these fields are ignored. */
export type WorkoutFilters = Pick<
  GeneratorOptions,
  'climbBias' | 'minAscents' | 'minRating' | 'onlyTallClimbs' | 'onlyWideClimbs'
>;

/** One block on the picker. `id` keys its card; stage ids are minted when the plan is built. */
export type WorkoutBlock = WorkoutBlockSpec & { id: string };

export type GeneratorSelection = {
  /** Blocks in the order they run. Empty means no workout. */
  blocks: readonly WorkoutBlock[];
  /** Kept with no blocks too, so a climber who removes every block finds their filters again. */
  filters: WorkoutFilters;
};

/** A block's type as its chips name it: a warm-up or one workout type. */
export type WorkoutBlockType = WorkoutStageKind;

/** Most blocks one session can hold, warm-ups included. */
export const MAX_WORKOUT_BLOCKS = 5;

const WORKOUT_TYPES: readonly WorkoutType[] = ['volume', 'pyramid', 'ladder', 'gradeFocus'];

/** Picker order for a block's type chips. */
export const WORKOUT_BLOCK_TYPES: readonly WorkoutBlockType[] = ['warmUp', ...WORKOUT_TYPES];

/** Just the filter fields, from any object that carries them (a block's options, say). */
export function filtersOf({
  climbBias,
  minAscents,
  minRating,
  onlyTallClimbs,
  onlyWideClimbs,
}: WorkoutFilters): WorkoutFilters {
  return { climbBias, minAscents, minRating, onlyTallClimbs, onlyWideClimbs };
}

/** No blocks, with the shared generator defaults as filters. */
export const NO_WORKOUT: GeneratorSelection = { blocks: [], filters: filtersOf(DEFAULT_VOLUME_OPTIONS) };

export function hasWorkoutBlocks(selection: GeneratorSelection): boolean {
  return selection.blocks.length > 0;
}

export function blockType(block: WorkoutBlockSpec): WorkoutBlockType {
  return block.kind === 'warmUp' ? 'warmUp' : block.options.type;
}

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

/** One workout block, with the filters its options carry. */
export function singleBlockSelection(options: GeneratorOptions, blockId: string): GeneratorSelection {
  return { blocks: [{ id: blockId, kind: 'workout', options }], filters: filtersOf(options) };
}

/** The workout type after `type` in picker order, wrapping round, so a new block never repeats the last one. */
export function nextBlockType(type: WorkoutType): WorkoutType {
  const position = WORKOUT_TYPES.indexOf(type);
  return WORKOUT_TYPES[(position + 1) % WORKOUT_TYPES.length];
}

function workoutOptionsAt(blocks: readonly WorkoutBlockSpec[], position: number): GeneratorOptions | null {
  const block = blocks[position];
  return block?.kind === 'workout' ? block.options : null;
}

function lastWorkoutOptions(blocks: readonly WorkoutBlockSpec[]): GeneratorOptions | null {
  for (let position = blocks.length - 1; position >= 0; position--) {
    const options = workoutOptionsAt(blocks, position);
    if (options) return options;
  }
  return null;
}

/**
 * What the warm-up at `position` ramps to: the first workout block after it,
 * with its 1-based block number. Null when no workout block follows, and the
 * warm-up then plans no climbs (`generateStagedPlan` gives it nothing to ramp to).
 */
export function warmUpTarget(
  blocks: readonly WorkoutBlockSpec[],
  position: number,
): { targetGrade: number; blockNumber: number } | null {
  for (let after = position + 1; after < blocks.length; after++) {
    const options = workoutOptionsAt(blocks, after);
    if (options) return { targetGrade: options.targetGrade, blockNumber: after + 1 };
  }
  return null;
}

export function canAddBlock(selection: GeneratorSelection): boolean {
  return selection.blocks.length < MAX_WORKOUT_BLOCKS;
}

/**
 * Appends a workout block. It takes the type after the last workout block's, so
 * it never repeats it, and that block's grade; with no workout block yet it is
 * Volume at `fallbackTargetGrade`. A warm-up is picked from a block's chips, never
 * added directly. Returns the same selection at the cap.
 */
export function addBlock(
  selection: GeneratorSelection,
  makeBlockId: () => string,
  fallbackTargetGrade: number,
): GeneratorSelection {
  if (!canAddBlock(selection)) return selection;
  const lastOptions = lastWorkoutOptions(selection.blocks);
  const options = lastOptions
    ? buildDefaultOptions(nextBlockType(lastOptions.type), lastOptions.targetGrade)
    : buildDefaultOptions('volume', fallbackTargetGrade);
  return { ...selection, blocks: [...selection.blocks, { id: makeBlockId(), kind: 'workout', options }] };
}

export function removeBlock(selection: GeneratorSelection, blockId: string): GeneratorSelection {
  if (!selection.blocks.some((block) => block.id === blockId)) return selection;
  return { ...selection, blocks: selection.blocks.filter((block) => block.id !== blockId) };
}

/** Swaps any block with its neighbour. Returns the same selection when the block is already at that end. */
export function moveBlock(
  selection: GeneratorSelection,
  blockId: string,
  direction: 'up' | 'down',
): GeneratorSelection {
  const position = selection.blocks.findIndex((block) => block.id === blockId);
  const targetPosition = direction === 'up' ? position - 1 : position + 1;
  if (position < 0 || targetPosition < 0 || targetPosition >= selection.blocks.length) return selection;
  const blocks = selection.blocks.slice();
  [blocks[position], blocks[targetPosition]] = [blocks[targetPosition], blocks[position]];
  return { ...selection, blocks };
}

/** Replaces a block's settings, keeping its id and place. */
export function updateBlock(
  selection: GeneratorSelection,
  blockId: string,
  spec: WorkoutBlockSpec,
): GeneratorSelection {
  if (!selection.blocks.some((block) => block.id === blockId)) return selection;
  return {
    ...selection,
    blocks: selection.blocks.map((block) => (block.id === blockId ? { ...spec, id: blockId } : block)),
  };
}

/**
 * Switches a block to another type with that type's defaults. A workout block
 * keeps its target grade. A warm-up has none, so a warm-up turned into a workout
 * takes the grade of the next workout block, else of the one before it, else
 * `fallbackTargetGrade`.
 */
export function changeBlockType(
  selection: GeneratorSelection,
  blockId: string,
  type: WorkoutBlockType,
  fallbackTargetGrade: number,
): GeneratorSelection {
  const position = selection.blocks.findIndex((block) => block.id === blockId);
  const block = selection.blocks[position];
  if (!block || blockType(block) === type) return selection;
  if (type === 'warmUp') return updateBlock(selection, blockId, { kind: 'warmUp', warmUpType: 'standard' });
  const targetGrade =
    block.kind === 'workout'
      ? block.options.targetGrade
      : (warmUpTarget(selection.blocks, position)?.targetGrade ??
        lastWorkoutOptions(selection.blocks.slice(0, position))?.targetGrade ??
        fallbackTargetGrade);
  return updateBlock(selection, blockId, { kind: 'workout', options: buildDefaultOptions(type, targetGrade) });
}

export function updateFilters(selection: GeneratorSelection, patch: Partial<WorkoutFilters>): GeneratorSelection {
  return { ...selection, filters: { ...selection.filters, ...patch } };
}

/**
 * The block types in run order as one comma-joined string, warm-ups included
 * (`warmUp,pyramid,volume`), for analytics. A string, not an array: the web
 * `track()` types arrays out (docs/gym-funnel-analytics.md). Not sorted, because
 * the order is the workout.
 */
export function selectionWorkoutTypes(selection: GeneratorSelection): string {
  return selection.blocks.map(blockType).join(',');
}

/** The first workout block's type, skipping warm-ups. Null when every block is a warm-up. */
export function firstWorkoutType(selection: GeneratorSelection): WorkoutType | null {
  for (const block of selection.blocks) {
    if (block.kind === 'workout') return block.options.type;
  }
  return null;
}
