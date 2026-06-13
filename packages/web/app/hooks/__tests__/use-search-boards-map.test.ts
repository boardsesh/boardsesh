import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import type { UserBoard, UserBoardConnection } from '@boardsesh/shared-schema';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import { useSearchBoardsMap, zoomToRadiusKm } from '../use-search-boards-map';

// --- Mocks (declared before importing the hook) ---

const mockRequest = vi.fn();

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/app/hooks/use-debounced-value', () => ({
  useDebouncedValue: <T>(v: T) => v,
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  SEARCH_BOARDS: 'SEARCH_BOARDS_QUERY',
}));

// --- Helpers ---

function makeBoard(uuid: string, overrides?: Partial<UserBoard>): UserBoard {
  return {
    id: 1,
    uuid,
    name: `Board ${uuid}`,
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27',
    angle: 40,
    totalAscents: 0,
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

function makeSearchResponse(boards: UserBoard[], hasMore = false): { searchBoards: UserBoardConnection } {
  return { searchBoards: { boards, totalCount: boards.length + (hasMore ? 100 : 0), hasMore } };
}

describe('zoomToRadiusKm', () => {
  it('returns 5 km at high zoom levels (14+)', () => {
    expect(zoomToRadiusKm(14)).toBe(5);
    expect(zoomToRadiusKm(15)).toBe(5);
    expect(zoomToRadiusKm(18)).toBe(5);
    expect(zoomToRadiusKm(19)).toBe(5);
  });

  it('steps 10 → 15 → 20 km for zoom 13, 12, 11', () => {
    expect(zoomToRadiusKm(13)).toBe(10);
    expect(zoomToRadiusKm(12)).toBe(15);
    expect(zoomToRadiusKm(11)).toBe(20);
  });

  it('doubles roughly every zoom step below 11', () => {
    expect(zoomToRadiusKm(10)).toBe(40);
    expect(zoomToRadiusKm(9)).toBe(80);
    expect(zoomToRadiusKm(8)).toBe(160);
  });

  it('caps the radius at 300 km for zoom 7 and below', () => {
    expect(zoomToRadiusKm(7)).toBe(300);
    expect(zoomToRadiusKm(5)).toBe(300);
    expect(zoomToRadiusKm(0)).toBe(300);
    expect(zoomToRadiusKm(-1)).toBe(300);
  });

  it('uses the default 20 km bucket at zoom 11 (the drawer default)', () => {
    expect(zoomToRadiusKm(11)).toBe(20);
  });

  it('is monotonically non-decreasing as zoom decreases', () => {
    let prev = zoomToRadiusKm(19);
    for (let z = 18; z >= 0; z--) {
      const next = zoomToRadiusKm(z);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });
});

describe('useSearchBoardsMap query gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call SEARCH_BOARDS when enabled is false', async () => {
    const { result } = renderHook(
      () =>
        useSearchBoardsMap({
          query: '',
          latitude: 40.7,
          longitude: -74.0,
          zoom: 11,
          enabled: false,
        }),
      { wrapper: createQueryWrapper() },
    );

    // Give react-query a chance to settle
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.boards).toEqual([]);
  });

  it('does not call SEARCH_BOARDS without coords and with a short query', async () => {
    const { result } = renderHook(
      () =>
        useSearchBoardsMap({
          query: 'a', // below the 2-char threshold
          latitude: null,
          longitude: null,
          zoom: 11,
          enabled: true,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.boards).toEqual([]);
  });

  it('fires the query when coords are present even with no query text', async () => {
    mockRequest.mockResolvedValueOnce(makeSearchResponse([makeBoard('b1')]));

    const { result } = renderHook(
      () =>
        useSearchBoardsMap({
          query: '',
          latitude: 40.7,
          longitude: -74.0,
          zoom: 11,
          enabled: true,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(1);
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(
      'SEARCH_BOARDS_QUERY',
      expect.objectContaining({
        input: expect.objectContaining({
          latitude: 40.7,
          longitude: -74.0,
          radiusKm: 20,
          offset: 0,
        }),
      }),
    );
  });

  it('fires the query when only a >= 2-char text query is provided', async () => {
    mockRequest.mockResolvedValueOnce(makeSearchResponse([makeBoard('b1')]));

    const { result } = renderHook(
      () =>
        useSearchBoardsMap({
          query: 'kilter',
          latitude: null,
          longitude: null,
          zoom: 11,
          enabled: true,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(1);
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const calledWith = mockRequest.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(calledWith.input.query).toBe('kilter');
    expect(calledWith.input.latitude).toBeUndefined();
    expect(calledWith.input.longitude).toBeUndefined();
    expect(calledWith.input.radiusKm).toBeUndefined();
  });
});

describe('useSearchBoardsMap pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports hasMore=false when the server has no more pages', async () => {
    mockRequest.mockResolvedValueOnce(makeSearchResponse([makeBoard('b1')], false));

    const { result } = renderHook(
      () =>
        useSearchBoardsMap({
          query: '',
          latitude: 40.7,
          longitude: -74.0,
          zoom: 11,
          enabled: true,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(1);
    });

    expect(result.current.hasMore).toBe(false);
  });

  it('fetches the next page with offset = sum of boards seen so far', async () => {
    const firstPage = [makeBoard('a1'), makeBoard('a2'), makeBoard('a3')];
    const secondPage = [makeBoard('b1'), makeBoard('b2')];

    mockRequest
      .mockResolvedValueOnce(makeSearchResponse(firstPage, true))
      .mockResolvedValueOnce(makeSearchResponse(secondPage, false));

    const { result } = renderHook(
      () =>
        useSearchBoardsMap({
          query: '',
          latitude: 40.7,
          longitude: -74.0,
          zoom: 11,
          enabled: true,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(3);
    });

    expect(result.current.hasMore).toBe(true);
    // First fetch at offset 0
    expect((mockRequest.mock.calls[0][1] as { input: { offset: number } }).input.offset).toBe(0);

    result.current.fetchNextPage();

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(5);
    });

    // Second fetch at offset 3 (size of first page)
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect((mockRequest.mock.calls[1][1] as { input: { offset: number } }).input.offset).toBe(3);
    expect(result.current.hasMore).toBe(false);
  });
});
