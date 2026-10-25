// @vitest-environment jsdom
// The timed blocks (on the minute, 4x4, limit) through the preview: a 4x4
// previews one row per set and Start queues each once, and changing its reps
// or a rest rebuilds the run Start hands over without re-picking the climbs the
// climber already sees.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  type FourByFourOptions,
  type GeneratorGradeScale,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';
import type { GeneratorSelection, WorkoutBlock, WorkoutFilters } from '../workout-blocks';
import { NO_TOP_UPS, type FetchGradePool } from '../workout-preview-pool';

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
const ANY_FILTERS: WorkoutFilters = {
  minAscents: 0,
  minRating: 0,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  climbBias: 'any',
};

const fetchPool: FetchGradePool = async (grade) => ({
  climbs: Array.from(
    { length: 30 },
    (_, index) => ({ uuid: `g${grade}-${index}`, name: `g${grade}-${index}` }) as Climb,
  ),
  topUpTiers: NO_TOP_UPS,
});

const selectionWith = (options: GeneratorOptions): GeneratorSelection => ({
  blocks: [{ id: 'timed', kind: 'workout', options, filters: ANY_FILTERS } satisfies WorkoutBlock],
});

const fourByFour: FourByFourOptions = { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18 };

function renderPreview(options: GeneratorOptions) {
  const countingFetchPool = vi.fn(fetchPool);
  const rendered = renderHook(
    ({ selection }: { selection: GeneratorSelection }) =>
      useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool: countingFetchPool, grades }),
    { initialProps: { selection: selectionWith(options) } },
  );
  return { ...rendered, countingFetchPool };
}

const rowsOf = (items: ReadonlyArray<{ item: { uuid: string; climb: { uuid: string } } }>) =>
  items.map(({ item }) => [item.uuid, item.climb.uuid]);

describe('useWorkoutPreview with timed blocks', () => {
  it('previews a 4x4 as one row per set, and hands Start one queue item per set and its pacing', async () => {
    const { result } = renderPreview(fourByFour);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.items).toHaveLength(4);
    const { items, run } = result.current.toStagedQueueItems();
    expect(items).toEqual(result.current.items.map(({ item }) => item));
    expect(run?.stages).toEqual([
      expect.objectContaining({
        kind: 'fourByFour',
        targetGrade: 18,
        itemUuids: items.map((item) => item.uuid),
        pacing: {
          mode: 'afterTick',
          restSeconds: 0,
          advanceOn: 'set',
          sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
        },
      }),
    ]);
    expect(result.current.plannedCount).toBe(4);
  });

  it.each([
    {
      type: 'onTheMinute',
      options: { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 16 },
      rowCount: 10,
      pacing: { mode: 'onTheMinute', restSeconds: 60 },
    },
    {
      type: 'limitBouldering',
      options: { ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 22 },
      rowCount: 3,
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ])('previews $type with one row per climb and its pacing', async ({ options, rowCount, pacing }) => {
    const { result } = renderPreview(options);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.items).toHaveLength(rowCount);
    expect(result.current.toStagedQueueItems().run?.stages[0].pacing).toEqual(pacing);
  });

  it('hands the same queue items over on every Start, one per set', async () => {
    const { result } = renderPreview(fourByFour);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const first = result.current.toStagedQueueItems().items.map((item) => item.uuid);
    const second = result.current.toStagedQueueItems().items.map((item) => item.uuid);

    expect(first).toHaveLength(4);
    expect(second).toEqual(first);
  });

  it('counts the queued climbs and gives the time for the summary line', async () => {
    const { result } = renderPreview(fourByFour);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.startQueue).toEqual({ climbCount: 4, estimatedMinutes: 20 });
  });

  it('rebuilds on a reps or rest change and keeps the climbs on screen', async () => {
    const { result, rerender, countingFetchPool } = renderPreview(fourByFour);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const rows = rowsOf(result.current.items);
    const fetchCount = countingFetchPool.mock.calls.length;

    rerender({
      selection: selectionWith({
        ...fourByFour,
        repsPerSet: 6,
        restBetweenRepsSeconds: 30,
        restBetweenSetsSeconds: 240,
      }),
    });
    // toStagedQueueItems reads refs that update before React commits the rebuild,
    // so wait for the committed 'ready' render too, not only the new run.
    await waitFor(() => {
      expect(result.current.toStagedQueueItems().run?.stages[0].pacing).toEqual({
        mode: 'afterTick',
        restSeconds: 30,
        advanceOn: 'set',
        sets: { repsPerSet: 6, restBetweenSetsSeconds: 240 },
      });
      expect(result.current.status).toBe('ready');
    });

    expect(rowsOf(result.current.items)).toEqual(rows);
    expect(result.current.toStagedQueueItems().items).toHaveLength(4);
    expect(result.current.startQueue.climbCount).toBe(4);
    expect(countingFetchPool).toHaveBeenCalledTimes(fetchCount);
  });

  it('re-picks the rows when the sets change', async () => {
    const { result, rerender } = renderPreview(fourByFour);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const rowUuids = result.current.items.map(({ item }) => item.uuid);

    rerender({ selection: selectionWith({ ...fourByFour, sets: 5 }) });
    await waitFor(() => expect(result.current.items).toHaveLength(5));

    expect(result.current.items.map(({ item }) => item.uuid)).not.toEqual(expect.arrayContaining(rowUuids));
  });

  it('rebuilds the run on an on-the-minute interval change and keeps the climbs on screen', async () => {
    const onTheMinute = { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 18 };
    const { result, rerender } = renderPreview(onTheMinute);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const rows = rowsOf(result.current.items);
    const newInterval = onTheMinute.intervalSeconds + 15;

    rerender({ selection: selectionWith({ ...onTheMinute, intervalSeconds: newInterval }) });
    await waitFor(() => {
      expect(result.current.toStagedQueueItems().run?.stages[0].pacing).toMatchObject({ restSeconds: newInterval });
      expect(result.current.status).toBe('ready');
    });

    expect(rowsOf(result.current.items)).toEqual(rows);
  });
});
