// @vitest-environment jsdom
//
// The ORDER of one Save, which is invisible everywhere else.
//
// `buildSprayHoldWritePlan` is tested against its plan and the reducer against
// `MARK_REMOVED`, but nothing pinned the wiring between them: the hook could
// stop calling `onRemoved` altogether and every one of those tests would stay
// green. That is the gap this file closes, and it is worth its own jsdom render
// because the property is temporal — `onRemoved` has to fire AFTER the remove
// call resolves and BEFORE the upsert is sent.
//
// Why it matters: removals go first so a merge's victim is off the wall before
// its survivor's geometry lands. If the upsert then fails on its own — the
// shared wall-mutation rate limit, a dropped connection — the removals have
// still landed, and a retry that named them again would be refused with "Hold N
// is not on this wall", failing the retry's whole batch for the rest of the
// session. `onRemoved` is what lets the caller drop those ids the moment they
// are spent.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { REMOVE_SPRAY_WALL_HOLDS, UPSERT_SPRAY_WALL_HOLDS } from '@boardsesh/graphql/operations/spray-walls';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { useSaveSprayHolds } from '../use-spray-hold-writes';
import type { SprayHoldWritePlan } from '../../../components/outline-editor/spray-hold-writes';

const PLAN: SprayHoldWritePlan = {
  upsert: [{ id: 7, cx: 10, cy: 20, r: 5, outline: null, source: 'MANUAL' }],
  writtenIds: [7],
  removeIds: [8, 9],
  unmappableIds: [],
  outlinesDropped: 0,
  overCap: false,
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * A wrapper whose `invalidateQueries` resolves only when `release()` is called,
 * so a test can prove what happens on either side of the refetch.
 */
function deferredInvalidationWrapper() {
  let release = () => {};
  const invalidated = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(invalidated);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, release: () => release(), invalidateSpy };
}

/** Which document each call carried, in the order the hook sent them. */
function sentDocuments(): string[] {
  return requestMock.mock.calls.map(([document]) => (document === REMOVE_SPRAY_WALL_HOLDS ? 'remove' : 'upsert'));
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useSaveSprayHolds', () => {
  it('fires onRemoved after the remove resolves and before the upsert is sent', async () => {
    // Recorded at the moment `onRemoved` runs: if the hook fired it after both
    // calls (or never), this snapshot would not be `['remove']`.
    let documentsWhenRemovedFired: string[] | null = null;
    const onRemoved = vi.fn(() => {
      documentsWhenRemovedFired = sentDocuments();
    });

    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.resolve({ removeSprayWallHolds: 2 });
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 7 }] });
    });

    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    let saved: { written: number; removed: number } | null = null;
    await act(async () => {
      saved = await result.current.mutateAsync({
        wallUuid: 'wall-1',
        versionNumber: 3,
        versionId: '77',
        plan: PLAN,
        onRemoved,
      });
    });

    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith(PLAN.removeIds);
    expect(documentsWhenRemovedFired).toEqual(['remove']);
    expect(sentDocuments()).toEqual(['remove', 'upsert']);
    expect(saved).toEqual({ written: 1, removed: 2 });
  });

  it('leaves onRemoved fired when the upsert then fails', async () => {
    // The whole point. The removals landed; the retry must not name them again.
    const onRemoved = vi.fn();
    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.resolve({ removeSprayWallHolds: 2 });
      return Promise.reject(new Error('rate limited'));
    });

    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          wallUuid: 'wall-1',
          versionNumber: 3,
          versionId: '77',
          plan: PLAN,
          onRemoved,
        }),
      ).rejects.toThrow('rate limited');
    });

    expect(onRemoved).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('does not fire onRemoved when there is nothing to remove', async () => {
    const onRemoved = vi.fn();
    requestMock.mockResolvedValue({ upsertSprayWallHolds: [{ id: 7 }] });

    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        wallUuid: 'wall-1',
        versionNumber: 3,
        versionId: '77',
        plan: { ...PLAN, removeIds: [] },
        onRemoved,
      });
    });

    expect(onRemoved).not.toHaveBeenCalled();
    expect(sentDocuments()).toEqual(['upsert']);
  });

  it('never sends an upsert the remove call did not survive', async () => {
    // Removals first also means a failed REMOVE stops the save outright: the
    // survivor's geometry must not land while the hold it swallowed is still on
    // the wall.
    const onRemoved = vi.fn();
    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.reject(new Error('nope'));
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 7 }] });
    });

    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          wallUuid: 'wall-1',
          versionNumber: 3,
          versionId: '77',
          plan: PLAN,
          onRemoved,
        }),
      ).rejects.toThrow('nope');
    });

    expect(onRemoved).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe(REMOVE_SPRAY_WALL_HOLDS);
  });

  it("awaits the draft refetch before the caller's onSuccess runs", async () => {
    // The ordering the hook's own comment calls load-bearing: `invalidateQueries`
    // is RETURNED so React Query awaits it. Dropping the `return` would leave
    // every other test green while re-introducing the race where the editor
    // re-seeds from the payload that predates its own save.
    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.resolve({ removeSprayWallHolds: 2 });
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 7 }] });
    });

    const { Wrapper, release, invalidateSpy } = deferredInvalidationWrapper();
    const callerOnSuccess = vi.fn();
    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate(
        { wallUuid: 'wall-1', versionNumber: 3, versionId: '77', plan: PLAN },
        { onSuccess: callerOnSuccess },
      );

      // Both requests are done and the invalidation has been asked for...
      await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));
      // ...but the caller has not been told yet, because the refetch has not landed.
      expect(callerOnSuccess).not.toHaveBeenCalled();

      release();
    });

    await waitFor(() => expect(callerOnSuccess).toHaveBeenCalledTimes(1));
  });

  it('sends each half exactly what the plan carried', async () => {
    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.resolve({ removeSprayWallHolds: 2 });
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 7 }] });
    });

    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ wallUuid: 'wall-1', versionNumber: 3, versionId: '77', plan: PLAN });
    });

    expect(requestMock).toHaveBeenNthCalledWith(1, REMOVE_SPRAY_WALL_HOLDS, {
      input: { wallUuid: 'wall-1', versionId: '77', holdIds: [8, 9] },
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, UPSERT_SPRAY_WALL_HOLDS, {
      input: { wallUuid: 'wall-1', versionId: '77', holds: PLAN.upsert },
    });
  });
});
