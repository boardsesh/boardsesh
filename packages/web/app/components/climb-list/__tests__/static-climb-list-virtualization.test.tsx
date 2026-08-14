// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { LIST_ROW_HEIGHT } from '@/app/lib/climb-list-constants';
import StaticClimbList from '../static-climb-list';

vi.mock('next/navigation', () => ({
  usePathname: () => '/playlists/some-uuid',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../static-climb-row', () => ({
  default: ({ climb }: { climb: Climb }) => <div data-testid="static-climb-row">{climb.name}</div>,
}));

vi.mock('@/app/components/error-boundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

let loadMoreSentinelProps: { hasMore: boolean; isFetching?: boolean } | null = null;
vi.mock('@/app/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: (opts: { hasMore: boolean; isFetching?: boolean }) => {
    loadMoreSentinelProps = opts;
    return { sentinelRef: { current: null } };
  },
}));

// Capture what the list asks the virtualizer for, and render a deterministic
// window so the row-count assertions below don't depend on a real viewport.
let lastVirtualizerOpts: {
  count: number;
  overscan: number;
  estimateSize: () => number;
  initialRect?: { width: number; height: number };
} | null = null;

vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: (opts: {
    count: number;
    estimateSize: () => number;
    overscan: number;
    getItemKey: (i: number) => string | number;
    initialRect?: { width: number; height: number };
  }) => {
    lastVirtualizerOpts = opts;
    const itemCount = Math.min(opts.overscan + 7, opts.count);
    const estimatedSize = opts.estimateSize();
    const items = Array.from({ length: itemCount }, (_, index) => ({
      index,
      key: opts.getItemKey ? opts.getItemKey(index) : `item-${index}`,
      start: index * estimatedSize,
      size: estimatedSize,
      end: (index + 1) * estimatedSize,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * estimatedSize,
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
      scrollOffset: 0,
    };
  },
}));

function makeClimb(index: number): Climb {
  return {
    uuid: `climb-${index}`,
    name: `Test Boulder ${index}`,
    setter_username: 'setter',
    description: '',
    frames: `p${index}r14`,
    angle: 40,
    ascensionist_count: 5,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  } as Climb;
}

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
  } as BoardDetails;
}

const hundredClimbs = Array.from({ length: 100 }, (_, index) => makeClimb(index));

function renderList(overrides: Partial<React.ComponentProps<typeof StaticClimbList>> = {}) {
  const props: React.ComponentProps<typeof StaticClimbList> = {
    climbs: hundredClimbs,
    boardDetails: makeBoardDetails(),
    isFetching: false,
    hasMore: false,
    onLoadMore: vi.fn(),
    ...overrides,
  };
  return { ...render(<StaticClimbList {...props} />), props };
}

describe('StaticClimbList virtualization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastVirtualizerOpts = null;
    loadMoreSentinelProps = null;
  });

  it('asks the virtualizer for every climb', () => {
    renderList();
    expect(lastVirtualizerOpts?.count).toBe(100);
  });

  it('keeps overscan at 10 so first paint stays cheap', () => {
    renderList();
    expect(lastVirtualizerOpts?.overscan).toBe(10);
  });

  it('estimates rows at the shared LIST_ROW_HEIGHT', () => {
    renderList();
    expect(lastVirtualizerOpts?.estimateSize()).toBe(LIST_ROW_HEIGHT);
  });

  it('provides the fake SSR viewport that makes getVirtualItems() non-empty on the server', () => {
    renderList();
    expect(lastVirtualizerOpts?.initialRect).toEqual({ width: 375, height: 812 });
  });

  it('floors each measured row wrapper at the estimate so no row reflows on mount', () => {
    const { container } = renderList();
    const firstRow = container.querySelector('[data-index="0"]');
    expect((firstRow as HTMLElement).style.minHeight).toBe(`${LIST_ROW_HEIGHT}px`);
  });

  it('renders far fewer rows than climbs', () => {
    renderList();
    expect(screen.getAllByTestId('static-climb-row').length).toBeLessThan(hundredClimbs.length);
  });

  it('renders every row when the list is short', () => {
    renderList({ climbs: hundredClimbs.slice(0, 5) });
    expect(screen.getAllByTestId('static-climb-row')).toHaveLength(5);
  });

  it('renders renderItemExtra output inside the measured wrapper', () => {
    const { container } = renderList({
      climbs: hundredClimbs.slice(0, 3),
      renderItemExtra: (climb) => <div data-testid={`extra-${climb.uuid}`} />,
    });
    const firstRow = container.querySelector('[data-index="0"]');
    expect(firstRow?.querySelector('[data-testid="extra-climb-0"]')).not.toBeNull();
  });

  it('pages five rows early when there is more to fetch', () => {
    const onLoadMore = vi.fn();
    // 12 climbs, and the mocked window renders 12 of them — the last virtual
    // index (11) is inside the five-row trigger zone.
    renderList({ climbs: hundredClimbs.slice(0, 12), hasMore: true, onLoadMore });
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('does not page while a fetch is already in flight', () => {
    const onLoadMore = vi.fn();
    renderList({ climbs: hundredClimbs.slice(0, 12), hasMore: true, isFetching: true, onLoadMore });
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not page when there is nothing more to fetch', () => {
    const onLoadMore = vi.fn();
    renderList({ climbs: hundredClimbs.slice(0, 12), hasMore: false, onLoadMore });
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not page on an empty list', () => {
    const onLoadMore = vi.fn();
    renderList({ climbs: [], hasMore: true, onLoadMore });
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('renders the empty state instead of rows when there are no climbs', () => {
    renderList({ climbs: [], emptyState: <div data-testid="empty-state" /> });
    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.queryByTestId('static-climb-row')).toBeNull();
  });

  it('still wires the sentinel for a list that fits in one screen', () => {
    renderList({ climbs: hundredClimbs.slice(0, 3), hasMore: true });
    expect(loadMoreSentinelProps).toEqual(expect.objectContaining({ hasMore: true, isFetching: false }));
  });
});
