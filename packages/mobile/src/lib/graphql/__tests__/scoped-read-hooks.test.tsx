// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  viewerId: 'offline-viewer' as string | undefined,
}));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing owned read fixture');
    return selected.scope;
  },
}));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: selected.viewerId, isLoading: false }),
}));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
import { createScopedHttpFixture } from './fixtures/scoped-http';
import { useFollowingClimbLogs } from '../hooks/use-following-climb-logs';
import { LOGGED_SETTERS_PAGE_LIMIT, useUserLoggedSetters } from '../hooks/use-user-logged-setters';
import { useRecentBetaLinks } from '../hooks/use-recent-beta-links';
import { useBetaLinkPreview } from '../hooks/use-beta-link-preview';
import { useBoardRecentClimb } from '../hooks/use-board-recent-climb';

const closeFixtures: (() => void)[] = [];
const targetUserId = 'public-other-climber';
const scope = { boardType: '', layoutIds: [] };
const link = 'https://www.instagram.com/p/OwnedClip/';
beforeEach(() => {
  selected.viewerId = 'offline-viewer';
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
  vi.unstubAllEnvs();
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
}
function useReadSet() {
  return {
    following: useFollowingClimbLogs('kilter', 'owned-climb'),
    setters: useUserLoggedSetters(targetUserId, scope, ''),
    recent: useRecentBetaLinks(2, null, null, true),
    preview: useBetaLinkPreview(link),
    board: useBoardRecentClimb(123),
  };
}
function requestBody(init: unknown) {
  return JSON.parse((init as RequestInit).body as string) as {
    query: string;
    variables?: { userId?: string; input?: { search?: string } };
  };
}
function payload(document: string, marker: string) {
  if (document.includes('followingClimbAscents'))
    return {
      followingClimbAscents: {
        items: [{ uuid: marker }],
        hasMore: false,
        summary: { climberCount: 1, senderCount: 1, byAngle: [] },
      },
    };
  if (document.includes('userLoggedSetters')) return { userLoggedSetters: [{ setterUsername: marker, tickCount: 1 }] };
  if (document.includes('recentBetaLinks'))
    return {
      recentBetaLinks: [
        {
          climbName: marker,
          boardType: 'kilter',
          layoutId: 1,
          betaLink: {
            climbUuid: 'owned-climb',
            link,
            foreignUsername: null,
            angle: 40,
            thumbnail: null,
            isListed: true,
            createdAt: '2026-10-18T00:00:00Z',
            tickUuid: null,
            boardId: null,
          },
        },
      ],
    };
  if (document.includes('betaLinkPreview'))
    return { betaLinkPreview: { link, thumbnail: null, username: marker, caption: marker } };
  if (document.includes('boardRecentClimbs'))
    return { boardRecentClimbs: [{ climbUuid: marker, sentAt: '2026-11-14T00:00:00Z', seq: 1 }] };
  throw new Error('Unexpected owned read document');
}
function heldResponse(responsePayload: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: responsePayload })));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function expectReadSet(current: ReturnType<typeof useReadSet>, marker: string) {
  expect(current.following.data?.items[0].uuid).toBe(marker);
  expect(current.setters.setters?.[0].setterUsername).toBe(marker);
  expect(current.recent.data?.[0].climbName).toBe(marker);
  expect(current.preview.data?.username).toBe(marker);
  expect(current.board?.climbUuid).toBe(marker);
}

