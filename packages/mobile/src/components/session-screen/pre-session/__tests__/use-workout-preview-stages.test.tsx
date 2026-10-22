// @vitest-environment jsdom
// The preview against the REAL generator: a warm-up plus a workout must come out
// as two stages whose climbs are exactly the warm-up rows and the workout rows.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { generateWorkoutPlan, type GeneratorGradeScale, type VolumeOptions } from '@boardsesh/playlist-generator';
import type { GeneratorSelection } from '../GeneratorPickerCard';
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
    const selection: GeneratorSelection = { type: 'on', options: volumeWithWarmUp };
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
});
