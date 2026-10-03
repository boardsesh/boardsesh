/**
 * The comment subscription is the one socket a signed-out visitor used to open
 * on a board front door. W-17's DoD ("no WebSocket opens on any board route")
 * rests on this gate, and nothing else in the tree fails if it regresses — the
 * page still renders, it just starts dialling the backend again for every
 * crawler. Hence a test that watches the client factory, not the UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import CommentSection from '../comment-section';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

let mockAuthState = { token: 'test-token', isLoading: false, isAuthenticated: true, error: null };
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockAuthState,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: vi.fn() }),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendWsUrl: () => 'wss://ws.example.test/graphql',
}));

const mockCreateGraphQLClient = vi.fn(() => ({ dispose: vi.fn() }));
let subscriptionNext: ((payload: { commentUpdates?: unknown }) => void) | null = null;
const mockSubscribe = vi.fn(
  (_client: unknown, _operation: unknown, observer: { next: (payload: { commentUpdates?: unknown }) => void }) => {
    subscriptionNext = observer.next;
    return vi.fn();
  },
);
vi.mock('@/app/lib/realtime/graphql-client', () => ({
  createGraphQLClient: (...args: unknown[]) => mockCreateGraphQLClient(...(args as [])),
  subscribe: (...args: unknown[]) =>
    mockSubscribe(args[0], args[1], args[2] as { next: (payload: { commentUpdates?: unknown }) => void }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  ADD_COMMENT: 'ADD_COMMENT',
  COMMENT_UPDATES_SUBSCRIPTION: 'COMMENT_UPDATES_SUBSCRIPTION',
}));

vi.mock('../comment-form', () => ({
  default: () => <div data-testid="comment-form" />,
}));

vi.mock('../comment-list', () => ({
  default: () => <div data-testid="comment-list" />,
}));

describe('CommentSection live updates', () => {
  beforeEach(() => {
    mockCreateGraphQLClient.mockClear();
    mockSubscribe.mockClear();
    subscriptionNext = null;
    mockAuthState = { token: 'test-token', isLoading: false, isAuthenticated: true, error: null };
  });

  it('opens no WebSocket for an anonymous reader', async () => {
    mockAuthState = { token: null as unknown as string, isLoading: false, isAuthenticated: false, error: null };

    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <CommentSection entityType="climb" entityId="climb-1" />
      </QueryClientProvider>,
    );

    // The thread itself still renders — anonymous readers (and crawlers) keep
    // the HTTP-fetched comment list.
    expect(screen.getByTestId('comment-list')).toBeTruthy();
    await waitFor(() => {
      expect(mockCreateGraphQLClient).not.toHaveBeenCalled();
    });
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('opens exactly one WebSocket for a signed-in reader', async () => {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <CommentSection entityType="climb" entityId="climb-1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(mockCreateGraphQLClient).toHaveBeenCalledTimes(1);
    });
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('refetches the active detail counts after a comment event', async () => {
    const queryClient = createTestQueryClient();
    let count = 0;
    function SessionDetailCountProbe() {
      const { data } = useQuery({
        queryKey: ['sessionDetail', 'daily:user-1:2026-10-03', 'tick-a'],
        queryFn: async () => ++count,
      });
      return <div data-testid="session-detail-count">{data}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <SessionDetailCountProbe />
        <CommentSection entityType="tick" entityId="tick-a" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('session-detail-count').textContent).toBe('1'));
    await waitFor(() => expect(subscriptionNext).not.toBeNull());
    subscriptionNext?.({ commentUpdates: { entityType: 'tick', entityId: 'tick-a' } });
    await waitFor(() => expect(screen.getByTestId('session-detail-count').textContent).toBe('2'));
  });
});
