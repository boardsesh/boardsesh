// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { ClimbQueueItem } from '../types';
import QueueList, { type QueueListHandle } from '../queue-list';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string | readonly string[]) => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
  }),
}));

// 8 history items + 1 current + 1 future — exercises the 5-by-default cap.
const queueWithLongHistory: ClimbQueueItem[] = Array.from({ length: 10 }, (_, i) => ({
  uuid: `queue-${i}`,
  climb: {
    uuid: `climb-${i}`,
    name: `Boulder ${i}`,
    setter_username: 'setter',
    description: '',
    frames: `p${i}r14`,
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  } as Climb,
}));

const currentUuid = 'queue-8'; // history = queue-0..queue-7 (8 items), future = queue-9

vi.mock('../../graphql-queue', () => ({
  useCurrentClimbUuid: () => currentUuid,
  useQueueList: () => ({
    queue: queueWithLongHistory,
    suggestedClimbs: [],
  }),
  useSearchData: () => ({
    hasMoreResults: false,
    isFetchingClimbs: false,
    isFetchingNextPage: false,
  }),
  useSessionData: () => ({ viewOnlyMode: false }),
  useQueueActions: () => ({
    fetchMoreClimbs: vi.fn(),
    setCurrentClimbQueueItem: vi.fn(),
    setQueue: vi.fn(),
    addToQueue: vi.fn(),
    previewClimbFromBrowse: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/original/12x12/default/40/play/some-climb',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({}),
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@/app/hooks/use-drawer-drag-resize', () => ({
  useDrawerDragResize: () => ({ paperRef: { current: null }, dragHandlers: {} }),
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  useOptionalBoardProvider: () => null,
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

vi.mock('../queue-climb-list-item', () => ({
  default: ({ item, isCurrent, isHistory }: { item: ClimbQueueItem; isCurrent: boolean; isHistory: boolean }) => (
    <div
      data-testid="queue-climb-list-item"
      data-uuid={item.uuid}
      data-current={isCurrent ? 'true' : 'false'}
      data-history={isHistory ? 'true' : 'false'}
    >
      {item.climb.name}
    </div>
  ),
}));

vi.mock('../../climb-card/climb-list-item', () => ({
  default: ({ climb }: { climb: Climb }) => (
    <div data-testid="climb-list-item" data-uuid={climb.uuid}>
      {climb.name}
    </div>
  ),
}));

vi.mock('../../climb-card/drawer-climb-header', () => ({
  default: () => <div data-testid="drawer-climb-header" />,
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="swipeable-drawer">{children}</div>,
}));

vi.mock('../../climb-actions', () => ({
  ClimbActions: () => <div data-testid="climb-actions" />,
}));

vi.mock('../../climb-actions/playlist-selection-content', () => ({
  default: () => <div data-testid="playlist-selection-content" />,
}));

vi.mock('../../logbook/log-ascent-drawer', () => ({
  LogAscentDrawer: () => <div data-testid="log-ascent-drawer" />,
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  monitorForElements: () => () => {},
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  extractClosestEdge: () => null,
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/reorder', () => ({
  reorder: ({ list }: { list: unknown[] }) => list,
}));

vi.mock('@/app/lib/climb-action-utils', () => ({
  getExcludedClimbActions: () => [],
}));

vi.mock('../../board-page/constants', () => ({
  SUGGESTIONS_THRESHOLD: 5,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 16: 64 },
    colors: { error: '#B8524C', primary: '#8C4A52', success: '#6B9080' },
    neutral: { 200: '#E5E7EB', 400: '#9CA3AF', 500: '#6B7280' },
    typography: {
      fontSize: { xs: 12, sm: 14, base: 16, xl: 20, '2xl': 24 },
      fontWeight: { normal: 400, semibold: 600, bold: 700 },
    },
  },
}));

vi.mock('../queue-list.module.css', () => ({
  default: {
    queueColumn: 'queueColumn',
    suggestedSectionHeader: 'suggestedSectionHeader',
    suggestedColumn: 'suggestedColumn',
    suggestedItem: 'suggestedItem',
    historyDivider: 'historyDivider',
    historyShowAll: 'historyShowAll',
    loadMoreContainer: 'loadMoreContainer',
    loadMoreSkeletonRow: 'loadMoreSkeletonRow',
    noMoreSuggestions: 'noMoreSuggestions',
  },
}));

// Capture scrollToIndex calls from the virtualizer mock so we can assert the
// alignment requested by scrollToCurrentClimb (the pivot wants 'center').
const scrollToIndexSpy = vi.fn();

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => {
    const items = Array.from({ length: opts.count }, (_, i) => ({
      index: i,
      key: opts.getItemKey ? opts.getItemKey(i) : `item-${i}`,
      start: i * 72,
      size: 72,
      end: (i + 1) * 72,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * 72,
      measureElement: vi.fn(),
      scrollToIndex: scrollToIndexSpy,
    };
  },
}));

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: MockIntersectionObserver,
  writable: true,
});

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
  } as unknown as BoardDetails;
}

