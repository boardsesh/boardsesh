import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { DELETE_TICK, GET_TICKS, UPDATE_TICK, type UpdateTickResponse } from '@boardsesh/graphql/operations';
import type { ExecuteHttp } from '../adapter';
import {
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKey,
  fetchedLogbookClimbUuidsQueryKey,
  toLogbookEntry,
  type LogbookEntry,
  type LogbookSourceTick,
} from '../logbook-keys';
import { useLogbook } from '../use-logbook';
import { useDeleteTick, useUpdateTick } from '../use-mutate-tick';
import { createWrapper } from './test-helpers';

const DRAWER_CLIMBS = ['climb-1'];
const MIXED_CLIMBS = ['climb-1', 'climb-2'];
const OTHER_CLIMB = ['climb-2'];
const mutationInput = { uuid: 'tick-1', input: { status: 'attempt' as const, attemptCount: 5, comment: 'Updated' } };

function serverTick(overrides: Partial<LogbookSourceTick> = {}): LogbookSourceTick {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: true,
    status: 'send',
    attemptCount: 2,
    quality: 2,
    effectiveQuality: 2,
    difficulty: 16,
    comment: 'Original',
    climbedAt: '2026-05-30T00:00:00.000Z',
    climbRevision: 5,
    upvotes: 7,
    downvotes: 2,
    commentCount: 3,
    ...overrides,
  };
}

function updatedTick(quality: number | null = 4): UpdateTickResponse['updateTick'] {
  return {
    uuid: 'tick-1',
    boardId: null,
    boardDisplayName: null,
    status: 'attempt',
    attemptCount: 5,
    quality,
    difficulty: 18,
    isBenchmark: false,
    comment: 'Updated',
    climbedAt: '2026-06-01T00:00:00.000Z',
    angle: 25,
    updatedAt: '2026-06-02T00:00:00.000Z',
  };
}

function useTickMutations() {
  return { edit: useUpdateTick(), deletion: useDeleteTick() };
}

type MutationKind = 'edit' | 'delete';

function runMutation(kind: MutationKind, mutations: ReturnType<typeof useTickMutations>): Promise<unknown> {
  return kind === 'edit' ? mutations.edit.mutateAsync(mutationInput) : mutations.deletion.mutateAsync('tick-1');
}

function seedLogbooks(queryClient: QueryClient) {
  const target = toLogbookEntry(serverTick());
  const unrelated = toLogbookEntry(serverTick({ uuid: 'tick-other', climbUuid: 'climb-2' }));
  const optimistic = toLogbookEntry(serverTick({ uuid: 'temp-pending-save' }));
  const queued = toLogbookEntry(serverTick({ uuid: 'queued-real-uuid' }));
  const untouched = toLogbookEntry(serverTick({ uuid: 'tick-tension' }));
  const rows = [target, unrelated, optimistic, queued];
  const marker = new Set(DRAWER_CLIMBS);
  queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), rows, { updatedAt: 100 });
  queryClient.setQueryData(fetchLogbookQueryKey('kilter', MIXED_CLIMBS), rows, { updatedAt: 50 });
  queryClient.setQueryData(accumulatedLogbookQueryKey('tension'), [untouched], { updatedAt: 200 });
  queryClient.setQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'), marker, { updatedAt: 300 });
  return { target, unrelated, optimistic, queued, untouched, marker };
}