describe('actual captured network-only read hooks', () => {
  it.each(['B', 'ABA'] as const)('keeps all five delayed readers out of a new %s view', async (change) => {
    const current = fixture();
    const original = selected.scope!;
    const held: ReturnType<typeof heldResponse>[] = [];
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = heldResponse(payload(requestBody(init).query, 'old-A'));
      held.push(body);
      return body.response;
    });
    const { result, rerender } = renderHook(useReadSet, current);
    await waitFor(() => expect(held).toHaveLength(5));
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init).query, 'fresh-owner') }),
    );
    rerender();
    await waitFor(() => expectReadSet(result.current, 'fresh-owner'));
    await act(async () => {
      held.forEach((body) => body.release());
    });
    expectReadSet(result.current, 'fresh-owner');
    const originalQueries = current.cache
      .getQueryCache()
      .getAll()
      .filter((query) => original.ownsKey(query.queryKey));
    expect(originalQueries.length).toBeGreaterThan(0);
    expect(originalQueries.every((query) => query.state.data === undefined)).toBe(true);
    const setterRequests = current.performFetch.mock.calls
      .map(([, init]) => requestBody(init))
      .filter((request) => request.query.includes('userLoggedSetters'));
    expect(setterRequests.every((request) => request.variables?.userId === targetUserId)).toBe(true);
  });

  it('keeps every required read inert while central admission is unavailable', async () => {
    const current = fixture();
    selected.scope = Object.freeze({ ...selected.scope!, isReady: () => false });
    const { result } = renderHook(useReadSet, current);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.following.fetchStatus).toBe('idle');
    expect(result.current.recent.fetchStatus).toBe('idle');
    expect(result.current.preview.fetchStatus).toBe('idle');
    expect(result.current.board).toBeNull();
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
  });

  it('allows confirmed-anonymous public reads and another climber target without adding a sign-in gate', async () => {
    const current = fixture();
    current.confirmAnonymous();
    selected.scope = current.scope();
    selected.viewerId = undefined;
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init).query, 'anonymous-public') }),
    );
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expect(result.current.recent.data?.[0].climbName).toBe('anonymous-public'));
    await waitFor(() => expect(result.current.preview.data?.username).toBe('anonymous-public'));
    await waitFor(() => expect(result.current.board?.climbUuid).toBe('anonymous-public'));
    await waitFor(() => expect(result.current.setters.setters?.[0].setterUsername).toBe('anonymous-public'));
    expect(result.current.following.isIdle).toBe(true);
    expect(current.performFetch).toHaveBeenCalledTimes(4);
    expect(current.issueLease).not.toHaveBeenCalled();
    for (const [, init] of current.performFetch.mock.calls)
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBeNull();
    expect(
      current.performFetch.mock.calls
        .map(([, init]) => requestBody(init))
        .find((request) => request.query.includes('userLoggedSetters'))?.variables?.userId,
    ).toBe(targetUserId);
  });

  it('refuses expired original bodies before any of the five read caches can publish', async () => {
    const current = fixture();
    const held: ReturnType<typeof heldResponse>[] = [];
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = heldResponse(payload(requestBody(init).query, 'expired-A'));
      held.push(body);
      return body.response;
    });
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expect(held).toHaveLength(5));
    current.clock(120_001);
    await act(async () => {
      held.forEach((body) => body.release());
    });
    await waitFor(() => expect(result.current.following.isError).toBe(true));
    await waitFor(() => expect(result.current.setters.isError).toBe(true));
    await waitFor(() => expect(result.current.recent.isError).toBe(true));
    await waitFor(() => expect(result.current.preview.isError).toBe(true));
    expect(result.current.board).toBeNull();
    expect(
      current.cache
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });

  it.each(['B', 'ABA'] as const)(
    'retains the separate logged-setter server-search operation across %s',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      const held = heldResponse({ userLoggedSetters: [{ setterUsername: 'needle-old-A', tickCount: 10 }] });
      current.performFetch.mockImplementation(async (_url, init) => {
        if (requestBody(init).variables?.input?.search) return held.response;
        return Response.json({
          data: {
            userLoggedSetters: Array.from({ length: LOGGED_SETTERS_PAGE_LIMIT }, (_, index) => ({
              setterUsername: `first-page-${index}`,
              tickCount: 1,
            })),
          },
        });
      });
      const { result, rerender } = renderHook(() => useUserLoggedSetters(targetUserId, scope, 'needle'), current);
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      current.performFetch.mockImplementation(async () =>
        Response.json({ data: { userLoggedSetters: [{ setterUsername: 'needle-fresh-owner', tickCount: 1 }] } }),
      );
      rerender();
      await waitFor(() => expect(result.current.setters?.[0].setterUsername).toBe('needle-fresh-owner'));
      await act(async () => {
        held.release();
      });
      expect(result.current.setters?.map((setter) => setter.setterUsername)).toEqual(['needle-fresh-owner']);
      expect(
        current.cache.getQueryData(
          original.key(['userLoggedSetters', targetUserId, { limit: LOGGED_SETTERS_PAGE_LIMIT, search: 'needle' }]),
        ),
      ).toBeUndefined();
      expect(
        current.performFetch.mock.calls
          .map(([, init]) => requestBody(init))
          .every((request) => request.variables?.userId === targetUserId),
      ).toBe(true);
    },
  );
});
