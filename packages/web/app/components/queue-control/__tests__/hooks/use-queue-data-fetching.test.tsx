import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQueueDataFetching } from '../../hooks/use-queue-data-fetching';
import { ParsedBoardRouteParameters, SearchRequestPagination, Climb } from '@/app/lib/types';
import { ClimbQueue } from '../../types';
import { useBoardProvider, useOptionalBoardProvider } from '../../../board-provider/board-provider-context';
import React from 'react';

// Mock dependencies
vi.mock('@/app/lib/url-utils', () => ({
  searchParamsToUrlParams: vi.fn(() => new URLSearchParams('page=1'))
}));

vi.mock('../../../board-provider/board-provider-context', () => ({
  useBoardProvider: vi.fn(() => ({
    getLogbook: vi.fn().mockResolvedValue(true)
  })),
  useOptionalBoardProvider: vi.fn(() => ({
    getLogbook: vi.fn().mockResolvedValue(true)
  }))
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(() => ({
    token: 'mock-token',
    isAuthenticated: true,
    isLoading: false,
    error: null
  }))
}));

vi.mock('../../board-page/constants', () => ({
  PAGE_LIMIT: 20
}));

// Mock SSR initial climbs context
const mockSSRInitialClimbs = vi.fn(() => null);
vi.mock('../../ssr-initial-climbs-context', () => ({
  useSSRInitialClimbs: () => mockSSRInitialClimbs(),
}));

// Mock GraphQL client
const mockGraphQLRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({
    request: mockGraphQLRequest
  }))
}));

// Set environment variable for GraphQL client
process.env.NEXT_PUBLIC_WS_URL = 'ws://localhost:4000/graphql';

// Mock history.replaceState
Object.defineProperty(window, 'history', {
  value: {
    replaceState: vi.fn()
  },
  writable: true
});

Object.defineProperty(window, 'location', {
  value: {
    pathname: '/test/path'
  },
  writable: true
});

const mockUseBoardProvider = vi.mocked(useBoardProvider);
const mockUseOptionalBoardProvider = vi.mocked(useOptionalBoardProvider);

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: 'A test climb',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0
};

const mockSearchParams: SearchRequestPagination = {
  page: 1,
  pageSize: 20,
  gradeAccuracy: 1,
  maxGrade: 18,
  minAscents: 1,
  minGrade: 1,
  minRating: 1,
  sortBy: 'quality',
  sortOrder: 'desc',
  name: '',
  onlyClassics: false,
  onlyTallClimbs: false,
  settername: [],
  setternameSuggestion: '',
  holdsFilter: {},
  hideAttempted: false,
  hideCompleted: false,
  showOnlyAttempted: false,
  showOnlyCompleted: false
};

const mockParsedParams: ParsedBoardRouteParameters = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  angle: 40
};

const mockQueue: ClimbQueue = [];

// Create a wrapper with QueryClientProvider
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'QueryClientWrapper';
  return Wrapper;
};