describe('tick mutations reconcile mounted logbooks', () => {
  it('removes a deleted tick from the open drawer and its reusable fetch batch', async () => {
    let deleted = false;
    const executeHttp = vi.fn(async (document: string) => {
      if (document === DELETE_TICK) {
        deleted = true;
        return { deleteTick: true };
      }
      if (document === GET_TICKS) return { ticks: deleted ? [] : [serverTick()] };
      throw new Error('Unexpected operation');
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const view = renderHook(() => ({ history: useLogbook('kilter', DRAWER_CLIMBS), mutations: useTickMutations() }), {
      wrapper,
    });
    await waitFor(() => expect(view.result.current.history.logbook).toHaveLength(1));
    const marker = view.result.current.history.fetchedUuids;

    await act(async () => {
      await view.result.current.mutations.deletion.mutateAsync('tick-1');
    });

    await waitFor(() => expect(view.result.current.history.logbook).toEqual([]));
    expect(queryClient.getQueryData(fetchLogbookQueryKey('kilter', DRAWER_CLIMBS))).toEqual([]);
    expect(view.result.current.history.fetchedUuids).toBe(marker);
    view.unmount();
    queryClient.clear();
  });

  it('updates the open drawer while preserving fields absent from the mutation response', async () => {
    let edited = false;
    const executeHttp = vi.fn(async (document: string) => {
      if (document === UPDATE_TICK) {
        edited = true;
        return { updateTick: updatedTick() };
      }
      if (document === GET_TICKS) {
        return { ticks: [serverTick(edited ? { ...updatedTick(), status: 'attempt', effectiveQuality: 4 } : {})] };
      }
      throw new Error('Unexpected operation');
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const view = renderHook(() => ({ history: useLogbook('kilter', DRAWER_CLIMBS), mutations: useTickMutations() }), {
      wrapper,
    });
    await waitFor(() => expect(view.result.current.history.logbook[0]?.comment).toBe('Original'));

    await act(async () => {
      await view.result.current.mutations.edit.mutateAsync(mutationInput);
    });

    await waitFor(() =>
      expect(view.result.current.history.logbook[0]).toMatchObject({
        angle: 25,
        tries: 5,
        quality: 4,
        effectiveQuality: 4,
        difficulty: 18,
        comment: 'Updated',
        climbed_at: '2026-06-01T00:00:00.000Z',
        status: 'attempt',
        is_ascent: false,
        climb_uuid: 'climb-1',
        is_mirror: true,
        climb_revision: 5,
        upvotes: 7,
        downvotes: 2,
        commentCount: 3,
      }),
    );
    view.unmount();
    queryClient.clear();
  });

  it.each(['edit', 'delete'] as const)(
    'preserves unrelated and pending rows, markers, and answer times after %s',
    async (kind) => {
      const executeHttp = vi.fn(async () => (kind === 'edit' ? { updateTick: updatedTick() } : { deleteTick: true }));
      const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
      const seeded = seedLogbooks(queryClient);
      const view = renderHook(useTickMutations, { wrapper });

      await act(async () => {
        await runMutation(kind, view.result.current);
      });

      for (const queryKey of [accumulatedLogbookQueryKey('kilter'), fetchLogbookQueryKey('kilter', MIXED_CLIMBS)]) {
        const entries = queryClient.getQueryData<LogbookEntry[]>(queryKey) ?? [];
        expect(entries.filter((entry) => entry.uuid !== 'tick-1')).toEqual([
          seeded.unrelated,
          seeded.optimistic,
          seeded.queued,
        ]);
        expect(entries.find((entry) => entry.uuid === 'tick-1')).toEqual(
          kind === 'delete' ? undefined : expect.objectContaining({ comment: 'Updated' }),
        );
      }
      expect(queryClient.getQueryState(accumulatedLogbookQueryKey('kilter'))?.dataUpdatedAt).toBe(100);
      expect(queryClient.getQueryState(fetchLogbookQueryKey('kilter', MIXED_CLIMBS))?.dataUpdatedAt).toBe(50);
      expect(queryClient.getQueryState(accumulatedLogbookQueryKey('tension'))?.dataUpdatedAt).toBe(200);
      expect(queryClient.getQueryData(accumulatedLogbookQueryKey('tension'))).toEqual([seeded.untouched]);
      expect(queryClient.getQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'))).toBe(seeded.marker);
      expect(queryClient.getQueryState(fetchedLogbookClimbUuidsQueryKey('kilter'))?.dataUpdatedAt).toBe(300);
      view.unmount();
      queryClient.clear();
    },
  );

  it.each(['edit', 'delete'] as const)('does not let a pre-%s batch restore an old row', async (kind) => {
    let mutated = false;
    let reads = 0;
    let releaseOldRead: (response: { ticks: LogbookSourceTick[] }) => void = () => {};
    const oldRead = new Promise<{ ticks: LogbookSourceTick[] }>((resolve) => {
      releaseOldRead = resolve;
    });
    const executeHttp = vi.fn(async (document: string) => {
      if (document === DELETE_TICK || document === UPDATE_TICK) {
        mutated = true;
        return kind === 'edit' ? { updateTick: updatedTick() } : { deleteTick: true };
      }
      reads += 1;
      if (reads === 2) return oldRead;
      return {
        ticks: !mutated
          ? [serverTick()]
          : kind === 'delete'
            ? []
            : [serverTick({ ...updatedTick(), status: 'attempt', effectiveQuality: 4 })],
      };
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const view = renderHook(() => ({ history: useLogbook('kilter', DRAWER_CLIMBS), mutations: useTickMutations() }), {
      wrapper,
    });
    await waitFor(() => expect(view.result.current.history.logbook).toHaveLength(1));
    const pendingRefetch = queryClient.refetchQueries({
      queryKey: fetchLogbookQueryKey('kilter', DRAWER_CLIMBS),
      exact: true,
    });
    await waitFor(() => expect(reads).toBe(2));

    await act(async () => {
      await runMutation(kind, view.result.current.mutations);
      releaseOldRead({ ticks: [serverTick()] });
      await pendingRefetch;
      await oldRead;
    });

    await waitFor(() => {
      if (kind === 'delete') expect(view.result.current.history.logbook).toEqual([]);
      else expect(view.result.current.history.logbook[0]?.comment).toBe('Updated');
    });
    view.unmount();
    queryClient.clear();
  });

  it.each(['edit', 'delete'] as const)('cancels an initial unresolved batch before %s cache writes', async (kind) => {
    let reads = 0;
    let releaseOldRead: (response: { ticks: LogbookSourceTick[] }) => void = () => {};
    const oldRead = new Promise<{ ticks: LogbookSourceTick[] }>((resolve) => {
      releaseOldRead = resolve;
    });
    const executeHttp = vi.fn(async (document: string) => {
      if (document === DELETE_TICK || document === UPDATE_TICK) {
        return kind === 'edit' ? { updateTick: updatedTick() } : { deleteTick: true };
      }
      reads += 1;
      if (reads === 1) return oldRead;
      return {
        ticks: kind === 'delete' ? [] : [serverTick({ ...updatedTick(), status: 'attempt', effectiveQuality: 4 })],
      };
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    // The accumulated row can come from a previous multi-climb batch even
    // though this drawer's initial single-climb request has no data yet.
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), [toLogbookEntry(serverTick())]);
    const view = renderHook(() => ({ history: useLogbook('kilter', DRAWER_CLIMBS), mutations: useTickMutations() }), {
      wrapper,
    });
    await waitFor(() => expect(reads).toBe(1));

    await act(async () => {
      await runMutation(kind, view.result.current.mutations);
      releaseOldRead({ ticks: [serverTick()] });
      await oldRead;
    });

    await waitFor(() => {
      if (kind === 'delete') expect(view.result.current.history.logbook).toEqual([]);
      else expect(view.result.current.history.logbook[0]?.comment).toBe('Updated');
    });
    expect(reads).toBe(2);
    view.unmount();
    queryClient.clear();
  });

  it.each(['edit', 'delete'] as const)('leaves logbook rows untouched when %s fails', async (kind) => {
    const executeHttp = vi.fn(async () => {
      throw new Error('Rejected');
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const seeded = seedLogbooks(queryClient);
    const originalRows = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'));
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const view = renderHook(useTickMutations, { wrapper });

    await act(async () => {
      await expect(runMutation(kind, view.result.current)).rejects.toThrow('Rejected');
    });

    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBe(originalRows);
    expect(queryClient.getQueryData(fetchedLogbookClimbUuidsQueryKey('kilter'))).toBe(seeded.marker);
    expect(cancel).not.toHaveBeenCalled();
    view.unmount();
    queryClient.clear();
  });

  it('clears old personal stars immediately, then reads the actual synced fallback', async () => {
    let edited = false;
    let releaseFreshRead: (response: { ticks: LogbookSourceTick[] }) => void = () => {};
    const freshRead = new Promise<{ ticks: LogbookSourceTick[] }>((resolve) => {
      releaseFreshRead = resolve;
    });
    const executeHttp = vi.fn(async (document: string) => {
      if (document === UPDATE_TICK) {
        edited = true;
        return { updateTick: updatedTick(null) };
      }
      return edited ? freshRead : { ticks: [serverTick({ quality: 4, effectiveQuality: 4 })] };
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const view = renderHook(() => ({ history: useLogbook('kilter', DRAWER_CLIMBS), mutations: useTickMutations() }), {
      wrapper,
    });
    await waitFor(() => expect(view.result.current.history.logbook[0]?.effectiveQuality).toBe(4));

    await act(async () => {
      await view.result.current.mutations.edit.mutateAsync({ uuid: 'tick-1', input: { quality: null } });
    });

    await waitFor(() =>
      expect(view.result.current.history.logbook[0]).toMatchObject({ quality: null, effectiveQuality: null }),
    );
    await act(async () => {
      releaseFreshRead({ ticks: [serverTick({ quality: null, effectiveQuality: 3 })] });
      await freshRead;
    });
    await waitFor(() => expect(view.result.current.history.logbook[0]?.effectiveQuality).toBe(3));
    view.unmount();
    queryClient.clear();
  });

  it('does not promote an invalidated mixed batch over a newer single-climb fallback', async () => {
    let releaseFreshRead: (response: { ticks: LogbookSourceTick[] }) => void = () => {};
    const freshRead = new Promise<{ ticks: LogbookSourceTick[] }>((resolve) => {
      releaseFreshRead = resolve;
    });
    const executeHttp = vi.fn(async (document: string) =>
      document === DELETE_TICK ? { deleteTick: true } : freshRead,
    );
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const target = toLogbookEntry(serverTick());
    const olderOther = toLogbookEntry(
      serverTick({ uuid: 'tick-other', climbUuid: 'climb-2', quality: null, effectiveQuality: null }),
    );
    const newerOther = { ...olderOther, effectiveQuality: 3 };
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), [target, newerOther], { updatedAt: 200 });
    queryClient.setQueryData(fetchLogbookQueryKey('kilter', MIXED_CLIMBS), [target, olderOther], { updatedAt: 100 });
    queryClient.setQueryData(fetchLogbookQueryKey('kilter', OTHER_CLIMB), [newerOther], { updatedAt: 200 });
    const mutation = renderHook(useDeleteTick, { wrapper });
    await act(async () => {
      await mutation.result.current.mutateAsync('tick-1');
    });
    expect(queryClient.getQueryState(fetchLogbookQueryKey('kilter', MIXED_CLIMBS))?.dataUpdatedAt).toBe(100);
    const history = renderHook(() => useLogbook('kilter', MIXED_CLIMBS), { wrapper });
    await waitFor(() => expect(history.result.current.fetchedUuids.has('climb-2')).toBe(true));

    expect(history.result.current.logbook).toEqual([newerOther]);
    expect(queryClient.getQueryData(fetchLogbookQueryKey('kilter', OTHER_CLIMB))).toEqual([newerOther]);
    expect(queryClient.getQueryState(fetchLogbookQueryKey('kilter', OTHER_CLIMB))?.dataUpdatedAt).toBe(200);
    await act(async () => {
      releaseFreshRead({
        ticks: [serverTick({ uuid: 'tick-other', climbUuid: 'climb-2', quality: null, effectiveQuality: 3 })],
      });
      await freshRead;
    });
    history.unmount();
    mutation.unmount();
    queryClient.clear();
  });
});
