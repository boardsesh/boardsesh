// @vitest-environment jsdom
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  queryClient: {},
  router: { refresh: vi.fn() },
  subscribe: vi.fn((_operation: unknown, _callbacks: unknown) => vi.fn()),
  revoke: vi.fn(async () => {}),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
  useQuery: () => ({ data: { enabled: false } }),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'authenticated', data: { user: { id: 'viewer' } } }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'accepted-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: vi.fn() }));
vi.mock('@/app/lib/backend-url', () => ({ getBackendWsUrl: () => 'ws://localhost/graphql' }));
vi.mock('@/app/lib/privacy-client', () => ({ revokeWebPrivacySnapshots: mocks.revoke }));
vi.mock('@/app/lib/realtime/graphql-client', () => ({
  createGraphQLClient: () => ({ subscribe: mocks.subscribe, dispose: vi.fn() }),
}));
import { PrivacySyncBridge } from '../privacy-sync-bridge';

describe('website privacy revocation', () => {
  it('keeps enforcing revocation while controls are disabled', async () => {
    const persister = { persistClient: vi.fn(), restoreClient: vi.fn(), removeClient: vi.fn() };
    render(<PrivacySyncBridge persister={persister} />);
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    const callbacks = mocks.subscribe.mock.calls[0][1] as { next: () => void };
    callbacks.next();
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(persister.removeClient).toHaveBeenCalledOnce();
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
  });
});
