// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { GeneratorGradeScale, PlannedClimbSlot, VolumeOptions } from '@boardsesh/playlist-generator';
import type { GeneratorSelection } from '../GeneratorPickerCard';
import type { FetchGradePool } from '../workout-preview-pool';

const cryptoMock = vi.hoisted(() => {
  let n = 0;
  return { randomUUID: () => `qi-${n++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => cryptoMock.randomUUID() }));

// Plan is mocked so tests control the slot count/grades independent of the
// real generator algorithm (covered by its own tests).
const generator = vi.hoisted(() => ({
  plan: [
    { grade: 10, section: 'main', index: 0 },
    { grade: 10, section: 'main', index: 1 },
  ] as PlannedClimbSlot[],
}));
vi.mock('@boardsesh/playlist-generator', () => ({ generateWorkoutPlan: () => generator.plan }));

// Don't load the real GraphQL-backed fetcher; the hook is driven via deps.fetchPool.
vi.mock('../select-climbs-for-plan', () => ({ fetchGradePool: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => toast }));

import { useWorkoutPreview } from '../use-workout-preview';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1145r15',
    difficulty: '6a',
    quality_average: '3',
    setter_username: 'tester',
    angle: 40,
    ascensionist_count: 5,
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    is_no_match: false,
  } as Climb;
}

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard;
const grades: GeneratorGradeScale = [{ difficulty_id: 10 }, { difficulty_id: 11 }];

const OFF: GeneratorSelection = { type: 'off' };
function on(targetGrade: number, overrides?: Partial<VolumeOptions>): GeneratorSelection {
  return {
    type: 'on',
    options: {
      type: 'volume',
      targetGrade,
      warmUp: 'none',
      mainSetClimbs: 20,
      mainSetVariability: 0,
      minAscents: 0,
      minRating: 0,
      onlyTallClimbs: false,
      onlyWideClimbs: false,
      climbBias: 'any',
      ...overrides,
    },
  };
}

type Props = { selection: GeneratorSelection };
function renderPreview(fetchPool: FetchGradePool, initial: GeneratorSelection = OFF) {
  return renderHook(
    ({ selection }: Props) => useWorkoutPreview(selection, board, { isAuthenticated: false }, { fetchPool, grades }),
    {
      initialProps: { selection: initial },
    },
  );
}

type AuthProps = { selection: GeneratorSelection; isAuthenticated: boolean };
function renderPreviewWithAuth(fetchPool: FetchGradePool, initial: GeneratorSelection = OFF, isAuthenticated = false) {
  return renderHook(
    ({ selection, isAuthenticated: authState }: AuthProps) =>
      useWorkoutPreview(selection, board, { isAuthenticated: authState }, { fetchPool, grades }),
    {
      initialProps: { selection: initial, isAuthenticated },
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
  toast.showToast.mockClear();
});

describe('useWorkoutPreview', () => {
  it('stays idle while the generator is off', () => {
    const fetchPool = vi.fn<FetchGradePool>();
    const { result } = renderPreview(fetchPool, OFF);
    expect(result.current.status).toBe('idle');
    expect(result.current.items).toEqual([]);
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('builds a preview after the debounce when turned on', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toHaveLength(2); // 2-slot plan
    expect(result.current.plannedSlots).toEqual(generator.plan);
    // Pool order is shuffled, so assert distinct membership rather than order.
    const uuids = result.current.items.map((preview) => preview.item.climb.uuid);
    expect(new Set(uuids).size).toBe(2); // two distinct climbs
    expect(uuids.every((uuid) => ['a', 'b', 'c'].includes(uuid))).toBe(true);
    expect(result.current.plannedCount).toBe(2);
    expect(fetchPool).toHaveBeenCalledTimes(1); // one unique grade
    expect(result.current.toQueueItems().map((item) => item.climb.uuid)).toEqual(uuids);
  });

  it('coalesces rapid selection changes into a single build', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10) }); // schedules a build
    rerender({ selection: on(11) }); // different key → reschedules, supersedes the first timer

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchPool).toHaveBeenCalledTimes(1); // only the last build ran
  });

  it('rebuilds when a workout-shape option changes without changing the target grade', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10, { mainSetClimbs: 20 }) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    fetchPool.mockClear();

    rerender({ selection: on(10, { mainSetClimbs: 21 }) });

    await waitFor(() => expect(fetchPool).toHaveBeenCalledTimes(1));
  });

  it('hides stale generated plan data while a changed selection rebuilds', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.toQueueItems()).toHaveLength(2);

    rerender({ selection: on(11) });

    expect(result.current.status).toBe('loading');
    expect(result.current.plannedSlots).toEqual([]);
    expect(result.current.plannedCount).toBe(0);
    expect(result.current.toQueueItems()).toEqual([]);

    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('rebuilds when authentication changes because climb-bias filters depend on auth', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);
    const selection = on(10, { climbBias: 'unfamiliar' });
    const { result, rerender } = renderPreviewWithAuth(fetchPool, selection, false);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    fetchPool.mockClear();

    rerender({ selection, isAuthenticated: true });

    await waitFor(() => expect(fetchPool).toHaveBeenCalledTimes(1));
  });

  it('clears back to idle when the generator is turned off', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b')]);
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10) });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ selection: OFF });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.items).toEqual([]);
    expect(result.current.plannedSlots).toEqual([]);
  });

  it('refreshes a single row and de-dupes a double-tap into one fetch', async () => {
    // Pool is exactly [a, b] for 2 slots → both used → refresh misses the cache
    // and must refetch (so we can count the fetch).
    const fetchPool = vi.fn<FetchGradePool>(async () => [makeClimb('a'), makeClimb('b')]);
    const { result } = renderPreview(fetchPool, on(10));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const targetUuid = result.current.items[0].item.uuid;
    const initialClimbUuid = result.current.items[0].item.climb.uuid; // 'a' or 'b' (shuffled)
    fetchPool.mockClear();

    await act(async () => {
      result.current.refreshSlot(targetUuid);
      result.current.refreshSlot(targetUuid); // second tap is dropped by the in-flight guard
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.refreshingUuids.size).toBe(0));
    expect(fetchPool).toHaveBeenCalledTimes(1); // single refetch despite the double tap
    expect(result.current.items[0].item.uuid).toBe(targetUuid); // queue-item identity preserved
    expect(result.current.items[0].item.climb.uuid).not.toBe(initialClimbUuid); // swapped climb
    expect(['a', 'b']).toContain(result.current.items[0].item.climb.uuid);
  });

  it('drops a stale build whose fetch resolves after a newer one', async () => {
    vi.useFakeTimers();
    const deferreds: Array<(climbs: Climb[]) => void> = [];
    const fetchPool = vi.fn<FetchGradePool>(
      () =>
        new Promise<Climb[]>((resolve) => {
          deferreds.push(resolve);
        }),
    );
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10) }); // schedules build #1
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // build #1 starts, parks on fetchPool (deferreds[0])
    });
    rerender({ selection: on(11) }); // schedules build #2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // build #2 starts, parks on fetchPool (deferreds[1])
    });

    // Resolve the STALE build first, then the fresh one.
    await act(async () => {
      deferreds[0]?.([makeClimb('stale')]);
      await Promise.resolve();
    });
    await act(async () => {
      deferreds[1]?.([makeClimb('fresh')]);
      await Promise.resolve();
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.items.every((preview) => preview.item.climb.uuid === 'fresh')).toBe(true);
  });

  it('drops a stale row refresh after the preview is cleared', async () => {
    let resolveRefresh: ((climbs: Climb[]) => void) | null = null;
    const fetchPool = vi
      .fn<FetchGradePool>()
      .mockResolvedValueOnce([makeClimb('a'), makeClimb('b')])
      .mockImplementationOnce(
        () =>
          new Promise<Climb[]>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const { result, rerender } = renderPreview(fetchPool, on(10));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const targetUuid = result.current.items[0].item.uuid;

    await act(async () => {
      result.current.refreshSlot(targetUuid);
      await Promise.resolve();
    });
    rerender({ selection: OFF });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      resolveRefresh?.([makeClimb('c')]);
      await Promise.resolve();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.items).toEqual([]);
  });

  it('sets error status, toasts, and leaves previous items in place when a rebuild fails', async () => {
    const fetchPool = vi
      .fn<FetchGradePool>()
      .mockResolvedValueOnce([makeClimb('a'), makeClimb('b')])
      .mockRejectedValueOnce(new Error('search failed'));
    const { result, rerender } = renderPreview(fetchPool, OFF);

    rerender({ selection: on(10) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const previousUuids = result.current.items.map((preview) => preview.item.climb.uuid);

    rerender({ selection: on(11) });
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.items.map((preview) => preview.item.climb.uuid)).toEqual(previousUuids);
    expect(result.current.plannedSlots).toEqual([]);
    expect(result.current.plannedCount).toBe(0);
    expect(result.current.toQueueItems()).toEqual([]);
    expect(toast.showToast).toHaveBeenCalledWith('mobile.session.preWorkoutPreviewError', 'error');
  });
});
