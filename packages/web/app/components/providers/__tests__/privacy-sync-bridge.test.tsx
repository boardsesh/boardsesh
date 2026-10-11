// @vitest-environment jsdom
import React from 'react';
import { QueryClient } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

type Sink = { next: () => void; error: (error: unknown) => void; complete: () => void };
const mocks = vi.hoisted(() => ({
  queryClient: undefined as unknown as QueryClient,
  createClient: vi.fn(),
  sinks: [] as Sink[],
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => mocks.queryClient,
  useQuery: () => ({ data: { enabled: false } }),
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
  it('withdraws protected queries over the shared socket, without a page reload, while controls are disabled', async () => {
    mocks.queryClient = new QueryClient();
    for (const key of [...sensitiveKeys, ...transportKeys]) mocks.queryClient.setQueryData(key, { copied: true });
    const invalidate = vi.spyOn(mocks.queryClient, 'invalidateQueries');
    const persister = { persistClient: vi.fn(), restoreClient: vi.fn(), removeClient: vi.fn() };
    const view = render(<PrivacySyncBridge persister={persister} />);
    await waitFor(() => expect(mocks.sinks).toHaveLength(1));

    // A comment thread on the same page joins the bridge's socket.
    const thread = acquireRealtimeClient({ url: 'ws://localhost/graphql', authToken: 'accepted-token' });
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

    thread.release();
    view.unmount();
    mocks.queryClient.clear();
  });
});
