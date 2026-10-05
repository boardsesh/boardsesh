// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
const clearPrivateCaches = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../spray-privacy-cleanup', () => ({ clearSprayWallPrivateCaches: clearPrivateCaches }));
import { useDiscardSprayWallDraft, usePublishSprayWallVersion } from '../use-create-spray-wall';

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
