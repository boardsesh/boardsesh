import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useDiscoverBoards } from '../use-discover-boards';

// --- Mocks ---

const mockRequest = vi.fn();

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  SEARCH_BOARDS: 'SEARCH_BOARDS_QUERY',
}));

// --- Import after mocks ---

// --- Helpers ---

function makeBoard(uuid: string, totalAscents: number, overrides?: Partial<UserBoard>): UserBoard {
  return {
    id: 1,
    uuid,
    name: `Board ${uuid}`,
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27',
    angle: 40,
    totalAscents,
    slug: `kilter/8/25/26,27`,
    locationName: null,
    latitude: null,
    longitude: null,
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

function makeSearchResponse(boards: UserBoard[]) {
  return { searchBoards: { boards, totalCount: boards.length, hasMore: false } };
}

let mockGetCurrentPosition: ReturnType<typeof vi.fn>;

function setupGeolocation() {
  mockGetCurrentPosition = vi.fn();
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition: mockGetCurrentPosition },
    writable: true,
    configurable: true,
  });
}

function removeGeolocation() {
  Object.defineProperty(navigator, 'geolocation', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

function geoSuccess(latitude: number, longitude: number) {
  mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
    success({
      coords: {
        latitude,
        longitude,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON() {
          return {
            latitude,
            longitude,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          };
        },
      },
      timestamp: Date.now(),
      toJSON() {
        return { coords: this.coords, timestamp: this.timestamp };
      },
    } as GeolocationPosition);
  });
}

function geoDenied() {
  mockGetCurrentPosition.mockImplementation((_success: PositionCallback, error: PositionErrorCallback) => {
    error({
      code: 1,
      message: 'User denied',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    });
  });
}

// --- Tests ---

describe('useDiscoverBoards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupGeolocation();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not fetch anything when enableLocation=false (default in home page)', async () => {
    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: false }));

    // Should not be loading and should have no boards
    expect(result.current.isLoading).toBe(false);
    expect(result.current.boards).toEqual([]);
    expect(result.current.hasLocation).toBe(false);
    expect(result.current.error).toBeNull();

    // No API calls or geolocation requests
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it('fetches nearby boards with coordinates when enableLocation=true and geo succeeds', async () => {
    geoSuccess(40.7, -74.0);

    const nearby = [makeBoard('n1', 10), makeBoard('n2', 5)];
    mockRequest.mockResolvedValueOnce(makeSearchResponse(nearby));

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.boards.map((b) => b.uuid)).toEqual(['n1', 'n2']);
    expect(result.current.hasLocation).toBe(true);
    expect(result.current.error).toBeNull();

    // SEARCH_BOARDS called with coordinates
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('SEARCH_BOARDS_QUERY', {
      input: {
        latitude: 40.7,
        longitude: -74.0,
        radiusKm: 1,
        limit: 20,
      },
    });
  });

  it('returns empty boards with no error when geolocation denied', async () => {
    geoDenied();

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.boards).toEqual([]);
    expect(result.current.hasLocation).toBe(false);
    expect(result.current.error).toBeNull();
    // No SEARCH_BOARDS call since we have no coords
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns empty boards when no geolocation API available', async () => {
    removeGeolocation();

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.boards).toEqual([]);
    expect(result.current.hasLocation).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('sets error when SEARCH_BOARDS request fails', async () => {
    geoSuccess(40.7, -74.0);
    mockRequest.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Failed to load nearby boards');
    expect(result.current.boards).toEqual([]);
    expect(result.current.hasLocation).toBe(false);
  });

  it('respects limit parameter', async () => {
    geoSuccess(40.7, -74.0);

    const nearby = Array.from({ length: 10 }, (_, i) => makeBoard(`n${i}`, i));
    mockRequest.mockResolvedValueOnce(makeSearchResponse(nearby));

    const { result } = renderHook(() => useDiscoverBoards({ limit: 5, enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockRequest).toHaveBeenCalledWith('SEARCH_BOARDS_QUERY', {
      input: expect.objectContaining({ limit: 5 }),
    });
  });

  it('caches geolocation across re-fetches (geoResolvedRef prevents re-prompt)', async () => {
    geoSuccess(40.7, -74.0);

    const nearby = [makeBoard('n1', 10)];
    mockRequest.mockResolvedValueOnce(makeSearchResponse(nearby));

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('toggling enableLocation from false to true triggers geolocation and fetch', async () => {
    geoSuccess(40.7, -74.0);

    // First render with enableLocation=false
    const { result, rerender } = renderHook(
      ({ enableLocation }: { enableLocation: boolean }) => useDiscoverBoards({ enableLocation }),
      { initialProps: { enableLocation: false } },
    );

    // No fetching
    expect(result.current.isLoading).toBe(false);
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();

    // Now toggle enableLocation to true
    const nearby = [makeBoard('n1', 10)];
    mockRequest.mockResolvedValueOnce(makeSearchResponse(nearby));

    rerender({ enableLocation: true });

    await waitFor(() => {
      expect(result.current.hasLocation).toBe(true);
    });

    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
    expect(result.current.boards.some((b) => b.uuid === 'n1')).toBe(true);
  });

  it('never calls SEARCH_BOARDS without coordinates', async () => {
    geoDenied();

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Verify SEARCH_BOARDS was never called (geo was denied, so no coords)
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('shows loading state while resolving geolocation', () => {
    // Make geo hang forever
    mockGetCurrentPosition.mockImplementation(() => {});

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.boards).toEqual([]);
  });

  it('shows loading state during API call after geo resolves', async () => {
    geoSuccess(40.7, -74.0);

    // Make the API call hang so we can observe loading during the request
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    // After geo resolves but before API returns, should still be loading
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
    expect(result.current.isLoading).toBe(true);

    // Now resolve the API call
    resolveRequest!(makeSearchResponse([makeBoard('n1', 10)]));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.boards).toHaveLength(1);
  });

  it('sets hasLocation=true with empty boards when geo succeeds but no nearby boards found', async () => {
    geoSuccess(40.7, -74.0);

    // API returns empty results
    mockRequest.mockResolvedValueOnce(makeSearchResponse([]));

    const { result } = renderHook(() => useDiscoverBoards({ enableLocation: true }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // hasLocation should be true (we got coords), but boards empty
    expect(result.current.hasLocation).toBe(true);
    expect(result.current.boards).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
