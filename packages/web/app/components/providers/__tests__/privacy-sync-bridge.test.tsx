// @vitest-environment jsdom
import React from 'react';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Sink = { next: () => void; error: (error: unknown) => void; complete: () => void };
const mocks = vi.hoisted(() => ({
  queryClient: undefined as unknown as QueryClient,
  createClient: vi.fn(),
  sinks: [] as Sink[],
  router: { refresh: vi.fn() },
  pathname: '/settings',
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => mocks.queryClient,
  useQuery: () => ({ data: { enabled: false } }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  usePathname: () => mocks.pathname,
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'authenticated', data: { user: { id: 'viewer' } } }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'accepted-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: vi.fn() }));
vi.mock('@/app/lib/backend-url', () => ({ getBackendWsUrl: () => 'ws://localhost/graphql' }));
// Count real socket clients underneath the web wrapper.
vi.mock('@boardsesh/graphql-client', () => ({
  createGraphQLClient: (...args: unknown[]) => {
    mocks.createClient(...args);
    return {
      subscribe: (_operation: unknown, sink: Sink) => {
        mocks.sinks.push(sink);
        return () => {};
      },
      dispose: vi.fn(async () => {}),
    };
  },
  execute: vi.fn(),
  subscribe: vi.fn(),
  getOperationName: vi.fn(),
  GraphQLOperationError: class extends Error {},
  isClimbDuplicateExtension: vi.fn(),
}));
vi.mock('@/app/lib/realtime/websocket-connection-manager', () => ({
  connectionManager: { registerClient: vi.fn(() => () => {}) },
}));
import { PrivacySyncBridge } from '../privacy-sync-bridge';
import { acquireRealtimeClient } from '@/app/lib/realtime/graphql-client';
import { rendersProtectedContentOnServer } from '@/app/lib/privacy-client';

const sensitiveKeys = [
  ['userProfile', 'private-user'],
  ['sessionDetail', 'session'],
  ['followingAscentsFeed', 'viewer'],
  ['gymMembers', 'gym'],
];
const transportKeys = [
  ['wsAuthToken', 'authenticated', 'viewer', null],
  ['sitePrivacySettings', 'viewer'],
];

describe('website privacy revocation', () => {
  // Unmounting the bridge and releasing every extra holder returns the shared
  // socket to nobody, even when a test throws before its own cleanup.
  const holders: Array<{ release: () => void }> = [];
  afterEach(() => {
    cleanup();
    for (const holder of holders.splice(0)) holder.release();
  });
  beforeEach(() => {
    mocks.createClient.mockClear();
    mocks.router.refresh.mockClear();
    mocks.sinks.length = 0;
    mocks.pathname = '/settings';
  });

  it('withdraws protected queries over the shared socket, without a page reload, while controls are disabled', async () => {
    mocks.queryClient = new QueryClient();
    for (const key of [...sensitiveKeys, ...transportKeys]) mocks.queryClient.setQueryData(key, { copied: true });
    const invalidate = vi.spyOn(mocks.queryClient, 'invalidateQueries');
    const persister = { persistClient: vi.fn(), restoreClient: vi.fn(), removeClient: vi.fn() };
    const view = render(<PrivacySyncBridge persister={persister} />);
    await waitFor(() => expect(mocks.sinks).toHaveLength(1));

    // A comment thread on the same page joins the bridge's socket.
    const thread = acquireRealtimeClient({ url: 'ws://localhost/graphql', authToken: 'accepted-token' });
    holders.push(thread);
    expect(mocks.createClient).toHaveBeenCalledOnce();

    mocks.sinks[0].next();
    await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
    const predicate = invalidate.mock.calls[0]?.[0]?.predicate;
    const invalidates = (queryKey: unknown[]) => {
      const query = mocks.queryClient.getQueryCache().find({ queryKey, exact: true });
      return !!query && !!predicate?.(query);
    };
    for (const queryKey of sensitiveKeys) {
      expect(invalidates(queryKey), JSON.stringify(queryKey)).toBe(true);
      expect(mocks.queryClient.getQueryData(queryKey)).toBeUndefined();
    }
    for (const queryKey of transportKeys) {
      expect(invalidates(queryKey), JSON.stringify(queryKey)).toBe(false);
      expect(mocks.queryClient.getQueryData(queryKey)).toEqual({ copied: true });
    }
    expect(persister.removeClient).toHaveBeenCalledOnce();
    // A settings page renders nothing protected on the server.
    expect(mocks.router.refresh).not.toHaveBeenCalled();

    thread.release();
    view.unmount();
    mocks.queryClient.clear();
  });

  it('re-renders a page whose server markup carries protected content', async () => {
    mocks.queryClient = new QueryClient();
    mocks.pathname = '/es/b/home-wall/40/view/climb-uuid';
    const persister = { persistClient: vi.fn(), restoreClient: vi.fn(), removeClient: vi.fn() };
    const view = render(<PrivacySyncBridge persister={persister} />);
    await waitFor(() => expect(mocks.sinks).toHaveLength(1));
    mocks.sinks[0].next();
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
    view.unmount();
    mocks.queryClient.clear();
  });
});

describe('rendersProtectedContentOnServer', () => {
  it.each([
    '/b/home-wall',
    '/b/home-wall/40/view/climb-uuid',
    '/fr/session/abc',
    '/profile/user-1',
    '/de/playlists/p-1',
    '/playlists',
    '/setter/someone',
    '/gym/the-gym',
    '/kilter/1/10/1,20/40/view/climb-uuid',
    '/es/tension/9/1/1/40/list',
  ])('re-renders %s', (pathname) => {
    expect(rendersProtectedContentOnServer(pathname)).toBe(true);
  });

  it.each(['/', '/es', '/settings', '/gyms', '/help/getting-started', '/legal', '/kilter', '/about/team'])(
    'leaves %s alone',
    (pathname) => {
      expect(rendersProtectedContentOnServer(pathname)).toBe(false);
    },
  );
});
