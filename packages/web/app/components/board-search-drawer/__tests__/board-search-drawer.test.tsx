import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import BoardSearchDrawer from '../board-search-drawer';

// --- Mocks (declared before the import that pulls them in) ---

const mockRequestPermission = vi.fn();
let mockUserCoords: { latitude: number; longitude: number; accuracy: number } | null = null;

vi.mock('@/app/hooks/use-geolocation', () => ({
  useGeolocation: () => ({
    coordinates: mockUserCoords,
    error: null,
    loading: false,
    permissionState: null,
    requestPermission: mockRequestPermission,
    refresh: vi.fn(),
  }),
}));

type SearchBoardsMapInputCapture = {
  query: string;
  latitude: number | null;
  longitude: number | null;
  zoom: number;
  enabled: boolean;
};
let lastSearchInput: SearchBoardsMapInputCapture | null = null;
let mockBoards: UserBoard[] = [];
const mockFetchNextPage = vi.fn();

vi.mock('@/app/hooks/use-search-boards-map', () => ({
  useSearchBoardsMap: (input: SearchBoardsMapInputCapture) => {
    lastSearchInput = input;
    return {
      boards: mockBoards,
      isLoading: false,
      isFetching: false,
      hasMore: false,
      isFetchingNextPage: false,
      fetchNextPage: mockFetchNextPage,
      radiusKm: 20,
    };
  },
}));

// MUI's SwipeableDrawer mounts its children in a portal even when the drawer
// is closed (display:none). Mirror that here so closed-state mount checks are
// meaningful — the real concern is whether children are *mounted*, not visible.
vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (
    <div data-testid="drawer" data-open={open ? 'true' : 'false'}>
      {children}
    </div>
  ),
}));

vi.mock('@/app/components/board-entity/board-card', () => ({
  default: ({
    board,
    onClick,
    trailingAction,
  }: {
    board: UserBoard;
    onClick?: (b: UserBoard) => void;
    trailingAction?: React.ReactNode;
  }) => (
    <div data-testid={`board-card-${board.uuid}`} onClick={() => onClick?.(board)}>
      <div>{board.name}</div>
      {trailingAction}
    </div>
  ),
}));

vi.mock('@/app/components/ui/follow-button', () => ({
  default: () => <div data-testid="follow-button" />,
}));

vi.mock('../board-search-map', () => ({
  default: ({ onViewportChange }: { onViewportChange: (v: { lat: number; lng: number; zoom: number }) => void }) => (
    <div data-testid="board-search-map" onClick={() => onViewportChange({ lat: 51.5, lng: -0.1, zoom: 12 })} />
  ),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FOLLOW_BOARD: 'FOLLOW_BOARD',
  UNFOLLOW_BOARD: 'UNFOLLOW_BOARD',
}));

// --- Import under test ---

function makeBoard(uuid: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    id: 1,
    uuid,
    name: `Board ${uuid}`,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    totalAscents: 0,
    slug: `kilter/1/1/1`,
    locationName: null,
    latitude: 51.5,
    longitude: -0.1,
    isFollowedByMe: false,
    ownerId: 'owner-1',
    isPublic: true,
    isOwned: false,
    isAngleAdjustable: false,
    createdAt: '2025-01-01T00:00:00Z',
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    ...overrides,
  } as UserBoard;
}

