import React, { useEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { PRIVACY_REVOKED_EVENT } from '@/app/lib/privacy-client';

const mocks = vi.hoisted(() => ({
  removeClient: vi.fn().mockResolvedValue(undefined),
  removePreference: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/app/lib/react-query-idb-persister', () => ({
  createIdbPersister: () => ({ removeClient: mocks.removeClient }),
}));
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference: mocks.removePreference }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(cleanup);

it('notifies copied-data consumers once even before any query island initializes', async () => {
  const { clearMarketingViewerState } = await import('../marketing-viewer-cleanup');
  const revoked = vi.fn();
  window.addEventListener(PRIVACY_REVOKED_EVENT, revoked);
  await clearMarketingViewerState();
  expect(revoked).toHaveBeenCalledOnce();
  expect(mocks.removeClient).toHaveBeenCalledOnce();
  expect(mocks.removePreference).toHaveBeenCalledOnce();
  window.removeEventListener(PRIVACY_REVOKED_EVENT, revoked);
});

it('purges the initialized singleton after all query islands unmount', async () => {
  const { default: MarketingQueryProvider } = await import('../marketing-query-provider');
  const { clearMarketingViewerState } = await import('../marketing-viewer-cleanup');
  const clients: QueryClient[] = [];
  function Probe() {
    const queryClient = useQueryClient();
    useEffect(() => {
      clients.push(queryClient);
      queryClient.setQueryData(['private-profile'], { name: 'Climber A' });
    }, [queryClient]);
    return null;
  }
  const view = render(
    <>
      <MarketingQueryProvider>
        <Probe />
      </MarketingQueryProvider>
      <MarketingQueryProvider>
        <Probe />
      </MarketingQueryProvider>
    </>,
  );
  expect(clients).toHaveLength(2);
  expect(clients[0]).toBe(clients[1]);
  view.unmount();
  const revoked = vi.fn();
  window.addEventListener(PRIVACY_REVOKED_EVENT, revoked);
  await clearMarketingViewerState();
  expect(clients[0].getQueryData(['private-profile'])).toBeUndefined();
  expect(revoked).toHaveBeenCalledOnce();
  window.removeEventListener(PRIVACY_REVOKED_EVENT, revoked);
});
