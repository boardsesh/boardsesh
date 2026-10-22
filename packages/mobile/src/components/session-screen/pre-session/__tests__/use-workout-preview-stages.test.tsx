// @vitest-environment jsdom
// The preview against the REAL generator: a warm-up plus a workout must come out
// as two stages whose climbs are exactly the warm-up rows and the workout rows.
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
import type { GeneratorSelection } from '../GeneratorPickerCard';
import { addBlock, moveBlock, removeBlock, type ActiveGeneratorSelection } from '../workout-blocks';
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

// A deep pool at every grade, with climb uuids unique across grades.
const fetchPool: FetchGradePool = async (grade) =>
  Array.from({ length: 30 }, (_, index) => ({ uuid: `g${grade}-${index}`, name: `g${grade}-${index}` }) as Climb);

describe('useWorkoutPreview stages', () => {
  it('plans the same slots as before and groups the queued climbs by stage', async () => {
    const selection: GeneratorSelection = { type: 'on', options: volumeWithWarmUp, extraBlocks: [] };
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
    const pyramid: PyramidOptions = {
      ...DEFAULT_PYRAMID_OPTIONS,
      targetGrade: 22,
      warmUp: 'standard',
      numberOfSteps: 3,
      climbsPerStep: 1,
      minAscents: 0,
      minRating: 0,
      climbBias: 'any',
    };
    const volume: VolumeOptions = { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 15, mainSetClimbs: 4 };
    const selection: GeneratorSelection = {
      type: 'on',
      options: pyramid,
      extraBlocks: [{ id: 'block-volume', options: volume }],
    };
    const countingFetchPool = vi.fn(fetchPool);
    const { result } = renderHook(() =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Warm-up up to the first block, then the pyramid, then the volume block on the first card's filters.
    expect(result.current.plannedStages.map((stage) => stage.kind)).toEqual(['warmUp', 'pyramid', 'volume']);
    const expectedSlots = generateStagedPlan(
      planFromBlocks([pyramid, { ...volume, minAscents: 0, minRating: 0, climbBias: 'any' }], 'standard', () => 'x'),
      grades,
    ).map(({ grade, section, index }) => ({ grade, section, index }));
    expect(result.current.plannedSlots.map(({ grade, section, index }) => ({ grade, section, index }))).toEqual(
      expectedSlots,
    );
    // The volume block's fetch carries the first card's filters, not its own
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
    ['moved', (selection: ActiveGeneratorSelection) => moveBlock(selection, 'block-a', 'down')],
    ['added', (selection: ActiveGeneratorSelection) => addBlock(selection, () => 'block-c')],
    ['removed', (selection: ActiveGeneratorSelection) => removeBlock(selection, 'block-b')],
  ] as const)('hands Start nothing while a %s block rebuilds the preview', async (_change, changeBlocks) => {
    const committed: ActiveGeneratorSelection = {
      type: 'on',
      options: { ...volumeWithWarmUp, warmUp: 'none' },
      extraBlocks: [
        { id: 'block-a', options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 } },
        { id: 'block-b', options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 14, mainSetClimbs: 3 } },
      ],
    };
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
});
