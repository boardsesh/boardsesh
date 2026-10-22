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
  type PyramidOptions,
  type VolumeOptions,
} from '@boardsesh/playlist-generator';
import {
  NO_WORKOUT,
  addBlock,
  moveBlock,
  removeBlock,
  type GeneratorSelection,
  type WorkoutBlock,
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
const warmUpBlock = (id: string): WorkoutBlock => ({ id, kind: 'warmUp', warmUpType: 'standard' });
const selectionOf = (blocks: WorkoutBlock[]): GeneratorSelection => ({ blocks, filters: ANY_FILTERS });

// A deep pool at every grade, with climb uuids unique across grades.
const fetchPool: FetchGradePool = async (grade) =>
  Array.from({ length: 30 }, (_, index) => ({ uuid: `g${grade}-${index}`, name: `g${grade}-${index}` }) as Climb);

describe('useWorkoutPreview stages', () => {
  it('plans the same slots as before and groups the queued climbs by stage', async () => {
    const selection = selectionOf([
      warmUpBlock('warm'),
      { id: 'volume', kind: 'workout', options: { ...volumeWithWarmUp, warmUp: 'none' } },
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
      { id: 'block-pyramid', kind: 'workout', options: pyramid },
      { id: 'block-volume', kind: 'workout', options: volume },
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
    // The volume block's fetch carries the shared filters, not its options' own
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

  it.each([
    ['moved', (selection: GeneratorSelection) => moveBlock(selection, 'block-a', 'down')],
    ['added', (selection: GeneratorSelection) => addBlock(selection, () => 'block-c', 15)],
    ['removed', (selection: GeneratorSelection) => removeBlock(selection, 'block-b')],
  ] as const)('hands Start nothing while a %s block rebuilds the preview', async (_change, changeBlocks) => {
    const committed = selectionOf([
      { id: 'block-first', kind: 'workout', options: { ...volumeWithWarmUp, warmUp: 'none' } },
      { id: 'block-a', kind: 'workout', options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 } },
      { id: 'block-b', kind: 'workout', options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 14, mainSetClimbs: 3 } },
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

  it("ramps a warm-up at position 2 to block 3's grade and plans none for a trailing warm-up", async () => {
    const selection = selectionOf([
      { id: 'focus', kind: 'workout', options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 12, mainSetClimbs: 2 } },
      warmUpBlock('middle'),
      { id: 'pyramid', kind: 'workout', options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 22, numberOfSteps: 3 } },
      warmUpBlock('trailing'),
    ]);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const middleGrades = result.current.items
      .filter((preview) => preview.slot.section === 'warmUp')
      .map((preview) => preview.slot.grade);
    expect(middleGrades).toEqual([18, 19, 20, 21]);
    // The trailing warm-up has nothing to ramp to: no climbs, no heading.
    expect(result.current.plannedStages.map((stage) => stage.kind)).toEqual(['volume', 'warmUp', 'pyramid']);
    expect(result.current.toStagedQueueItems().run?.stages.map((stage) => stage.kind)).toEqual([
      'volume',
      'warmUp',
      'pyramid',
    ]);
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
    const selection = selectionOf([{ id: 'only', kind: 'workout', options: { ...volumeWithWarmUp, warmUp: 'none' } }]);
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