describe('useQueueDataFetching', () => {
  const mockSetHasDoneFirstFetch = vi.fn();
  const mockGetLogbook = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();

    mockUseBoardProvider.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      isInitialized: true,
      getLogbook: mockGetLogbook,
      logbook: [],
      saveTick: vi.fn(),
      saveClimb: vi.fn(),
      boardName: 'kilter'
    });

    mockUseOptionalBoardProvider.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      isInitialized: true,
      getLogbook: mockGetLogbook,
      logbook: [],
      saveTick: vi.fn(),
      saveClimb: vi.fn(),
      boardName: 'kilter'
    });

    mockUseOptionalBoardProvider.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      isInitialized: true,
      getLogbook: mockGetLogbook,
      logbook: [],
      saveTick: vi.fn(),
      saveClimb: vi.fn(),
      boardName: 'kilter'
    });

    // Mock GraphQL client requests
    mockGraphQLRequest.mockImplementation(async (document) => {
      const query = String(document);

      // Check which query is being made
      if (query.includes('searchClimbs')) {
        // Search climbs query
        return {
          searchClimbs: {
            climbs: [mockClimb],
            totalCount: null,
            hasMore: true
          }
        };
      } else if (query.includes('favorites')) {
        // Favorites query
        return {
          favorites: []
        };
      }

      // Default fallback
      return {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return climb search results and suggested climbs', async () => {
    const { result } = renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.climbSearchResults).toEqual([mockClimb]);
    });

    expect(result.current.suggestedClimbs).toEqual([mockClimb]);
    expect(result.current.totalSearchResultCount).toBe(null); // totalCount is no longer returned by the optimized API
    expect(result.current.hasMoreResults).toBe(true);
  });

  it('should filter out climbs already in queue from suggestions', async () => {
    const queueWithClimb: ClimbQueue = [
      {
        climb: mockClimb,
        addedBy: 'user1',
        uuid: 'queue-item-1',
        suggested: false
      }
    ];

    const { result } = renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: queueWithClimb,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.climbSearchResults).toEqual([mockClimb]);
    });

    expect(result.current.suggestedClimbs).toEqual([]);
  });

  it('should call setHasDoneFirstFetch when first results are available', async () => {
    renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(mockSetHasDoneFirstFetch).toHaveBeenCalled();
    });
  });

  it('should not call setHasDoneFirstFetch if already done', async () => {
    const { result } = renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: true,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.climbSearchResults).toBeDefined();
    });

    expect(mockSetHasDoneFirstFetch).not.toHaveBeenCalled();
  });

  it('should call getLogbook with climb UUIDs', async () => {
    renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(mockGetLogbook).toHaveBeenCalledWith(['climb-1']);
    });
  });

  it('should handle empty search results', async () => {
    mockGraphQLRequest.mockResolvedValue({
      searchClimbs: {
        climbs: [],
        totalCount: null,
        hasMore: false
      }
    });

    const { result } = renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.climbSearchResults).toEqual([]);
    });

    expect(result.current.suggestedClimbs).toEqual([]);
    expect(result.current.totalSearchResultCount).toBe(null); // totalCount is no longer returned
    expect(result.current.hasMoreResults).toBe(false);
  });

  it('should calculate hasMoreResults correctly when there are more results', async () => {
    mockGraphQLRequest.mockResolvedValue({
      searchClimbs: {
        climbs: Array(20).fill(mockClimb),
        totalCount: null,
        hasMore: true
      }
    });

    const { result } = renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.hasMoreResults).toBe(true);
    });
  });

  it('should handle no more results case', async () => {
    mockGraphQLRequest.mockResolvedValue({
      searchClimbs: {
        climbs: Array(10).fill(mockClimb),
        totalCount: null,
        hasMore: false
      }
    });

    const { result } = renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: mockQueue,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.hasMoreResults).toBe(false);
    });
  });

  it('should combine UUIDs from search results and queue', async () => {
    const anotherClimb: Climb = { ...mockClimb, uuid: 'climb-2' };
    const queueWithClimb: ClimbQueue = [
      {
        climb: anotherClimb,
        addedBy: 'user1',
        uuid: 'queue-item-1',
        suggested: false
      }
    ];

    renderHook(
      () =>
        useQueueDataFetching({
          searchParams: mockSearchParams,
          countSearchParams: mockSearchParams,
          queue: queueWithClimb,
          parsedParams: mockParsedParams,
          hasDoneFirstFetch: false,
          setHasDoneFirstFetch: mockSetHasDoneFirstFetch
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(mockGetLogbook).toHaveBeenCalledWith(['climb-1', 'climb-2']);
    });
  });

  describe('SSR initial data hydration', () => {
    const ssrClimb: Climb = { ...mockClimb, uuid: 'ssr-climb-1', name: 'SSR Climb' };

    it('should use SSR initial data and skip the first fetch', async () => {
      mockSSRInitialClimbs.mockReturnValue({
        climbs: [ssrClimb],
        hasMore: true,
      });

      const { result } = renderHook(
        () =>
          useQueueDataFetching({
            searchParams: mockSearchParams,
            countSearchParams: mockSearchParams,
            queue: mockQueue,
            parsedParams: mockParsedParams,
            hasDoneFirstFetch: false,
            setHasDoneFirstFetch: mockSetHasDoneFirstFetch
          }),
        { wrapper: createWrapper() }
      );

      // With SSR initial data, results should be available immediately
      // without waiting for a network fetch
      expect(result.current.climbSearchResults).toEqual([ssrClimb]);
      expect(result.current.hasMoreResults).toBe(true);

      // The GraphQL client should NOT have been called for the initial search
      // because initialData was provided
      expect(mockGraphQLRequest).not.toHaveBeenCalled();

      // Reset mock for cleanup
      mockSSRInitialClimbs.mockReturnValue(null);
    });

    it('should set hasMoreResults=false from SSR data when no more results', async () => {
      mockSSRInitialClimbs.mockReturnValue({
        climbs: [ssrClimb],
        hasMore: false,
      });

      const { result } = renderHook(
        () =>
          useQueueDataFetching({
            searchParams: mockSearchParams,
            countSearchParams: mockSearchParams,
            queue: mockQueue,
            parsedParams: mockParsedParams,
            hasDoneFirstFetch: false,
            setHasDoneFirstFetch: mockSetHasDoneFirstFetch
          }),
        { wrapper: createWrapper() }
      );

      expect(result.current.climbSearchResults).toEqual([ssrClimb]);
      expect(result.current.hasMoreResults).toBe(false);
      expect(mockGraphQLRequest).not.toHaveBeenCalled();

      mockSSRInitialClimbs.mockReturnValue(null);
    });

    it('should fetch normally when no SSR data is available', async () => {
      mockSSRInitialClimbs.mockReturnValue(null);

      const { result } = renderHook(
        () =>
          useQueueDataFetching({
            searchParams: mockSearchParams,
            countSearchParams: mockSearchParams,
            queue: mockQueue,
            parsedParams: mockParsedParams,
            hasDoneFirstFetch: false,
            setHasDoneFirstFetch: mockSetHasDoneFirstFetch
          }),
        { wrapper: createWrapper() }
      );

      // Without SSR data, it should fetch from the API
      await waitFor(() => {
        expect(result.current.climbSearchResults).toEqual([mockClimb]);
      });

      expect(mockGraphQLRequest).toHaveBeenCalled();
    });

    it('should call setHasDoneFirstFetch with SSR initial data', async () => {
      mockSSRInitialClimbs.mockReturnValue({
        climbs: [ssrClimb],
        hasMore: true,
      });

      renderHook(
        () =>
          useQueueDataFetching({
            searchParams: mockSearchParams,
            countSearchParams: mockSearchParams,
            queue: mockQueue,
            parsedParams: mockParsedParams,
            hasDoneFirstFetch: false,
            setHasDoneFirstFetch: mockSetHasDoneFirstFetch
          }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(mockSetHasDoneFirstFetch).toHaveBeenCalled();
      });

      mockSSRInitialClimbs.mockReturnValue(null);
    });
  });

  describe('deferred count query', () => {
    it('should not fire count query when hasDoneFirstFetch is false', async () => {
      const countRequestSpy = vi.fn();
      mockGraphQLRequest.mockImplementation(async (document) => {
        const query = String(document);
        if (query.includes('totalCount') && !query.includes('climbs')) {
          countRequestSpy();
          return { searchClimbs: { totalCount: 100 } };
        }
        return {
          searchClimbs: {
            climbs: [mockClimb],
            totalCount: null,
            hasMore: true,
          },
        };
      });

      const { result } = renderHook(
        () =>
          useQueueDataFetching({
            searchParams: mockSearchParams,
            countSearchParams: mockSearchParams,
            queue: mockQueue,
            parsedParams: mockParsedParams,
            hasDoneFirstFetch: false,
            setHasDoneFirstFetch: mockSetHasDoneFirstFetch,
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.climbSearchResults).toEqual([mockClimb]);
      });

      // Count query should not have fired since hasDoneFirstFetch is false
      expect(result.current.totalSearchResultCount).toBeNull();
    });

    it('should fire count query when hasDoneFirstFetch is true', async () => {
      mockGraphQLRequest.mockImplementation(async (document) => {
        const query = String(document);
        if (query.includes('searchClimbs')) {
          return {
            searchClimbs: {
              climbs: [mockClimb],
              totalCount: 42,
              hasMore: true,
            },
          };
        }
        return {};
      });

      const { result } = renderHook(
        () =>
          useQueueDataFetching({
            searchParams: mockSearchParams,
            countSearchParams: mockSearchParams,
            queue: mockQueue,
            parsedParams: mockParsedParams,
            hasDoneFirstFetch: true,
            setHasDoneFirstFetch: mockSetHasDoneFirstFetch,
          }),
        { wrapper: createWrapper() },
      );

      // With hasDoneFirstFetch=true, the count query should eventually fire
      await waitFor(() => {
        expect(result.current.totalSearchResultCount).toBe(42);
      });
    });
  });
});
