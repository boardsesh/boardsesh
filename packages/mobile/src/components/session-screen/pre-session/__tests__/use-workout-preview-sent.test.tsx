// @vitest-environment jsdom
// The preview against the REAL generator with a pool that tops up with sent
// climbs (#6232): unsent climbs fill the rows first, a shuffle keeps them
// first, Start queues exactly the rows on screen, and Skip what I've sent or
// signing out reach the fetch the way the switch says. Then the search budget:
// a grade with nothing more to find is not searched again on every edit, and a
// build the climber has moved past is told to stop.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { DEFAULT_GRADE_FOCUS_OPTIONS, type GeneratorGradeScale } from '@boardsesh/playlist-generator';
import {
  DEFAULT_WORKOUT_FILTERS,
  singleBlockSelection,
  type GeneratorSelection,
  type WorkoutBlock,
} from '../workout-blocks';
import { NO_TOP_UPS, type FetchGradePool, type GradePool } from '../workout-preview-pool';

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

/** Ten climbs at one grade: four you have not sent, six you have, the sent ones first. */
const UNSENT_COUNT = 4;
function poolAt(grade: number): GradePool {
  const sent = Array.from({ length: 6 }, (_, index) => ({ uuid: `g${grade}-sent-${index}` }) as Climb);
  const unsent = Array.from({ length: UNSENT_COUNT }, (_, index) => ({ uuid: `g${grade}-unsent-${index}` }) as Climb);
  return { climbs: [...sent, ...unsent], topUpTiers: new Map(sent.map((climb) => [climb.uuid, 2])) };
}

const isSent = (uuid: string) => uuid.includes('-sent-');

/** One grade-focus block of `numberOfClimbs` at V-grade 20. */
function gradeFocus(numberOfClimbs: number, filters = DEFAULT_WORKOUT_FILTERS): GeneratorSelection {
  return singleBlockSelection(
    { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 20, numberOfClimbs },
    'block-focus',
    filters,
  );
}

function renderPreview(selection: GeneratorSelection, fetchPool: FetchGradePool, isAuthenticated = true) {
  return renderHook(() => useWorkoutPreview(selection, board, { isAuthenticated }, { fetchPool, grades }));
}

