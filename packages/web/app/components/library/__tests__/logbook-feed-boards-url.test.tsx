import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import type { LayoutStats } from '@/app/lib/graphql/operations/ticks';
import LogbookFeed from '../logbook-feed';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// --- Capture hook arguments ---
// vi.fn() holds its own call history and is reset in beforeEach, so tests stay
// isolated even if Vitest's scheduling changes in the future.

const mockRequest = vi.fn();
const getPreferenceMock = vi.fn().mockResolvedValue(null);
const searchFormSpy = vi.fn();
const showMessageSpy = vi.fn();

// --- Mocks (must come before component import) ---

vi.mock('../library.module.css', () => ({
  default: new Proxy({}, { get: (_t, p) => String(p) }),
}));
vi.mock('@/app/components/activity-feed/ascents-feed.module.css', () => ({
  default: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendHttpUrl: () => 'http://backend.test',
}));

vi.mock('@/app/lib/graphql/operations/ticks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/app/lib/graphql/operations/ticks');
  return {
    ...actual,
    GET_USER_ASCENTS_FEED: 'GET_USER_ASCENTS_FEED',
    DELETE_TICK: 'DELETE_TICK',
  };
});

// Session & routing
const mockSearchParams = { current: new URLSearchParams() };
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1' } } }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/you/logbook',
  useSearchParams: () => mockSearchParams.current,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Auth token resolved synchronously so the query is immediately enabled once
// preferencesLoaded and boardsInitialized both flip to true.
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/app/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: () => ({ sentinelRef: { current: null } }),
}));

// Preferences load resolves to null → defaults.
vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: (...args: unknown[]) => getPreferenceMock(...args),
  setPreference: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: showMessageSpy }),
}));

vi.mock('@/app/lib/instagram-posting', () => ({
  isInstagramPostingSupported: () => false,
}));

vi.mock('@/app/profile/[user_id]/utils/profile-constants', () => ({
  getLayoutDisplayName: (boardType: string, layoutId: number | null) => `${boardType}-${layoutId ?? 'unknown'}`,
}));

vi.mock('@boardsesh/board-constants/product-sizes', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Map layoutId → a stable non-null default so logbookBoards has a usable
    // sizeId/setIds for every layout in the test fixture.
    getDefaultSizeForLayout: (_boardName: string, layoutId: number) => layoutId * 10,
    getSetsForLayoutAndSize: () => [{ id: 1, name: 'All' }],
  };
});

vi.mock('@/app/lib/moonboard-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getLayoutById: () => null,
    MOONBOARD_SETS: {},
  };
});

// Stub child presentation components — we don't test their rendering here.
vi.mock('../logbook-feed-item', () => ({
  default: ({ item }: { item: { uuid: string; climbName: string } }) => (
    <div data-testid="logbook-feed-item">{item.climbName}</div>
  ),
}));

vi.mock('../logbook-swipe-hint-orchestrator', () => ({
  default: () => null,
}));

vi.mock('../logbook-item-skeleton', () => ({
  default: () => <div data-testid="logbook-skeleton" />,
}));

vi.mock('../logbook-search-form', () => ({
  default: (props: {
    selectedBoards: Array<{ uuid: string }>;
    boards: Array<{ uuid: string }>;
    actions?: React.ReactNode;
  }) => {
    searchFormSpy(props);
    return <div data-testid="logbook-search-form">{props.actions}</div>;
  },
}));

// next/dynamic is used transitively by some imports; short-circuit it.
vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));

vi.mock('@mui/material/useMediaQuery', () => ({
  default: () => false,
}));

// --- Import after mocks ---

// --- Helpers ---

function makeLayoutStats(boardType: string, layoutId: number): LayoutStats {
  return {
    layoutKey: `${boardType}-${layoutId}`,
    boardType,
    layoutId,
    distinctClimbCount: 10,
    gradeCounts: [],
  };
}

