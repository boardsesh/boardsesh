// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVE_RESOURCE_ACCESS,
  CANCEL_RESOURCE_ACCESS_REQUEST,
  DECLINE_RESOURCE_ACCESS,
  REQUEST_RESOURCE_ACCESS,
} from '@boardsesh/graphql/operations/privacy';

const requestMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../index', () => ({ useProfile: () => ({ data: { id: 'viewer' } }) }));
vi.mock('../use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../../../privacy/privacy-cache', () => ({ refreshAfterOwnPrivacyChange: refreshMock }));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
}));

import { useResourceAccessAction } from '../use-resource-privacy';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useResourceAccessAction(), { wrapper });
  return { result, invalidate };
}

describe('useResourceAccessAction', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({});
    refreshMock.mockReset();
    // The app-wide refresh never settles: an ask must not wait on it.
    refreshMock.mockReturnValue(new Promise<void>(() => {}));
  });

  it.each([
    { action: 'request' as const, document: REQUEST_RESOURCE_ACCESS },
    { action: 'cancel' as const, document: CANCEL_RESOURCE_ACCESS_REQUEST },
  ])('$action settles on the write and refreshes only what the asker sees', async ({ action, document }) => {
    const { result, invalidate } = setup();
    await act(async () => {
      await result.current.mutateAsync({ action, kind: 'board', resourceId: 'board-1' });
    });

    expect(requestMock).toHaveBeenCalledWith(document, { kind: 'board', resourceId: 'board-1' });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['friendsBoards'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resourceGrantStatuses'] });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { action: 'approve' as const, document: APPROVE_RESOURCE_ACCESS },
    // Declining sends the decline mutation, never the revoke ban.
    { action: 'decline' as const, document: DECLINE_RESOURCE_ACCESS },
  ])("keeps the owner's refresh-everything after $action", async ({ action, document }) => {
    refreshMock.mockResolvedValue(undefined);
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync({ action, kind: 'board', resourceId: 'board-1', userId: 'kim' });
    });

    expect(requestMock).toHaveBeenCalledWith(document, {
      kind: 'board',
      resourceId: 'board-1',
      userId: 'kim',
    });
    expect(requestMock).toHaveBeenCalledOnce();
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