describe('useWorkoutPreview with sent climbs as top-up', () => {
  it('fills the rows with unsent climbs first and only then with sent ones', async () => {
    const { result } = renderPreview(gradeFocus(7), async (grade) => poolAt(grade));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const uuids = result.current.items.map((preview) => preview.item.climb.uuid);
    expect(uuids).toHaveLength(7);
    expect(uuids.slice(0, UNSENT_COUNT).every((uuid) => !isSent(uuid))).toBe(true);
    expect(uuids.slice(UNSENT_COUNT).every(isSent)).toBe(true);
  });

  it('keeps the unsent climbs first through Shuffle, and Start queues the rows on screen', async () => {
    const { result } = renderPreview(gradeFocus(6), async (grade) => poolAt(grade));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    for (let shuffle = 0; shuffle < 3; shuffle++) {
      act(() => result.current.shuffle());
      const shown = result.current.items.map((preview) => preview.item);
      expect(shown.slice(0, UNSENT_COUNT).every((item) => !isSent(item.climb.uuid))).toBe(true);

      const { items: queued, run } = result.current.toStagedQueueItems();
      expect(queued).toEqual(shown);
      expect(run?.stages.flatMap((stage) => stage.itemUuids)).toEqual(shown.map((item) => item.uuid));
    }
  });

  it('marks every sent top-up sent, through a build and a Shuffle, with no logbook loaded', async () => {
    const { result } = renderPreview(gradeFocus(7), async (grade) => poolAt(grade));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const marks = () =>
      result.current.items.map((preview) => [isSent(preview.item.climb.uuid), preview.knownStatus ?? null]);
    const expected = (rows: ReturnType<typeof marks>) => rows.map(([sent]) => [sent, sent ? 'send' : null]);
    expect(marks()).toEqual(expected(marks()));
    expect(marks().filter(([sent]) => sent)).toHaveLength(3);

    act(() => result.current.shuffle());
    expect(marks()).toEqual(expected(marks()));
  });

  it('carries Skip what I have sent into the fetch and into the run that starts', async () => {
    const skipping = { ...DEFAULT_WORKOUT_FILTERS, skipSent: true };
    const fetchPool = vi.fn<FetchGradePool>(async (grade) => ({
      climbs: poolAt(grade).climbs.slice(6),
      topUpTiers: new Map(),
    }));
    const { result } = renderPreview(gradeFocus(7, skipping), fetchPool);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(fetchPool.mock.calls[0][1].filters?.skipSent).toBe(true);
    // Only the unsent climbs fit: the preview comes up short instead of showing sent ones.
    expect(result.current.items).toHaveLength(UNSENT_COUNT);
    expect(result.current.plannedCount).toBe(7);
    expect(result.current.toStagedQueueItems().run?.stages[0].filters?.skipSent).toBe(true);
  });

  it('fetches signed out without Skip what I have sent, while the run keeps the switch', async () => {
    const skipping = { ...DEFAULT_WORKOUT_FILTERS, skipSent: true };
    const fetchPool = vi.fn<FetchGradePool>(async (grade) => poolAt(grade));
    const { result } = renderPreview(gradeFocus(3, skipping), fetchPool, false);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(fetchPool.mock.calls[0][1].filters).toEqual({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' });
    expect(result.current.toStagedQueueItems().run?.stages[0].filters?.skipSent).toBe(true);
  });
});

describe('useWorkoutPreview search budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A thin block at grade 12 and a block at grade 18 the climber keeps editing. */
  function twoBlocks(deepClimbs: number): GeneratorSelection {
    const block = (id: string, targetGrade: number, numberOfClimbs: number): WorkoutBlock => ({
      id,
      kind: 'workout',
      options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade, numberOfClimbs },
      filters: DEFAULT_WORKOUT_FILTERS,
    });
    return { blocks: [block('thin', 12, 4), block('deep', 18, deepClimbs)] };
  }

  it('searches a grade with nothing more to find once, however often another block changes', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async (grade) =>
      grade === 12
        ? {
            climbs: [{ uuid: 'thin-0' } as Climb, { uuid: 'thin-1' } as Climb],
            topUpTiers: NO_TOP_UPS,
            exhausted: true,
          }
        : poolAt(grade),
    );
    const { result, rerender } = renderHook(
      ({ selection }: { selection: GeneratorSelection }) =>
        useWorkoutPreview(selection, board, { isAuthenticated: true }, { fetchPool, grades }),
      { initialProps: { selection: twoBlocks(2) } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    for (let deepClimbs = 3; deepClimbs <= 8; deepClimbs++) {
      rerender({ selection: twoBlocks(deepClimbs) });
      await waitFor(() => expect(result.current.plannedCount).toBe(4 + deepClimbs));
    }

    expect(fetchPool.mock.calls.filter(([grade]) => grade === 12)).toHaveLength(1);
    // The thin block shows what its grade has: a shortfall, not a fresh search.
    expect(result.current.items.filter((preview) => preview.slot.grade === 12)).toHaveLength(2);
  });

  it("tells a superseded build's searches to stop", async () => {
    vi.useFakeTimers();
    const fetchPool = vi.fn<FetchGradePool>(() => new Promise<GradePool>(() => undefined));
    const { rerender } = renderHook(
      ({ selection }: { selection: GeneratorSelection }) =>
        useWorkoutPreview(selection, board, { isAuthenticated: true }, { fetchPool, grades }),
      { initialProps: { selection: gradeFocus(3) } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const firstBuild = fetchPool.mock.calls[0][1];
    expect(firstBuild.isCurrent?.()).toBe(true);

    rerender({ selection: gradeFocus(4) });

    expect(firstBuild.isCurrent?.()).toBe(false);
  });
});
