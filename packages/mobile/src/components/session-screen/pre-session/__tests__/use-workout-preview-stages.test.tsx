// @vitest-environment jsdom
// The preview against the REAL generator: a warm-up block plus a workout block
// must come out as two stages whose climbs are exactly the warm-up rows and the
// workout rows, and a warm-up anywhere must ramp to the workout block after it.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import {
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  generateStagedPlan,
  generateWorkoutPlan,
  planFromBlocks,
  summarizePlanFill,
  type GeneratorGradeScale,
  type GeneratorOptions,
  type PyramidOptions,
  type VolumeOptions,
} from '@boardsesh/playlist-generator';
import {
  NO_WORKOUT,
  addBlock,
  moveBlock,
  removeBlock,
  updateBlockFilters,
  type GeneratorSelection,
  type WorkoutBlock,
  type WorkoutFilters,
} from '../workout-blocks';
import type { FetchGradePool } from '../workout-preview-pool';

const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: () => `uuid-${counter++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => cryptoMock.randomUUID() }));
vi.mock('../select-climbs-for-plan', () => ({ fetchGradePool: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { useWorkoutPreview } from '../use-workout-preview';

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard;
const grades: GeneratorGradeScale = Array.from({ length: 20 }, (_, index) => ({ difficulty_id: index + 10 }));

const volumeWithWarmUp: VolumeOptions = {
  type: 'volume',
  targetGrade: 20,
  warmUp: 'standard',
  mainSetClimbs: 6,
  mainSetVariability: 0,
  minAscents: 0,
  minRating: 0,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  climbBias: 'any',
};

const ANY_FILTERS = {
  minAscents: 0,
  minRating: 0,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  climbBias: 'any',
} as const;
const STRICT_FILTERS: WorkoutFilters = { ...ANY_FILTERS, minAscents: 50, minRating: 3 };
const warmUpBlock = (id: string, filters: WorkoutFilters = ANY_FILTERS): WorkoutBlock => ({
  id,
  kind: 'warmUp',
  warmUpType: 'standard',
  filters,
});
const workoutBlock = (id: string, options: GeneratorOptions, filters: WorkoutFilters = ANY_FILTERS): WorkoutBlock => ({
  id,
  kind: 'workout',
  options,
  filters,
});
const selectionOf = (blocks: WorkoutBlock[]): GeneratorSelection => ({ blocks });

// A deep pool at every grade, with climb uuids unique across grades.
const fetchPool: FetchGradePool = async (grade) => ({
  climbs: Array.from(
    { length: 30 },
    (_, index) => ({ uuid: `g${grade}-${index}`, name: `g${grade}-${index}` }) as Climb,
  ),
  topUpTiers: new Map(),
});

describe('useWorkoutPreview stages', () => {
  it('plans the same slots as before and groups the queued climbs by stage', async () => {
    const selection = selectionOf([
      warmUpBlock('warm'),
      workoutBlock('volume', { ...volumeWithWarmUp, warmUp: 'none' }),
    ]);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Same slots as the single-type generator, each now tagged with its stage.
    const slotsWithoutStage = result.current.plannedSlots.map(({ grade, section, index }) => ({
      grade,
      section,
      index,
    }));
    expect(slotsWithoutStage).toEqual(generateWorkoutPlan(volumeWithWarmUp, grades));

    const { items, run } = result.current.toStagedQueueItems();
    const warmUpUuids = result.current.items
      .filter((preview) => preview.slot.section === 'warmUp')
      .map((preview) => preview.item.uuid);
    const mainUuids = result.current.items
      .filter((preview) => preview.slot.section !== 'warmUp')
      .map((preview) => preview.item.uuid);
    expect(warmUpUuids.length).toBeGreaterThan(0);
    expect(run?.stages.map((stage) => stage.kind)).toEqual(['warmUp', 'volume']);
    expect(run?.stages[0].itemUuids).toEqual(warmUpUuids);
    expect(run?.stages[1].itemUuids).toEqual(mainUuids);
    expect(items.map((item) => item.uuid)).toEqual([...warmUpUuids, ...mainUuids]);
    // Stage ids are minted fresh, never positions.
    expect(new Set(run?.stages.map((stage) => stage.id)).size).toBe(2);
  });

  it('fills every block from one fetch per grade and keeps each climb in its own stage', async () => {
    const pyramid: PyramidOptions = { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 22, numberOfSteps: 3, climbsPerStep: 1 };
    const volume: VolumeOptions = { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15, mainSetClimbs: 4 };
    const selection = selectionOf([
      warmUpBlock('warm'),
      workoutBlock('block-pyramid', pyramid),
      workoutBlock('block-volume', volume),
    ]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Warm-up up to the pyramid, then the pyramid, then the volume block.
    expect(result.current.plannedStages.map((stage) => stage.kind)).toEqual(['warmUp', 'pyramid', 'volume']);
    const expectedSlots = generateStagedPlan(
      planFromBlocks(selection.blocks, () => 'x'),
      grades,
    ).map(({ grade, section, index }) => ({ grade, section, index }));
    expect(result.current.plannedSlots.map(({ grade, section, index }) => ({ grade, section, index }))).toEqual(
      expectedSlots,
    );
    // The volume block's fetch carries the block's filters, not its options' own
    // defaults, and asks for as many climbs as its four slots need.
    expect(countingFetchPool).toHaveBeenCalledWith(
      15,
      expect.objectContaining({ filters: expect.objectContaining({ minAscents: 0, minRating: 0, climbBias: 'any' }) }),
      4,
    );

    // One fetch per unique grade across every stage, none repeated.
    const uniqueGrades = new Set(result.current.plannedSlots.map((slot) => slot.grade));
    expect(countingFetchPool).toHaveBeenCalledTimes(uniqueGrades.size);

    // The summary counts every stage.
    const summary = summarizePlanFill(
      result.current.plannedSlots,
      result.current.items.map((preview) => preview.slot),
    );
    expect(summary.filled).toBe(expectedSlots.length);
    expect(summary.lowestGrade).toBe(15);
    expect(summary.highestGrade).toBe(22);

    const expectRunMatchesRows = () => {
      const { items, run } = result.current.toStagedQueueItems();
      expect(items.map((item) => item.uuid)).toEqual(result.current.items.map((preview) => preview.item.uuid));
      expect(run?.stages.map((stage) => stage.id)).toEqual(result.current.plannedStages.map((stage) => stage.id));
      for (const runStage of run?.stages ?? []) {
        expect(runStage.itemUuids).toEqual(
          result.current.items
            .filter((preview) => preview.slot.stageId === runStage.id)
            .map((preview) => preview.item.uuid),
        );
      }
      // No climb is picked twice across stages.
      const climbUuids = result.current.items.map((preview) => preview.item.climb.uuid);
      expect(new Set(climbUuids).size).toBe(climbUuids.length);
    };
    expectRunMatchesRows();
    const [warmUpStage, pyramidStage, volumeStage] = result.current.toStagedQueueItems().run?.stages ?? [];
    expect([warmUpStage?.itemUuids.length, pyramidStage?.itemUuids.length, volumeStage?.itemUuids.length]).toEqual([
      4, 3, 4,
    ]);

    // Shuffle re-picks across every stage and the run follows the new rows.
    act(() => result.current.shuffle());
    expectRunMatchesRows();

    // A row refresh in the second block keeps that row in the second block.
    const volumeRow = result.current.items.find((preview) => preview.slot.grade === 15);
    if (!volumeRow) throw new Error('expected a volume row');
    await act(async () => result.current.refreshSlot(volumeRow.item.uuid));
    await waitFor(() => expect(result.current.refreshingUuids.size).toBe(0));
    expectRunMatchesRows();
    expect(result.current.toStagedQueueItems().run?.stages[2].itemUuids).toContain(volumeRow.item.uuid);
  });

  it('fetches blocks with different filters at one grade apart, and blocks with equal filters together', async () => {
    const volume: VolumeOptions = { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15, mainSetClimbs: 4 };
    const selection = selectionOf([
      workoutBlock('loose-a', volume),
      workoutBlock('strict', { ...volume, mainSetClimbs: 2 }, STRICT_FILTERS),
      // Its own copy of the same filters as the first block.
      workoutBlock('loose-b', { ...volume, mainSetClimbs: 3 }, { ...ANY_FILTERS }),
    ]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // One pool for the two loose blocks and one for the strict block, each sized
    // for every slot at the grade, since the two return mostly the same climbs.
    expect(countingFetchPool).toHaveBeenCalledTimes(2);
    expect(countingFetchPool).toHaveBeenCalledWith(15, expect.objectContaining({ filters: ANY_FILTERS }), 9);
    expect(countingFetchPool).toHaveBeenCalledWith(15, expect.objectContaining({ filters: STRICT_FILTERS }), 9);
    // The fake hands both pools the same climbs, and still no climb fills two slots.
    const climbUuids = result.current.items.map((preview) => preview.item.climb.uuid);
    expect(climbUuids).toHaveLength(9);
    expect(new Set(climbUuids).size).toBe(9);
  });

  it("keeps each stage's filters in the run Start writes, warm-ups included", async () => {
    const selection = selectionOf([
      warmUpBlock('warm', STRICT_FILTERS),
      workoutBlock('volume', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15, mainSetClimbs: 2 }),
    ]);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.toStagedQueueItems().run?.stages.map((stage) => stage.filters)).toEqual([
      STRICT_FILTERS,
      ANY_FILTERS,
    ]);
  });

  it("rebuilds when one block's filters change", async () => {
    const committed = selectionOf([
      workoutBlock('volume', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15, mainSetClimbs: 2 }),
    ]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result, rerender } = renderHook(
      ({ selection }: { selection: GeneratorSelection }) =>
        useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
      { initialProps: { selection: committed } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ selection: updateBlockFilters(committed, 'volume', { minAscents: 100 }) });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(countingFetchPool).toHaveBeenLastCalledWith(
      15,
      expect.objectContaining({ filters: { ...ANY_FILTERS, minAscents: 100 } }),
      2,
    );
  });

  it("refetches only the changed block's pools and keeps the other blocks' rows", async () => {
    const committed = selectionOf([
      workoutBlock('low', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12, mainSetClimbs: 3 }),
      workoutBlock('high', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 18, mainSetClimbs: 2 }),
    ]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result, rerender } = renderHook(
      ({ selection }: { selection: GeneratorSelection }) =>
        useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
      { initialProps: { selection: committed } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const lowRows = result.current.items.filter((preview) => preview.slot.grade === 12).map((preview) => preview.item);
    expect(countingFetchPool).toHaveBeenCalledTimes(2);

    rerender({ selection: updateBlockFilters(committed, 'high', { minAscents: 100 }) });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // One new search, for the changed block; the untouched block keeps its rows.
    expect(countingFetchPool).toHaveBeenCalledTimes(3);
    expect(countingFetchPool).toHaveBeenLastCalledWith(
      18,
      expect.objectContaining({ filters: { ...ANY_FILTERS, minAscents: 100 } }),
      2,
    );
    expect(result.current.items.filter((preview) => preview.slot.grade === 12).map((preview) => preview.item)).toEqual(
      lowRows,
    );
    const { run } = result.current.toStagedQueueItems();
    expect(run?.stages[0].itemUuids).toEqual(lowRows.map((item) => item.uuid));
  });

  it('starts fresh on an explicit regenerate', async () => {
    const selection = selectionOf([
      workoutBlock('low', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12, mainSetClimbs: 3 }),
    ]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.regenerate());
    await waitFor(() => expect(countingFetchPool).toHaveBeenCalledTimes(2));
  });

  it('shares a pool between blocks that differ only in climb bias while signed out', async () => {
    const volume: VolumeOptions = { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15, mainSetClimbs: 2 };
    const selection = selectionOf([
      workoutBlock('any', volume),
      workoutBlock('attempted', volume, { ...ANY_FILTERS, climbBias: 'attempted' }),
    ]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(countingFetchPool).toHaveBeenCalledTimes(1);
    // The run still records the bias the climber picked.
    expect(result.current.toStagedQueueItems().run?.stages[1].filters?.climbBias).toBe('attempted');
  });

  it.each([
    ['moved', (selection: GeneratorSelection) => moveBlock(selection, 'block-a', 'down')],
    ['added', (selection: GeneratorSelection) => addBlock(selection, () => 'block-c', 15)],
    ['removed', (selection: GeneratorSelection) => removeBlock(selection, 'block-b')],
  ] as const)('hands Start nothing while a %s block rebuilds the preview', async (_change, changeBlocks) => {
    const committed = selectionOf([
      workoutBlock('block-first', { ...volumeWithWarmUp, warmUp: 'none' }),
      workoutBlock('block-a', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 }),
      workoutBlock('block-b', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 14, mainSetClimbs: 3 }),
    ]);
    const { result, rerender } = renderHook(
      ({ selection }: { selection: GeneratorSelection }) =>
        useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool, grades }),
      { initialProps: { selection: committed as GeneratorSelection } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.toStagedQueueItems().run?.stages).toHaveLength(3);

    rerender({ selection: changeBlocks(committed) });

    // The rows on screen belong to the old blocks: Start must not queue them.
    expect(result.current.status).toBe('loading');
    expect(result.current.toStagedQueueItems()).toEqual({ items: [], run: null });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.toStagedQueueItems().items.length).toBeGreaterThan(0);
  });

  it("ramps a warm-up at position 2 to block 3's grade and eases a trailing warm-up off from it", async () => {
    const selection = selectionOf([
      workoutBlock('focus', { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12, mainSetClimbs: 2 }),
      warmUpBlock('middle'),
      workoutBlock('pyramid', { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 22, numberOfSteps: 3 }),
      warmUpBlock('trailing'),
    ]);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const gradesIn = (section: string) =>
      result.current.items.filter((preview) => preview.slot.section === section).map((preview) => preview.slot.grade);
    expect(gradesIn('warmUp')).toEqual([18, 19, 20, 21]);
    // The 3-step pyramid ends on 21; the trailing warm-up carries on down from there, hardest first.
    expect(gradesIn('coolDown')).toEqual([20, 19, 18, 17]);
    expect(result.current.plannedStages.map((stage) => stage.kind)).toEqual(['volume', 'warmUp', 'pyramid', 'warmUp']);

    // Start queues the cool-down last, in the order it was planned.
    const { items, run } = result.current.toStagedQueueItems();
    expect(run?.stages.map((stage) => [stage.kind, stage.coolDown])).toEqual([
      ['volume', undefined],
      ['warmUp', undefined],
      ['pyramid', undefined],
      ['warmUp', true],
    ]);
    expect(items.slice(-4).map((item) => item.uuid)).toEqual(run?.stages[3].itemUuids);
  });

  it('plans nothing, and hands Start nothing, for a warm-up on its own', async () => {
    const countingFetchPool = vi.fn(fetchPool);
    const { result } = renderHook(() =>
      useWorkoutPreview(
        selectionOf([warmUpBlock('alone')]),
        board,
        { isAuthenticated: false },
        {
          fetchPool: countingFetchPool,
          grades,
        },
      ),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.plannedCount).toBe(0);
    expect(result.current.items).toEqual([]);
    expect(result.current.toStagedQueueItems()).toEqual({ items: [], run: null });
    expect(countingFetchPool).not.toHaveBeenCalled();
  });

  it('keeps the preview when the selection is re-created with the same blocks', async () => {
    const selection = selectionOf([workoutBlock('only', { ...volumeWithWarmUp, warmUp: 'none' })]);
    const countingFetchPool = vi.fn(fetchPool);
    const { result, rerender } = renderHook(
      ({ current }: { current: GeneratorSelection }) =>
        useWorkoutPreview(current, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
      { initialProps: { current: selection } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const rowUuids = result.current.items.map((preview) => preview.item.uuid);
    const fetchCount = countingFetchPool.mock.calls.length;

    rerender({ current: { ...selection, blocks: [...selection.blocks] } });

    expect(result.current.status).toBe('ready');
    expect(result.current.items.map((preview) => preview.item.uuid)).toEqual(rowUuids);
    expect(countingFetchPool).toHaveBeenCalledTimes(fetchCount);
  });

  it('starts empty with no blocks', () => {
    const { result } = renderHook(() =>
      useWorkoutPreview(NO_WORKOUT, board, { isAuthenticated: false }, { fetchPool, grades }),
    );

    expect(result.current.status).toBe('idle');
  });
});
