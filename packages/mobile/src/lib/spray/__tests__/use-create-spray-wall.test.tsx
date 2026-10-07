// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
const clearPrivateCaches = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../spray-privacy-cleanup', () => ({ clearSprayWallPrivateCaches: clearPrivateCaches }));
import {
  sprayWallWithVersionsQueryKey,
  useDiscardSprayWallDraft,
  useDiscardSprayWallVersion,
  usePublishSprayWallVersion,
  useResetSprayWall,
} from '../use-create-spray-wall';
import { RESET_SPRAY_WALL } from '@boardsesh/graphql/operations/spray-walls';

function queryWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

beforeEach(() => {
  request.mockReset();
  clearPrivateCaches.mockReset();
});

describe('spray wizard board roster refresh', () => {
  it('refreshes every picker page after the first publish', async () => {
    const client = new QueryClient();
    client.setQueryData(['myBoards', { offset: 0 }], { boards: [] });
    client.setQueryData(['myBoards', { offset: 20 }], { boards: [] });
    request.mockResolvedValue({ publishSprayWallVersion: { id: '17' } });
    const hook = renderHook(usePublishSprayWallVersion, { wrapper: queryWrapper(client) });
    await act(() => hook.result.current.mutateAsync('17'));
    expect(client.getQueryState(['myBoards', { offset: 0 }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['myBoards', { offset: 20 }])?.isInvalidated).toBe(true);
  });

  it('refreshes the picker after Start over deletes initial setup', async () => {
    const client = new QueryClient();
    client.setQueryData(['myBoards', undefined], { boards: [{ uuid: 'wall' }] });
    client.setQueryData(['myBoards', { offset: 20 }], { boards: [{ uuid: 'wall' }] });
    request.mockResolvedValue({});
    const hook = renderHook(useDiscardSprayWallDraft, { wrapper: queryWrapper(client) });
    await act(() => hook.result.current.mutateAsync({ wallUuid: 'wall', versionId: '17', layoutId: 4242 }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(clearPrivateCaches).toHaveBeenCalledWith(4242);
    expect(client.getQueryState(['myBoards', undefined])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['myBoards', { offset: 20 }])?.isInvalidated).toBe(true);
  });

  it('preserves wall caches when Start over cannot delete the wall', async () => {
    request.mockRejectedValue(new Error('synthetic delete failure'));
    const hook = renderHook(useDiscardSprayWallDraft, { wrapper: queryWrapper(new QueryClient()) });
    await act(async () => {
      await expect(
        hook.result.current.mutateAsync({ wallUuid: 'wall', versionId: null, layoutId: 4242 }),
      ).rejects.toThrow('synthetic delete failure');
    });
    expect(clearPrivateCaches).not.toHaveBeenCalled();
  });
});

describe('useResetSprayWall', () => {
  it('asks for the clone of the wall it names and refreshes the owner wall list', async () => {
    const client = new QueryClient();
    client.setQueryData(['mySprayWalls'], []);
    const clone = { uuid: 'clone-1', layoutId: 8, board: { uuid: 'clone-1' } };
    request.mockResolvedValue({ resetSprayWall: clone });
    const hook = renderHook(useResetSprayWall, { wrapper: queryWrapper(client) });
    let returned: unknown;
    await act(async () => {
      returned = await hook.result.current.mutateAsync('old-wall');
    });
    expect(returned).toEqual(clone);
    expect(request).toHaveBeenCalledExactlyOnceWith(RESET_SPRAY_WALL, { input: { wallUuid: 'old-wall' } });
    expect(client.getQueryState(['mySprayWalls'])?.isInvalidated).toBe(true);
  });

  it('surfaces a refusal to the caller', async () => {
    request.mockRejectedValue(new Error('SPRAY_WALL_RESET_OWNER_ONLY'));
    const hook = renderHook(useResetSprayWall, { wrapper: queryWrapper(new QueryClient()) });
    await act(async () => {
      await expect(hook.result.current.mutateAsync('old-wall')).rejects.toThrow('SPRAY_WALL_RESET_OWNER_ONLY');
    });
  });
});

describe('useDiscardSprayWallVersion', () => {
  // Keeps the wall: only the draft goes, so exactly one request is sent.
  it('takes the discarded draft out of the cached history at once, even while the refetch hangs', async () => {
    request.mockResolvedValue({ discardSprayWallVersion: true });
    const client = new QueryClient();
    const versionsKey = sprayWallWithVersionsQueryKey('wall-1');
    client.setQueryData(versionsKey, {
      uuid: 'wall-1',
      versions: [
        { id: 'published-1', status: 'PUBLISHED' },
        { id: 'draft-2', status: 'DRAFT' },
      ],
    });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => new Promise(() => {}));
    const hook = renderHook(() => useDiscardSprayWallVersion('wall-1'), { wrapper: queryWrapper(client) });
    await act(async () => {
      await expect(hook.result.current.mutateAsync('draft-2')).resolves.toBe(true);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(versionsKey)).toEqual({
      uuid: 'wall-1',
      versions: [{ id: 'published-1', status: 'PUBLISHED' }],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: versionsKey });
  });
});