describe('QueueList history collapse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scrollToIndexSpy.mockClear();
  });

  it('renders only the 5 most recent history items by default, with a Show-full row', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={false} showHistory />);

    // 5 history rows + 1 current row = 6 queue items rendered, plus one future
    const queueItems = screen.getAllByTestId('queue-climb-list-item');
    const historyItems = queueItems.filter((node) => node.getAttribute('data-history') === 'true');
    expect(historyItems).toHaveLength(5);

    // Oldest 3 history items should be hidden (queue-0, queue-1, queue-2)
    expect(screen.queryByText('Boulder 0')).toBeNull();
    expect(screen.queryByText('Boulder 1')).toBeNull();
    expect(screen.queryByText('Boulder 2')).toBeNull();

    // Most recent 5 history items visible (queue-3..queue-7)
    for (let i = 3; i <= 7; i++) {
      expect(screen.getByText(`Boulder ${i}`)).toBeTruthy();
    }

    // Show-full row mentions the hidden count (3 more)
    expect(screen.getByRole('button', { name: /show full history.*3 more/i })).toBeTruthy();
  });

  it('reveals every history item after the Show full history button is pressed', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={false} showHistory />);

    const showAllButton = screen.getByRole('button', { name: /show full history.*3 more/i });
    fireEvent.click(showAllButton);

    const queueItems = screen.getAllByTestId('queue-climb-list-item');
    const historyItems = queueItems.filter((node) => node.getAttribute('data-history') === 'true');
    expect(historyItems).toHaveLength(8);

    // All 8 history climbs now visible
    for (let i = 0; i <= 7; i++) {
      expect(screen.getByText(`Boulder ${i}`)).toBeTruthy();
    }

    // Button disappears after expansion
    expect(screen.queryByRole('button', { name: /show full history/i })).toBeNull();
  });

  it('collapses an expanded history back to 5 items when active transitions to false', () => {
    const { rerender } = render(<QueueList boardDetails={makeBoardDetails()} active showHistory />);

    // Expand history by clicking the show-all button.
    fireEvent.click(screen.getByRole('button', { name: /show full history.*3 more/i }));
    expect(
      screen.getAllByTestId('queue-climb-list-item').filter((n) => n.getAttribute('data-history') === 'true'),
    ).toHaveLength(8);

    // Simulate the drawer closing — without unmounting, as would happen with
    // keepMounted. The reset effect must restore the 5-item view so the next
    // open of the drawer doesn't stick on the expanded state.
    rerender(<QueueList boardDetails={makeBoardDetails()} active={false} showHistory />);

    const historyItemsAfter = screen
      .getAllByTestId('queue-climb-list-item')
      .filter((n) => n.getAttribute('data-history') === 'true');
    expect(historyItemsAfter).toHaveLength(5);
    expect(screen.getByRole('button', { name: /show full history.*3 more/i })).toBeTruthy();
  });

  it('scrollToCurrentClimb centers the current item in the viewport', () => {
    const handle = React.createRef<QueueListHandle>();
    render(<QueueList ref={handle} boardDetails={makeBoardDetails()} active={false} showHistory />);

    handle.current?.scrollToCurrentClimb();

    expect(scrollToIndexSpy).toHaveBeenCalled();
    const lastCall = scrollToIndexSpy.mock.calls[scrollToIndexSpy.mock.calls.length - 1];
    const [, options] = lastCall as [number, { align: string; behavior: string }];
    expect(options.align).toBe('center');
  });
});
