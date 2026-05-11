// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import type { LayoutStats, AscentFeedItem } from '@/app/lib/graphql/operations/ticks';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

// --- Capture virtualizer config so tests can pin overscan / count. ---
let lastVirtualizerOpts: { count: number; overscan: number; estimateSize: () => number } | null = null;

vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: (opts: {
    count: number;
    estimateSize: () => number;
    overscan: number;
    getItemKey: (i: number) => string | number;
  }) => {
    lastVirtualizerOpts = opts;
    // Render visible window + overscan, capped at count. Mirrors how the real
    // virtualizer behaves on first paint.
    const itemCount = Math.min(opts.overscan + 7, opts.count);
    const estimatedSize = opts.estimateSize();
    const items = Array.from({ length: itemCount }, (_, i) => ({
      index: i,
      key: opts.getItemKey ? opts.getItemKey(i) : `item-${i}`,
      start: i * estimatedSize,
      size: estimatedSize,
      end: (i + 1) * estimatedSize,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * estimatedSize,
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
      scrollOffset: 0,
      range: opts.count > 0 ? { startIndex: 0, endIndex: Math.min(6, opts.count - 1) } : null,
    };
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockRequest = vi.fn();
const getPreferenceMock = vi.fn().mockResolvedValue(null);
const showMessageSpy = vi.fn();

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

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1' } } }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/you/logbook',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

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

vi.mock('../logbook-feed-item', () => ({
  default: ({ item }: { item: AscentFeedItem }) => (
    <div data-testid="logbook-feed-item" data-uuid={item.uuid}>
      {item.uuid}
    </div>
  ),
}));

vi.mock('../logbook-swipe-hint-orchestrator', () => ({
  default: () => null,
}));

vi.mock('../logbook-item-skeleton', () => ({
  default: () => <div data-testid="logbook-skeleton" />,
}));

vi.mock('../logbook-search-form', () => ({
  default: () => <div data-testid="logbook-search-form" />,
}));

vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));

vi.mock('@mui/material/useMediaQuery', () => ({
  default: () => false,
}));

// Import after mocks.
import LogbookFeed from '../logbook-feed';

function makeAscentItem(index: number): AscentFeedItem {
  return {
    uuid: `tick-${index}`,
    climbUuid: `climb-${index}`,
    climbName: `Test Climb ${index}`,
    layoutId: 1,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    quality: 3,
    difficulty: 14,
    consensusDifficulty: 14,
    consensusQuality: 3,
    attemptCount: 1,
    comment: '',
    timestamp: '2026-05-10T00:00:00Z',
    setterUsername: 'setter',
    frames: 'p1r14',
    mirrored: false,
    boardSize: '12x12',
    instagramPostId: null,
  } as unknown as AscentFeedItem;
}

function makeLayoutStats(boardType: string, layoutId: number): LayoutStats {
  return {
    layoutKey: `${boardType}-${layoutId}`,
    boardType,
    layoutId,
    distinctClimbCount: 10,
    gradeCounts: [],
  };
}

function renderFeed() {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <LogbookFeed layoutStats={[makeLayoutStats('kilter', 1)]} loadingLayoutStats={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  getPreferenceMock.mockClear();
  showMessageSpy.mockClear();
  lastVirtualizerOpts = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LogbookFeed virtualization', () => {
  it('renders only the virtualized window, not the full item list', async () => {
    const items = Array.from({ length: 100 }, (_, i) => makeAscentItem(i));
    mockRequest.mockResolvedValue({ userAscentsFeed: { items, hasMore: false } });

    renderFeed();

    await waitFor(() => {
      expect(screen.queryAllByTestId('logbook-feed-item').length).toBeGreaterThan(0);
    });

    const rendered = screen.getAllByTestId('logbook-feed-item');
    expect(rendered.length).toBeLessThan(items.length);
    // With overscan=8 and the mock's window of overscan+7, ~15 items render.
    expect(rendered.length).toBeLessThanOrEqual(20);
  });

  it('passes the full item count and overscan=8 to the virtualizer when not editing', async () => {
    const items = Array.from({ length: 100 }, (_, i) => makeAscentItem(i));
    mockRequest.mockResolvedValue({ userAscentsFeed: { items, hasMore: false } });

    renderFeed();

    await waitFor(() => {
      expect(lastVirtualizerOpts).not.toBeNull();
      expect(lastVirtualizerOpts!.count).toBe(items.length);
    });
    // Pinning overscan defends against accidentally bumping the value back up
    // and undoing the LCP win on /you/logbook.
    expect(lastVirtualizerOpts!.overscan).toBe(8);
  });

  it('mounts only the virtualized window — guarantees DOM stays bounded for power users', async () => {
    const items = Array.from({ length: 500 }, (_, i) => makeAscentItem(i));
    mockRequest.mockResolvedValue({ userAscentsFeed: { items, hasMore: false } });

    renderFeed();

    await waitFor(() => {
      expect(screen.queryAllByTestId('logbook-feed-item').length).toBeGreaterThan(0);
    });

    const rendered = screen.getAllByTestId('logbook-feed-item');
    // 500 items in the feed, but the virtualizer keeps ~15 mounted on first
    // paint. Without virtualization this test would render 500 nodes.
    expect(rendered.length).toBeLessThan(50);
  });

  it('renders all items when the feed is small (no virtualization gain)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => makeAscentItem(i));
    mockRequest.mockResolvedValue({ userAscentsFeed: { items, hasMore: false } });

    renderFeed();

    await waitFor(() => {
      expect(screen.getAllByTestId('logbook-feed-item')).toHaveLength(5);
    });
  });
});
