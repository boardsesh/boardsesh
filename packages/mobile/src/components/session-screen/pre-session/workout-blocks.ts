// The pre-session workout as an ordered list of blocks (#5379). Every block is
// the same kind of thing, a warm-up or a workout of one type, and any block can
// sit anywhere, the first one included. Each block, warm-ups included, has its
// own climb filters. No blocks means no workout: the climber picks every climb.
// Pure: every helper returns a new selection, so the picker and the preview hook
// can share them and tests need no React.

import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
  type WorkoutBlockSpec,
  type WorkoutStageFilters,
  type WorkoutStageKind,
  type WorkoutType,
} from '@boardsesh/playlist-generator';

/**
 * One block's climb filters. A workout block's options carry copies of these
 * fields; the block's `filters` win and the copies are ignored.
 */
export type WorkoutFilters = WorkoutStageFilters;

/**
 * One block on the picker. `id` keys its card; stage ids are minted when the
 * plan is built. `filters` are its own climb filters, which pass to its stage.
 */
export type WorkoutBlock = WorkoutBlockSpec & { id: string; filters: WorkoutFilters };

export type GeneratorSelection = {
  /** Blocks in the order they run. Empty means no workout. */
  blocks: readonly WorkoutBlock[];
};

/** A block's type as its chips name it: a warm-up or one workout type. */
export type WorkoutBlockType = WorkoutStageKind;

/** Most blocks one session can hold, warm-ups included. */
export const MAX_WORKOUT_BLOCKS = 5;

// The untimed workout types, in picker order. The timed ones (on the minute,
// 4x4, limit) are modelled but not offered yet, so they are on no chip and in no
// "Add a block" cycle.
const UNTIMED_WORKOUT_TYPES: readonly WorkoutType[] = ['volume', 'pyramid', 'ladder', 'gradeFocus'];

/** Picker order for a block's type chips. */
export const WORKOUT_BLOCK_TYPES: readonly WorkoutBlockType[] = ['warmUp', ...UNTIMED_WORKOUT_TYPES];

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

/** The generator's default climb filters: what the first block starts with. */
export const DEFAULT_WORKOUT_FILTERS: WorkoutFilters = filtersOf(DEFAULT_VOLUME_OPTIONS);

/** No blocks: the climber picks every climb. */
export const NO_WORKOUT: GeneratorSelection = { blocks: [] };

/** True when two sets of filters fetch the same climbs. */
export function sameFilters(first: WorkoutFilters, second: WorkoutFilters): boolean {
  return (
    first.climbBias === second.climbBias &&
    first.minAscents === second.minAscents &&
    first.minRating === second.minRating &&
    first.onlyTallClimbs === second.onlyTallClimbs &&
    first.onlyWideClimbs === second.onlyWideClimbs
  );
}

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
    case 'onTheMinute':
      return { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade };
    case 'fourByFour':
      return { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade };
    case 'limitBouldering':
      return { ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade };
  }
}

/** One workout block, with `filters`, else the filters its options carry. */
export function singleBlockSelection(
  options: GeneratorOptions,
  blockId: string,
  filters: WorkoutFilters = filtersOf(options),
): GeneratorSelection {
  return { blocks: [{ id: blockId, kind: 'workout', options, filters }] };
}

/**
 * The untimed workout type after `type` in picker order, wrapping round, so a
 * new block never repeats the last one. After a timed type it starts again at
 * volume.
 */
export function nextBlockType(type: WorkoutType): WorkoutType {
  const position = UNTIMED_WORKOUT_TYPES.indexOf(type);
  return UNTIMED_WORKOUT_TYPES[(position + 1) % UNTIMED_WORKOUT_TYPES.length];
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
 * Volume at `fallbackTargetGrade`. Its filters are a copy of the last block's,
 * warm-up or not; the first block gets the generator defaults. A warm-up is
 * picked from a block's chips, never added directly. Returns the same selection
 * at the cap.
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
  const filters = { ...(selection.blocks[selection.blocks.length - 1]?.filters ?? DEFAULT_WORKOUT_FILTERS) };
  return { ...selection, blocks: [...selection.blocks, { id: makeBlockId(), kind: 'workout', options, filters }] };
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

/** Replaces a block's settings, keeping its id, place and filters. */
export function updateBlock(
  selection: GeneratorSelection,
  blockId: string,
  spec: WorkoutBlockSpec,
): GeneratorSelection {
  if (!selection.blocks.some((block) => block.id === blockId)) return selection;
  return {
    ...selection,
    blocks: selection.blocks.map((block) =>
      block.id === blockId ? { ...spec, id: blockId, filters: block.filters } : block,
    ),
  };
}

/** Changes some of one block's filters. Returns the same selection when nothing changes. */
export function updateBlockFilters(
  selection: GeneratorSelection,
  blockId: string,
  patch: Partial<WorkoutFilters>,
): GeneratorSelection {
  const block = selection.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return selection;
  const filters = { ...block.filters, ...patch };
  if (sameFilters(filters, block.filters)) return selection;
  return {
    ...selection,
    blocks: selection.blocks.map((candidate) => (candidate.id === blockId ? { ...candidate, filters } : candidate)),
  };
}

/** Which size filters the board offers: tall needs shorter sizes of its layout, wide narrower ones. */
export type SizeFilterAvailability = { tall: boolean; wide: boolean };

/** `filters` with any size filter the board does not offer turned off. The same object when none is. */
export function withAvailableSizeFilters(
  filters: WorkoutFilters,
  { tall, wide }: SizeFilterAvailability,
): WorkoutFilters {
  const clearTall = filters.onlyTallClimbs && !tall;
  const clearWide = filters.onlyWideClimbs && !wide;
  if (!clearTall && !clearWide) return filters;
  return {
    ...filters,
    ...(clearTall ? { onlyTallClimbs: false } : {}),
    ...(clearWide ? { onlyWideClimbs: false } : {}),
  };
}

/** Turns off, on every block, the size filters the board does not offer. The same selection when none is on. */
export function clearUnavailableSizeFilters(
  selection: GeneratorSelection,
  availability: SizeFilterAvailability,
): GeneratorSelection {
  let changed = false;
  const blocks = selection.blocks.map((block) => {
    const filters = withAvailableSizeFilters(block.filters, availability);
    if (filters === block.filters) return block;
    changed = true;
    return { ...block, filters };
  });
  return changed ? { ...selection, blocks } : selection;
}

/**
 * Switches a block to another type with that type's defaults, keeping its
 * filters. A workout block keeps its target grade. A warm-up has none, so a warm-up turned into a workout
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
