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
import { extractGraphqlMessage } from '../../graphql/extract-error-message';
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
  return requestMock.mock.calls.map(([document]) => {
    if (document === REMOVE_SPRAY_WALL_HOLDS) return 'remove';
    if (document === UPSERT_SPRAY_WALL_HOLDS) return 'upsert';
    throw new Error('Unexpected GraphQL document');
  });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useSaveSprayHolds', () => {
  it('awaits the durable removal checkpoint before sending upserts', async () => {
    let finishCheckpoint: (() => void) | undefined;
    const onRemoved = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCheckpoint = resolve;
        }),
    );
    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.resolve({ removeSprayWallHolds: 2 });
      return Promise.reject(new Error('upsert failed'));
    });
    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    let saving: Promise<unknown> | undefined;
    act(() => {
      saving = result.current.mutateAsync({
        wallUuid: 'wall-1',
        versionNumber: 3,
        versionId: '77',
        plan: PLAN,
        onRemoved,
      });
    });
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(sentDocuments()).toEqual(['remove']);
    await act(async () => {
      finishCheckpoint?.();
      await expect(saving).rejects.toThrow('upsert failed');
    });
    expect(sentDocuments()).toEqual(['remove', 'upsert']);
  });

  it('fires onRemoved after the remove resolves and before the upsert is sent', async () => {
    // Recorded at the moment `onRemoved` runs: if the hook fired it after both
    // calls (or never), this snapshot would not end at the removal.
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
    requestMock.mockImplementation((document: unknown) => {
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 7 }] });
    });

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
    expect(sentDocuments()).toEqual(['remove']);
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
      input: { wallUuid: 'wall-1', versionId: '77', holdIds: [8, 9], preserveClimbLinks: true },
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, UPSERT_SPRAY_WALL_HOLDS, {
      input: { wallUuid: 'wall-1', versionId: '77', holds: PLAN.upsert, preserveClimbLinks: true },
    });
  });

  it.each(
    [undefined, 'BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED'].flatMap((code) => [
      { scenario: 'refinement only', plan: { ...PLAN, removeIds: [] }, document: UPSERT_SPRAY_WALL_HOLDS, code },
      { scenario: 'removal and refinement together', plan: PLAN, document: REMOVE_SPRAY_WALL_HOLDS, code },
    ]),
  )('rejects marked $scenario on an older backend ($code) before any writes land', async ({ plan, document, code }) => {
    const message =
      'Variable "$input" got invalid value { preserveClimbLinks: true }; Field "preserveClimbLinks" is not defined by type "UpsertSprayWallHoldsInput".';
    const unsupported = Object.assign(new Error(message), {
      response: { errors: [{ message, ...(code ? { extensions: { code } } : {}) }] },
    });
    requestMock.mockRejectedValueOnce(unsupported);
    const onRemoved = vi.fn();
    const { Wrapper, invalidateSpy } = deferredInvalidationWrapper();
    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper: Wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          wallUuid: 'wall-1',
          versionNumber: 3,
          versionId: '77',
          plan,
          onRemoved,
        }),
      ).rejects.toMatchObject({ cause: unsupported });
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe(document);
    expect(requestMock.mock.calls[0][1]).toMatchObject({ input: { preserveClimbLinks: true } });
    expect(onRemoved).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(extractGraphqlMessage(result.current.error)).toBeNull();
  });

  it('omits the compatibility marker when the save only adds new holds', async () => {
    requestMock.mockImplementation((document: unknown) => {
      if (document !== UPSERT_SPRAY_WALL_HOLDS) return Promise.reject(new Error('Unexpected GraphQL request'));
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 90 }] });
    });
    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          wallUuid: 'wall-1',
          versionNumber: 3,
          versionId: '77',
          plan: {
            ...PLAN,
            upsert: [{ cx: 10, cy: 20, r: 5, outline: null, source: 'MANUAL' }],
            writtenIds: [-1],
            removeIds: [],
          },
        }),
      ).resolves.toEqual({ written: 1, removed: 0 });
    });
    expect(sentDocuments()).toEqual(['upsert']);
    expect(requestMock.mock.calls[0][1].input).not.toHaveProperty('preserveClimbLinks');
  });

  it('omits the compatibility marker when the save only removes holds', async () => {
    requestMock.mockImplementation((document: unknown) => {
      if (document !== REMOVE_SPRAY_WALL_HOLDS) return Promise.reject(new Error('Unexpected GraphQL request'));
      return Promise.resolve({ removeSprayWallHolds: 2 });
    });
    const onRemoved = vi.fn();
    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          wallUuid: 'wall-1',
          versionNumber: 3,
          versionId: '77',
          plan: { ...PLAN, upsert: [], writtenIds: [] },
          onRemoved,
        }),
      ).resolves.toEqual({ written: 0, removed: 2 });
    });
    expect(sentDocuments()).toEqual(['remove']);
    expect(requestMock.mock.calls[0][1].input).not.toHaveProperty('preserveClimbLinks');
    expect(onRemoved).toHaveBeenCalledExactlyOnceWith(PLAN.removeIds);
  });

  it('keeps the removal checkpoint if a rollback rejects the marked upsert', async () => {
    const message = 'Field "preserveClimbLinks" is not defined by type "UpsertSprayWallHoldsInput".';
    const unsupported = { response: { errors: [{ message, extensions: { code: 'BAD_USER_INPUT' } }] } };
    requestMock.mockImplementation((document: unknown) => {
      if (document === REMOVE_SPRAY_WALL_HOLDS) return Promise.resolve({ removeSprayWallHolds: 2 });
      return Promise.reject(unsupported);
    });
    const onRemoved = vi.fn();
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
      ).rejects.toMatchObject({ cause: unsupported });
    });
    expect(sentDocuments()).toEqual(['remove', 'upsert']);
    expect(onRemoved).toHaveBeenCalledExactlyOnceWith(PLAN.removeIds);
    for (const [, variables] of requestMock.mock.calls) {
      expect(variables.input.preserveClimbLinks).toBe(true);
    }
  });

  it('marks every save without relying on a cached capability check', async () => {
    requestMock.mockImplementation((document: unknown) => {
      return Promise.resolve({ upsertSprayWallHolds: [{ id: 7 }] });
    });
    const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
    const variables = { wallUuid: 'wall-1', versionNumber: 3, versionId: '77', plan: { ...PLAN, removeIds: [] } };
    await act(async () => {
      await result.current.mutateAsync(variables);
    });
    requestMock.mockRejectedValueOnce(new Error('backend rolled back'));
    await act(async () => {
      await expect(result.current.mutateAsync(variables)).rejects.toThrow('backend rolled back');
    });
    expect(sentDocuments()).toEqual(['upsert', 'upsert']);
    for (const [, variables] of requestMock.mock.calls) {
      expect(variables.input.preserveClimbLinks).toBe(true);
    }
  });

  it.each(['SPRAY_WALL_ARCHIVED', 'RATE_LIMITED', 'BAD_USER_INPUT'])(
    'preserves structured %s write refusals for the editor',
    async (code) => {
      const refusal = Object.assign(new Error('Server guidance'), {
        response: { errors: [{ message: 'Server guidance', extensions: { code } }] },
      });
      requestMock.mockRejectedValueOnce(refusal);
      const { result } = renderHook(() => useSaveSprayHolds(), { wrapper });
      await act(async () => {
        await expect(
          result.current.mutateAsync({
            wallUuid: 'wall-1',
            versionNumber: 3,
            versionId: '77',
            plan: PLAN,
          }),
        ).rejects.toBe(refusal);
      });
      expect(sentDocuments()).toEqual(['remove']);
    },
  );
});
