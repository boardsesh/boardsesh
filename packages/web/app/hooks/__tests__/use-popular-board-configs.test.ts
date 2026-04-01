import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { PopularBoardConfig, PopularBoardConfigConnection } from '@boardsesh/shared-schema';
import { createQueryWrapper } from '@/app/test-utils/test-providers';

// --- Mocks ---

const mockRequest = vi.fn();

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/lib/graphql/operations', () => ({
  GET_POPULAR_BOARD_CONFIGS: 'GET_POPULAR_BOARD_CONFIGS_QUERY',
}));

// --- Import after mocks ---

import { usePopularBoardConfigs } from '../use-popular-board-configs';

// --- Helpers ---

function makeConfig(
  boardType: string,
  climbCount: number,
  overrides?: Partial<PopularBoardConfig>,
): PopularBoardConfig {
  return {
    boardType,
    layoutId: 1,
    layoutName: `Layout for ${boardType}`,
    sizeId: 10,
    sizeName: `Size 10`,
    sizeDescription: `10x10`,
    setIds: [1, 2],
    setNames: ['Set A', 'Set B'],
    climbCount,
    totalAscents: climbCount * 10,
    displayName: `Layout ${boardType} Size 10`,
    ...overrides,
  };
}

function makeResponse(
  configs: PopularBoardConfig[],
  hasMore: boolean,
): { popularBoardConfigs: PopularBoardConfigConnection } {
  return {
    popularBoardConfigs: {
      configs,
      totalCount: configs.length,
      hasMore,
    },
  };
}

// --- Tests ---

describe('usePopularBoardConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns isLoading=true and empty configs initially', () => {
    mockRequest.mockReturnValue(new Promise(() => {}));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isFetchingNextPage).toBe(false);
    expect(result.current.configs).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasNextPage).toBe(false);
  });

  it('fetches first page on mount and sets configs/hasNextPage correctly', async () => {
    const page1 = [
      makeConfig('kilter', 500),
      makeConfig('tension', 300),
    ];
    mockRequest.mockResolvedValueOnce(makeResponse(page1, true));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.configs).toHaveLength(2);
    expect(result.current.configs[0].boardType).toBe('kilter');
    expect(result.current.configs[1].boardType).toBe('tension');
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('passes limit and offset=0 to the initial request', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse([], false));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ limit: 5 }), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(
      'GET_POPULAR_BOARD_CONFIGS_QUERY',
      { input: { limit: 5, offset: 0 } },
    );
  });

  it('uses default limit of 7 when none provided', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse([], false));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockRequest).toHaveBeenCalledWith(
      'GET_POPULAR_BOARD_CONFIGS_QUERY',
      { input: { limit: 7, offset: 0 } },
    );
  });

  it('fetchNextPage fetches next page and appends to existing configs', async () => {
    const page1 = [makeConfig('kilter', 500), makeConfig('tension', 300)];
    const page2 = [makeConfig('moonboard', 200), makeConfig('decoy', 100)];

    mockRequest.mockResolvedValueOnce(makeResponse(page1, true));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ limit: 2 }), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.configs).toHaveLength(2);
    expect(result.current.hasNextPage).toBe(true);

    mockRequest.mockResolvedValueOnce(makeResponse(page2, false));

    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(result.current.configs).toHaveLength(4);
    });

    expect(result.current.configs[0].boardType).toBe('kilter');
    expect(result.current.configs[1].boardType).toBe('tension');
    expect(result.current.configs[2].boardType).toBe('moonboard');
    expect(result.current.configs[3].boardType).toBe('decoy');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('passes correct offset for subsequent pages', async () => {
    const page1 = [makeConfig('a', 100), makeConfig('b', 90), makeConfig('c', 80)];
    mockRequest.mockResolvedValueOnce(makeResponse(page1, true));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ limit: 3 }), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const page2 = [makeConfig('d', 70)];
    mockRequest.mockResolvedValueOnce(makeResponse(page2, false));

    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(result.current.configs).toHaveLength(4);
    });

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest).toHaveBeenNthCalledWith(2, 'GET_POPULAR_BOARD_CONFIGS_QUERY', {
      input: { limit: 3, offset: 3 },
    });
  });

  it('sets error when initial fetch fails', async () => {
    mockRequest.mockRejectedValue(new Error('Network error'));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Failed to load board configurations');
    expect(result.current.configs).toEqual([]);
  });

  it('handles empty results from backend', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse([], false));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.configs).toEqual([]);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('supports multiple pagination cycles', async () => {
    const page1 = [makeConfig('a', 100)];
    const page2 = [makeConfig('b', 90)];
    const page3 = [makeConfig('c', 80)];

    mockRequest.mockResolvedValueOnce(makeResponse(page1, true));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ limit: 1 }), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.configs).toHaveLength(1);

    // Page 2
    mockRequest.mockResolvedValueOnce(makeResponse(page2, true));
    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.configs).toHaveLength(2);
    });
    expect(result.current.hasNextPage).toBe(true);

    // Page 3 (last page)
    mockRequest.mockResolvedValueOnce(makeResponse(page3, false));
    act(() => {
      result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.configs).toHaveLength(3);
    });
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.configs.map((c: PopularBoardConfig) => c.boardType)).toEqual(['a', 'b', 'c']);
  });

  // --- initialData (SSR) tests ---

  it('skips initial fetch when initialData is provided', async () => {
    const ssrData = [makeConfig('kilter', 500), makeConfig('tension', 300)];
    const wrapper = createQueryWrapper();

    renderHook(() => usePopularBoardConfigs({ initialData: ssrData }), { wrapper });

    // Wait a tick to ensure no async fetch fires
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('starts with isLoading=false and configs populated from initialData', () => {
    const ssrData = [makeConfig('kilter', 500), makeConfig('tension', 300)];
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ initialData: ssrData }), { wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.configs).toHaveLength(2);
    expect(result.current.configs[0].boardType).toBe('kilter');
    expect(result.current.configs[1].boardType).toBe('tension');
    // 2 items < default limit of 7, so hasNextPage is false (server returned everything)
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetchNextPage uses correct offset from initialData length', async () => {
    const ssrData = [makeConfig('kilter', 500), makeConfig('tension', 300), makeConfig('moonboard', 200)];
    const page2 = [makeConfig('decoy', 100)];
    mockRequest.mockResolvedValueOnce(makeResponse(page2, false));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ limit: 3, initialData: ssrData }), { wrapper });

    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(result.current.configs).toHaveLength(4);
    });

    // Offset should be 3 (initialData.length)
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('GET_POPULAR_BOARD_CONFIGS_QUERY', {
      input: { limit: 3, offset: 3 },
    });

    expect(result.current.configs[3].boardType).toBe('decoy');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('treats empty initialData array as no initial data and fetches', async () => {
    mockRequest.mockResolvedValueOnce(makeResponse([makeConfig('kilter', 500)], false));
    const wrapper = createQueryWrapper();

    const { result } = renderHook(() => usePopularBoardConfigs({ initialData: [] }), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(result.current.configs).toHaveLength(1);
  });
});
