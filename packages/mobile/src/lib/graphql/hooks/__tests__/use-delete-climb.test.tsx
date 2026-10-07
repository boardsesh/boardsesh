// @vitest-environment jsdom
//
// What `useDeleteClimb` owes its callers (#5960): it posts DELETE_CLIMB, takes
// the climb off the downloaded copy only once the server has said yes, and then
// refetches every climb list and the climb detail.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DELETE_CLIMB_MUTATION } from '@boardsesh/graphql/operations/new-climb-feed';

const ctrl = vi.hoisted(() => ({
  request: vi.fn(),
  removeFromDevice: vi.fn(async (_climb: unknown, _generation: number) => {}),
}));

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: ctrl.request }) }));
vi.mock('../../../auth-store', () => ({ captureAuthCredentialGeneration: () => 7 }));
vi.mock('../../../../offline/remove-deleted-climb', () => ({ removeDeletedClimbFromDevice: ctrl.removeFromDevice }));

import { useDeleteClimb } from '../use-delete-climb';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const variables = { uuid: 'climb-1', boardType: 'spray' };

beforeEach(() => {
  ctrl.request.mockReset();
  ctrl.removeFromDevice.mockClear();
});

describe('useDeleteClimb', () => {
  it('posts DELETE_CLIMB, then clears the downloaded copy with the auth generation from before the request', async () => {
    ctrl.request.mockResolvedValue({ deleteClimb: true });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteClimb(), { wrapper: Wrapper });

    result.current.mutate(variables);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(ctrl.request).toHaveBeenCalledWith(DELETE_CLIMB_MUTATION, variables);
    expect(ctrl.removeFromDevice).toHaveBeenCalledWith({ uuid: 'climb-1', boardType: 'spray' }, 7);
    expect(ctrl.request.mock.invocationCallOrder[0]).toBeLessThan(ctrl.removeFromDevice.mock.invocationCallOrder[0]);
  });

  it('settles without waiting for the local write, which can sit behind a pull', async () => {
    ctrl.request.mockResolvedValue({ deleteClimb: true });
    // A local write that never finishes: the mutation must still succeed.
    ctrl.removeFromDevice.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteClimb(), { wrapper: Wrapper });

    const settled = result.current.mutateAsync(variables);

    await expect(settled).resolves.toMatchObject({ deleted: true });
    expect(ctrl.removeFromDevice).toHaveBeenCalledTimes(1);
  });

  it('refetches every climb list and the climb detail once the delete lands', async () => {
    ctrl.request.mockResolvedValue({ deleteClimb: true });
    const { queryClient, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteClimb(), { wrapper: Wrapper });

    result.current.mutate(variables);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const queryKey of [['searchClimbs'], ['infiniteSearchClimbs'], ['climb']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  it('leaves the downloaded copy and the caches alone when the server refuses', async () => {
    ctrl.request.mockRejectedValue(Object.assign(new Error('refused'), { extensions: { code: 'CLIMB_HAS_TICKS' } }));
    const { queryClient, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteClimb(), { wrapper: Wrapper });

    result.current.mutate(variables);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(ctrl.removeFromDevice).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
