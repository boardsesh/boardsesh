// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';
import type { ClimbQueueItem } from '../types';

// --- Mocks ---

const mockSuggestedClimbs: Climb[] = [
  {
    uuid: 'suggested-1',
    name: 'Suggested Boulder A',
    setter_username: 'setter_1',
    description: '',
    frames: 'p1r14',
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V3',
    quality_average: '3.0',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  },
  {
    uuid: 'suggested-2',
    name: 'Suggested Boulder B',
    setter_username: 'setter_2',
    description: '',
    frames: 'p2r15',
    angle: 40,
    ascensionist_count: 8,
    difficulty: 'V5',
    quality_average: '4.0',
    stars: 0,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
  },
];

const mockQueueItems: ClimbQueueItem[] = [
  {
    uuid: 'queue-1',
    climb: {
      uuid: 'climb-q1',
      name: 'Queue Climb 1',
      setter_username: 'setter_q',
      description: '',
      frames: 'p3r16',
      angle: 40,
      ascensionist_count: 12,
      difficulty: 'V4',
      quality_average: '3.5',
      stars: 0,
      difficulty_error: '0.4',
      benchmark_difficulty: null,
    },
  },
];

// Mock graphql-queue hooks
vi.mock('../../graphql-queue', () => ({
  useCurrentClimbUuid: () => null,
  useQueueList: () => ({
    queue: mockQueueItems,
    suggestedClimbs: mockSuggestedClimbs,
  }),
  useSearchData: () => ({
    hasMoreResults: false,
    isFetchingClimbs: false,
    isFetchingNextPage: false,
  }),
  useSessionData: () => ({
    viewOnlyMode: false,
  }),
  useQueueActions: () => ({
    fetchMoreClimbs: vi.fn(),
    setCurrentClimbQueueItem: vi.fn(),
    setQueue: vi.fn(),
    addToQueue: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/original/12x12/default/40/play/some-climb',
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  useOptionalBoardProvider: () => null,
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({
    openAuthModal: vi.fn(),
  }),
}));

// Mock child components as simple divs with data-testid
const mockClimbListItem = vi.fn();

vi.mock('../queue-climb-list-item', () => ({
  default: ({ item }: { item: ClimbQueueItem }) => (
    <div data-testid="queue-climb-list-item" data-uuid={item.uuid}>
      {item.climb.name}
    </div>
  ),
}));

vi.mock('../../climb-card/climb-list-item', () => ({
  default: (props: { climb: Climb; addToQueue?: (climb: Climb) => void; swipeRightAction?: unknown }) => {
    mockClimbListItem(props);
    return (
      <div data-testid="climb-list-item" data-uuid={props.climb.uuid}>
        {props.climb.name}
      </div>
    );
  },
}));

vi.mock('../../climb-card/drawer-climb-header', () => ({
  default: () => <div data-testid="drawer-climb-header" />,
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="swipeable-drawer">{children}</div>
  ),
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

// Mock @tanstack/react-virtual so virtualizer works in jsdom
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
      scrollToIndex: vi.fn(),
    };
  },
}));

// Stub IntersectionObserver for jsdom
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: MockIntersectionObserver,
  writable: true,
});

import QueueList from '../queue-list';

// --- Helpers ---

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

// --- Tests ---

describe('QueueList active prop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClimbListItem.mockClear();
  });

  it('renders the "Suggestions" section header when active is true (default)', () => {
    render(<QueueList boardDetails={makeBoardDetails()} />);
    expect(screen.getByText('Suggestions')).toBeTruthy();
  });

  it('renders the "Suggestions" section header when active is explicitly true', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={true} />);
    expect(screen.getByText('Suggestions')).toBeTruthy();
  });

  it('does NOT render the "Suggestions" section header when active is false', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={false} />);
    expect(screen.queryByText('Suggestions')).toBeNull();
  });

  it('does NOT render suggested ClimbListItems when active is false', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={false} />);
    expect(screen.queryAllByTestId('climb-list-item')).toHaveLength(0);
  });

  it('renders suggested ClimbListItems when active is true', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={true} />);
    const items = screen.getAllByTestId('climb-list-item');
    expect(items).toHaveLength(2);
    expect(screen.getByText('Suggested Boulder A')).toBeTruthy();
    expect(screen.getByText('Suggested Boulder B')).toBeTruthy();
  });

  it('passes add-to-queue swipe behavior to suggested ClimbListItems', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={true} />);

    const propsList = mockClimbListItem.mock.calls.map(([props]) => props);
    expect(propsList).toHaveLength(2);
    propsList.forEach((props) => {
      expect(typeof props.addToQueue).toBe('function');
      expect(props.swipeRightAction).toBeUndefined();
    });
  });

  it('renders queue items (QueueClimbListItem) when active is true', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={true} />);
    const queueItems = screen.getAllByTestId('queue-climb-list-item');
    expect(queueItems).toHaveLength(1);
    expect(screen.getByText('Queue Climb 1')).toBeTruthy();
  });

  it('renders queue items (QueueClimbListItem) when active is false', () => {
    render(<QueueList boardDetails={makeBoardDetails()} active={false} />);
    const queueItems = screen.getAllByTestId('queue-climb-list-item');
    expect(queueItems).toHaveLength(1);
    expect(screen.getByText('Queue Climb 1')).toBeTruthy();
  });
});