describe('BoardSearchDrawer', () => {
  beforeEach(() => {
    mockRequestPermission.mockReset();
    mockFetchNextPage.mockReset();
    mockUserCoords = null;
    mockBoards = [];
    lastSearchInput = null;
  });

  it('does not request geolocation while the drawer is closed', () => {
    render(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('requests geolocation exactly once on the first open', () => {
    const { rerender } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);

    // Re-rendering while still open must not re-fire the prompt
    rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('re-requests geolocation when the drawer is reopened (requestedGeo resets on close)', () => {
    const { rerender } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);

    rerender(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    expect(mockRequestPermission).toHaveBeenCalledTimes(2);
  });

  it('passes null coords to the hook until the user pans or geolocation resolves', () => {
    render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    expect(lastSearchInput).not.toBeNull();
    expect(lastSearchInput!.latitude).toBeNull();
    expect(lastSearchInput!.longitude).toBeNull();
    expect(lastSearchInput!.enabled).toBe(true);
  });

  it('forwards real coords once the map reports a viewport change', () => {
    render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId('board-search-map'));
    expect(lastSearchInput!.latitude).toBe(51.5);
    expect(lastSearchInput!.longitude).toBe(-0.1);
    expect(lastSearchInput!.zoom).toBe(12);
  });

  it('clears the typed query when the drawer closes', () => {
    mockBoards = [makeBoard('b1')];

    const { rerender, container } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: 'kilter' } });
    expect(lastSearchInput!.query).toBe('kilter');

    // Close and reopen — query should be empty
    rerender(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    expect(lastSearchInput!.query).toBe('');
  });

  it('resets coords to null when the drawer is closed and reopened without geolocation', () => {
    // userCoords is null (no geo) — only a manual pan had resolved coords.
    const { rerender } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    // Simulate the user panning the map to a real location
    fireEvent.click(screen.getByTestId('board-search-map'));
    expect(lastSearchInput!.latitude).toBe(51.5);
    expect(lastSearchInput!.longitude).toBe(-0.1);

    // Close the drawer — locationResolved should reset
    rerender(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    // Reopen without geo or further panning — coords must be null again
    rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    expect(lastSearchInput!.latitude).toBeNull();
    expect(lastSearchInput!.longitude).toBeNull();
  });

  it('auto-centers to user location when geolocation has resolved, and re-centers after reopen', () => {
    // Geolocation was already granted before the drawer opens.
    mockUserCoords = { latitude: 48.8, longitude: 2.3, accuracy: 10 };

    const { rerender } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    // Should auto-center to the resolved location immediately
    expect(lastSearchInput!.latitude).toBe(48.8);
    expect(lastSearchInput!.longitude).toBe(2.3);

    // Close and reopen — the close-effect reset must NOT leave coords null on
    // the next open when geolocation is still resolved. The !open guard in the
    // userCoords effect defers re-centering until open=true.
    rerender(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
    rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    expect(lastSearchInput!.latitude).toBe(48.8);
    expect(lastSearchInput!.longitude).toBe(2.3);
  });

  it('does not override a board-card selection when geolocation resolves afterward', () => {
    // Start with no geolocation — user picks a board first.
    mockBoards = [makeBoard('b1', { latitude: 51.5, longitude: -0.1 })];
    mockUserCoords = null;

    const { rerender } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    // Click the card — handleCardClick sets center and locationResolved=true
    fireEvent.click(screen.getByTestId('board-card-b1'));
    expect(lastSearchInput!.latitude).toBe(51.5);
    expect(lastSearchInput!.longitude).toBe(-0.1);

    // Geolocation now resolves to a different location
    mockUserCoords = { latitude: 48.8, longitude: 2.3, accuracy: 10 };
    rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);

    // Center must stay at the board's location, not jump to the user's coords
    expect(lastSearchInput!.latitude).toBe(51.5);
    expect(lastSearchInput!.longitude).toBe(-0.1);
  });

  it('invokes onBoardOpen when the Open button on a selected board is clicked', () => {
    mockBoards = [makeBoard('b1')];
    const onBoardOpen = vi.fn();

    render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={onBoardOpen} />);

    // Click the card to select it
    fireEvent.click(screen.getByTestId('board-card-b1'));

    // The Open button is rendered for the selected board
    fireEvent.click(screen.getByRole('button', { name: /open/i }));

    expect(onBoardOpen).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'b1' }));
  });

  describe('BoardSearchMap deferred mount', () => {
    it('does NOT mount BoardSearchMap on the very first render while the drawer is closed', () => {
      render(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
      // 99kB of OpenStreetMap tiles get downloaded the moment the map mounts.
      // Keeping the map unmounted until the user opens the drawer is the LCP win.
      expect(screen.queryByTestId('board-search-map')).toBeNull();
    });

    it('mounts BoardSearchMap on the same render that the drawer opens — no empty-frame flash', () => {
      // Defends the inline `setHasOpenedOnce(true)` + `mapMounted = hasOpenedOnce || open`
      // pattern. A useEffect-only approach would leave the map slot empty for one
      // commit, briefly showing a blank Box.
      const { rerender } = render(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
      expect(screen.queryByTestId('board-search-map')).toBeNull();

      rerender(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
      expect(screen.queryByTestId('board-search-map')).not.toBeNull();
    });

    it('keeps BoardSearchMap mounted after the drawer is closed (sticky)', () => {
      // The sticky flag avoids paying the Leaflet init + tile fetch cost on
      // every reopen and preserves any pan/zoom state across sessions.
      const { rerender } = render(<BoardSearchDrawer open onClose={vi.fn()} onBoardOpen={vi.fn()} />);
      expect(screen.queryByTestId('board-search-map')).not.toBeNull();

      rerender(<BoardSearchDrawer open={false} onClose={vi.fn()} onBoardOpen={vi.fn()} />);
      // Drawer is closed but map stays mounted — second open will be instant.
      expect(screen.queryByTestId('board-search-map')).not.toBeNull();
    });
  });
});
