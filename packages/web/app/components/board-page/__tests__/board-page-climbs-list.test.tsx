// @vitest-environment jsdom

import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails, Climb, SearchRequestPagination } from '@/app/lib/types';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { CurrentClimbDataType, GraphQLQueueActionsType, SearchDataType } from '../../graphql-queue/types';
import BoardPageClimbsList from '../board-page-climbs-list';

const mockSetCurrentClimb = vi.fn();
const mockAddToQueue = vi.fn();
const mockFetchMoreClimbs = vi.fn();

let mockCurrentClimbData: CurrentClimbDataType;
let mockSearchData: SearchDataType;

vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => mockCurrentClimbData,
  useQueueActions: () =>
    ({
      setCurrentClimb: mockSetCurrentClimb,
      addToQueue: mockAddToQueue,
      fetchMoreClimbs: mockFetchMoreClimbs,
    }) as unknown as GraphQLQueueActionsType,
  useSearchData: () => mockSearchData,
}));

vi.mock('../climbs-list', () => ({
  default: ({ climbs }: { climbs: Climb[] }) => <div data-testid="climbs-list">{climbs.length}</div>,
}));

vi.mock('../climb-list-utils', () => ({
  stabilizeClimbArrayRef: (nextClimbs: Climb[]) => nextClimbs,
}));

vi.mock('../../search-drawer/recent-search-pills', () => ({
  default: () => <div data-testid="recent-search-pills" />,
}));

vi.mock('../angle-selector', () => ({
  default: () => <div data-testid="angle-selector" />,
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  angle: 40,
  images_to_holds: {},
  holdsData: [],
  boardWidth: 100,
  boardHeight: 100,
} as unknown as BoardDetails;

const initialClimb: Climb = {
  uuid: 'climb-1',
  name: 'Test Boulder',
  setter_username: 'setter',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 1,
  difficulty: 'V4',
  quality_average: '3.0',
  stars: 0,
  difficulty_error: '0.5',
  benchmark_difficulty: null,
};

const makeSearchData = (climbSearchParams: SearchRequestPagination): SearchDataType => ({
  climbSearchParams,
  climbSearchResults: [initialClimb],
  totalSearchResultCount: 1,
  hasMoreResults: false,
  isFetchingClimbs: false,
  isFetchingNextPage: false,
  hasDoneFirstFetch: true,
  parsedParams: {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: [1],
    angle: 40,
  },
});

const renderList = () =>
  render(
    <BoardPageClimbsList
      board_name="kilter"
      layout_id={1}
      size_id={1}
      set_ids={[1]}
      angle={40}
      boardDetails={boardDetails}
      initialClimbs={[initialClimb]}
    />,
  );

describe('BoardPageClimbsList search scroll reset', () => {
  let scrollToMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    scrollToMock = vi.fn();
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: scrollToMock,
    });

    mockCurrentClimbData = {
      currentClimbQueueItem: null,
      currentClimb: null,
    };
    mockSearchData = makeSearchData({ ...DEFAULT_SEARCH_PARAMS });
  });

  it('does not scroll on the initial render', () => {
    renderList();

    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it('scrolls to the top when the effective search changes', () => {
    const { rerender } = renderList();

    mockSearchData = makeSearchData({ ...DEFAULT_SEARCH_PARAMS, name: 'crux' });
    rerender(
      <BoardPageClimbsList
        board_name="kilter"
        layout_id={1}
        size_id={1}
        set_ids={[1]}
        angle={40}
        boardDetails={boardDetails}
        initialClimbs={[initialClimb]}
      />,
    );

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('does not scroll when only the search page changes', () => {
    mockSearchData = makeSearchData({ ...DEFAULT_SEARCH_PARAMS, name: 'crux', page: 0 });
    const { rerender } = renderList();

    mockSearchData = makeSearchData({ ...DEFAULT_SEARCH_PARAMS, name: 'crux', page: 2 });
    rerender(
      <BoardPageClimbsList
        board_name="kilter"
        layout_id={1}
        size_id={1}
        set_ids={[1]}
        angle={40}
        boardDetails={boardDetails}
        initialClimbs={[initialClimb]}
      />,
    );

    expect(scrollToMock).not.toHaveBeenCalled();
  });
});
