// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Climb } from '@boardsesh/shared-schema';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectClimbPlays } from '../../../climb-play-count';
import { getCredentialGeneration, invalidateCredentialSnapshots } from '../../../privacy/privacy-cache';
import type { GetClimbQueryResponse, GetClimbQueryVariables } from '../../operations';
import { useClimb, useSelectedClimbPlays } from '../use-climb';

const test = vi.hoisted(() => ({
  wallUuid: undefined as string | undefined,
  request: vi.fn<(document: string, variables: GetClimbQueryVariables) => Promise<GetClimbQueryResponse>>(),
}));
vi.mock('../../offline-request', () => ({ offlineAwareRequest: test.request }));
vi.mock('../../../spray/spray-wall-registry', () => ({
  getSprayWall: () => (test.wallUuid ? { wallUuid: test.wallUuid } : null),
}));

const climbInput = { boardName: 'spray', layoutId: 42, sizeId: 13, setIds: '1', angle: 40, climbUuid: 'a' };

function resultClimb(variables: GetClimbQueryVariables, playCount: number): Climb {
  return {
    uuid: variables.climbUuid,
    boardType: variables.boardName,
    layoutId: variables.layoutId,
    angle: variables.angle,
    play_count: playCount,
  } as Climb;
}

function wrap(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('the selected climb Plays query', () => {
  beforeEach(() => {
    test.wallUuid = undefined;
    test.request.mockReset();
  });

  it('uses the signed-out capable detail key and survives a narrower batch omission until wall access is denied', async () => {
    test.wallUuid = 'allowed-wall';
    test.request.mockResolvedValueOnce({ climb: resultClimb(climbInput, 28) }).mockResolvedValueOnce({ climb: null });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const wrapper = wrap(client);

    // The anonymous route and drawer share the exact detail cache. No signed-in
    // canonical adapter is needed to read the result. A separate broad batch
    // can represent denial with null without that grant being revoked.
    const { result } = renderHook(
      () => {
        const publicDetail = useClimb(climbInput).data;
        const { catalogPlays } = useSelectedClimbPlays(climbInput, true);
        return { publicDetail, count: selectClimbPlays(null, catalogPlays, getCredentialGeneration()) };
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.count).toBe(28));
    expect(result.current.publicDetail?.play_count).toBe(28);
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls[0]?.[1]).toMatchObject({ sprayWallUuid: 'allowed-wall' });

    await act(() => client.invalidateQueries({ queryKey: ['climb'] }));
    expect(test.request).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current).toEqual({ publicDetail: null, count: null }));
  });

  it('drops the previous angle, climb and credentials while delayed exact detail requests settle', async () => {
    const initial = { ...climbInput, boardName: 'kilter', layoutId: 1 };
    const pending = new Map<string, (response: GetClimbQueryResponse) => void>();
    test.request.mockImplementation(
      (_, variables) =>
        new Promise((resolve) => {
          pending.set(`${variables.climbUuid}:${variables.angle}`, resolve);
        }),
    );
    const wrapper = wrap(new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } }));
    const { result, rerender } = renderHook(
      (variables: GetClimbQueryVariables) => useSelectedClimbPlays(variables, true).catalogPlays?.playCount,
      { wrapper, initialProps: initial },
    );

    await waitFor(() => expect(pending.has('a:40')).toBe(true));
    await act(async () => pending.get('a:40')?.({ climb: resultClimb(initial, 20) }));
    await waitFor(() => expect(result.current).toBe(20));
    rerender({ ...initial, angle: 30 });
    expect(result.current).toBeNull();
    await waitFor(() => expect(pending.has('a:30')).toBe(true));

    const selected = { ...initial, angle: 30, climbUuid: 'b' };
    rerender(selected);
    expect(result.current).toBeNull();
    await act(async () => pending.get('a:30')?.({ climb: resultClimb({ ...initial, angle: 30 }, 15) }));
    expect(result.current).toBeNull();
    await waitFor(() => expect(pending.has('b:30')).toBe(true));
    await act(async () => pending.get('b:30')?.({ climb: resultClimb(selected, 0) }));
    await waitFor(() => expect(result.current).toBe(0));

    act(() => invalidateCredentialSnapshots());
    expect(result.current).toBeNull();
    await waitFor(() => expect(test.request).toHaveBeenCalledTimes(4));
  });
});
