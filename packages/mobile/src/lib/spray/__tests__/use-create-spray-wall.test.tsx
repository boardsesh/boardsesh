// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
import { useDiscardSprayWallDraft, usePublishSprayWallVersion } from '../use-create-spray-wall';

function queryWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

beforeEach(() => request.mockReset());

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
    request.mockResolvedValue({});
    const hook = renderHook(useDiscardSprayWallDraft, { wrapper: queryWrapper(client) });
    await act(() => hook.result.current.mutateAsync({ wallUuid: 'wall', versionId: '17' }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(['myBoards', undefined])?.isInvalidated).toBe(true);
  });
});
