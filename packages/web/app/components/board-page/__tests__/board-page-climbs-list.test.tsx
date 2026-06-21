// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, waitFor } from '@testing-library/react';
import type { BoardDetails, Climb } from '@/app/lib/types';
import BoardPageClimbsList from '../board-page-climbs-list';
import { useSearchData } from '../../graphql-queue';
import { useOptionalBoardProvider } from '../../board-provider/board-provider-context';

vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: vi.fn(() => ({ currentClimb: null })),
  useSearchData: vi.fn(() => ({
    climbSearchResults: null,
    hasMoreResults: false,
    hasDoneFirstFetch: false,
    isFetchingClimbs: false,
  })),
  useQueueActions: vi.fn(() => ({
    addToQueue: vi.fn(),
    fetchMoreClimbs: vi.fn(),
  })),
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  useOptionalBoardProvider: vi.fn(),
}));

vi.mock('../climbs-list', () => ({
  default: ({ climbs }: { climbs: Climb[] }) => (
    <div data-testid="climbs-list">{climbs.map((climb) => climb.uuid).join(',')}</div>
  ),
}));

vi.mock('../../search-drawer/recent-search-pills', () => ({
  default: () => <div data-testid="recent-search-pills" />,
}));

vi.mock('../angle-selector', () => ({
  default: () => <div data-testid="angle-selector" />,
}));

vi.mock('../../queue-control/play-drawer-event', () => ({
  dispatchOpenPlayDrawer: vi.fn(),
}));

const mockUseSearchData = vi.mocked(useSearchData);
const mockUseOptionalBoardProvider = vi.mocked(useOptionalBoardProvider);

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    setter_username: 'setter',
    name: uuid,
    description: '',
    frames: 'p1r1',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V4',
    quality_average: '0',
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: [1],
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
  } as BoardDetails;
}

function renderBoardPageClimbsList(initialClimbs: Climb[]) {
  return render(
    <BoardPageClimbsList
      board_name="kilter"
      layout_id={1}
      size_id={1}
      set_ids={[1]}
      angle={40}
      boardDetails={makeBoardDetails()}
      initialClimbs={initialClimbs}
      initialHasMore={false}
    />,
  );
}

describe('BoardPageClimbsList logbook seed', () => {
  const mockGetLogbook = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOptionalBoardProvider.mockReturnValue({
      boardName: 'kilter',
      boardUuid: null,
      isAuthenticated: true,
      isLoading: false,
      error: null,
      isInitialized: true,
      logbook: [],
      logbookByClimbAngle: new Map(),
      getLogbook: mockGetLogbook,
      saveTick: vi.fn(),
      saveClimb: vi.fn(),
      updateClimb: vi.fn(),
    });
    mockUseSearchData.mockReturnValue({
      climbSearchParams: {} as never,
      climbSearchResults: null,
      totalSearchResultCount: null,
      hasMoreResults: false,
      isFetchingClimbs: false,
      isFetchingNextPage: false,
      hasDoneFirstFetch: false,
      parsedParams: {} as never,
    });
  });

  it('requests logbook entries for the server-rendered initial climbs', async () => {
    renderBoardPageClimbsList([makeClimb('climb-b'), makeClimb('climb-a')]);

    await waitFor(() => {
      expect(mockGetLogbook).toHaveBeenCalledWith(['climb-a', 'climb-b']);
    });
  });

  it('requests logbook entries again when client search results replace the initial list', async () => {
    const view = renderBoardPageClimbsList([makeClimb('initial-climb')]);

    await waitFor(() => {
      expect(mockGetLogbook).toHaveBeenCalledWith(['initial-climb']);
    });

    mockUseSearchData.mockReturnValue({
      climbSearchParams: {} as never,
      climbSearchResults: [makeClimb('client-climb')],
      totalSearchResultCount: null,
      hasMoreResults: false,
      isFetchingClimbs: false,
      isFetchingNextPage: false,
      hasDoneFirstFetch: true,
      parsedParams: {} as never,
    });
    view.rerender(
      <BoardPageClimbsList
        board_name="kilter"
        layout_id={1}
        size_id={1}
        set_ids={[1]}
        angle={40}
        boardDetails={makeBoardDetails()}
        initialClimbs={[makeClimb('initial-climb')]}
        initialHasMore={false}
      />,
    );

    await waitFor(() => {
      expect(mockGetLogbook).toHaveBeenCalledWith(['client-climb']);
    });
  });
});