function renderFeed(loadingLayoutStats: boolean, layoutStats: LayoutStats[]) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <LogbookFeed layoutStats={layoutStats} loadingLayoutStats={loadingLayoutStats} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({
    userAscentsFeed: { items: [], hasMore: false },
  });
  searchFormSpy.mockClear();
  getPreferenceMock.mockClear();
  showMessageSpy.mockClear();
  mockSearchParams.current = new URLSearchParams();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function lastSelectedBoards(): Array<{ uuid: string }> {
  const calls = searchFormSpy.mock.calls;
  if (calls.length === 0) return [];
  return (calls[calls.length - 1][0] as { selectedBoards: Array<{ uuid: string }> }).selectedBoards;
}

// --- Tests ---

describe('LogbookFeed — boards URL round-trip', () => {
  it('does not fire the feed query until boards are initialized from the URL', async () => {
    mockSearchParams.current = new URLSearchParams('boards=logbook-kilter-1');

    // layoutStats still loading → logbookBoards empty → boardsInitialized stays false.
    const client = createTestQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <LogbookFeed layoutStats={[]} loadingLayoutStats />
      </QueryClientProvider>,
    );

    // Wait for preferences to load (positive signal): this is the async gate
    // that fires after the 'boardsInitialized' gate is evaluated. Once this
    // resolves, any query that were ever going to fire would have fired.
    await waitFor(() => {
      expect(getPreferenceMock).toHaveBeenCalled();
    });
    // Flush the resolved preferences promise's state update.
    await act(async () => {});
    expect(mockRequest).not.toHaveBeenCalled();

    // Now layoutStats load with the matching board. boardsInitialized flips true
    // and the query fires.
    rerender(
      <QueryClientProvider client={client}>
        <LogbookFeed layoutStats={[makeLayoutStats('kilter', 1)]} loadingLayoutStats={false} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });
  });

  it('resolves ?boards= UUIDs to selectedBoards and includes them in query variables', async () => {
    mockSearchParams.current = new URLSearchParams('boards=logbook-kilter-1');

    renderFeed(false, [makeLayoutStats('kilter', 1), makeLayoutStats('tension', 9)]);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    const [, variables] = mockRequest.mock.calls[0];
    expect(variables.input.boardType).toBe('kilter');
    expect(variables.input.layoutIds).toEqual([1]);

    expect(lastSelectedBoards().map((b) => b.uuid)).toEqual(['logbook-kilter-1']);
  });

  it('drops unknown UUIDs, fires query with no board filter, and shows a warning', async () => {
    mockSearchParams.current = new URLSearchParams('boards=logbook-kilter-999');

    renderFeed(false, [makeLayoutStats('kilter', 1)]);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    const [, variables] = mockRequest.mock.calls[0];
    expect(variables.input.boardType).toBeUndefined();
    expect(variables.input.boardTypes).toBeUndefined();
    expect(variables.input.layoutIds).toBeUndefined();

    expect(lastSelectedBoards()).toEqual([]);
    expect(showMessageSpy).toHaveBeenCalledWith(
      "Couldn't find the linked board — showing all your entries.",
      'warning',
    );
  });

  it('treats ?boards= (empty string) identically to no boards param', async () => {
    mockSearchParams.current = new URLSearchParams('boards=');

    renderFeed(false, [makeLayoutStats('kilter', 1)]);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    const [, variables] = mockRequest.mock.calls[0];
    expect(variables.input.boardType).toBeUndefined();
    expect(variables.input.boardTypes).toBeUndefined();
    expect(variables.input.layoutIds).toBeUndefined();

    expect(lastSelectedBoards()).toEqual([]);
    expect(showMessageSpy).not.toHaveBeenCalled();
  });

  it('supports multiple UUIDs and sends boardTypes when they span board types', async () => {
    mockSearchParams.current = new URLSearchParams('boards=logbook-kilter-1,logbook-tension-9');

    renderFeed(false, [makeLayoutStats('kilter', 1), makeLayoutStats('tension', 9)]);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    const [, variables] = mockRequest.mock.calls[0];
    expect(variables.input.boardTypes).toEqual(['kilter', 'tension']);
    expect(variables.input.layoutIds?.sort()).toEqual([1, 9]);

    expect(
      lastSelectedBoards()
        .map((b) => b.uuid)
        .sort(),
    ).toEqual(['logbook-kilter-1', 'logbook-tension-9']);
  });
});
