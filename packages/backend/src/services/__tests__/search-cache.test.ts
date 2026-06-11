import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { SearchCacheService, DEFAULT_SEARCH_CACHE_TTL } from '../search-cache';
import { redisClientManager } from '../../redis/client';
import type { ClimbSearchParams, ParsedBoardRouteParameters } from '../../db/queries/climbs/index';
import { logger } from '../../utils/logger';

vi.mock('../../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: vi.fn(),
    getClients: vi.fn(),
  },
}));

const mockedRedis = vi.mocked(redisClientManager);

function makeRouteParams(overrides?: Partial<ParsedBoardRouteParameters>): ParsedBoardRouteParameters {
  return {
    board_name: 'kilter' as ParsedBoardRouteParameters['board_name'],
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2, 3],
    angle: 40,
    ...overrides,
  };
}

describe('SearchCacheService', () => {
  let service: SearchCacheService;

  beforeEach(() => {
    service = new SearchCacheService();
    vi.restoreAllMocks();
  });

  describe('buildCacheKey', () => {
    it('produces deterministic keys regardless of property order', () => {
      const params = makeRouteParams();
      const search1: ClimbSearchParams = { minGrade: 10, maxGrade: 20, page: 1 };
      const search2: ClimbSearchParams = { page: 1, maxGrade: 20, minGrade: 10 };

      const key1 = service.buildCacheKey(params, search1, 'results');
      const key2 = service.buildCacheKey(params, search2, 'results');

      expect(key1).toBe(key2);
    });

    it('produces different keys for different params', () => {
      const params = makeRouteParams();
      const search1: ClimbSearchParams = { page: 1 };
      const search2: ClimbSearchParams = { page: 2 };

      const key1 = service.buildCacheKey(params, search1, 'results');
      const key2 = service.buildCacheKey(params, search2, 'results');

      expect(key1).not.toBe(key2);
    });

    it('excludes undefined values from the hash', () => {
      const params = makeRouteParams();
      const search1: ClimbSearchParams = { page: 1, minGrade: undefined };
      const search2: ClimbSearchParams = { page: 1 };

      const key1 = service.buildCacheKey(params, search1, 'results');
      const key2 = service.buildCacheKey(params, search2, 'results');

      expect(key1).toBe(key2);
    });

    it('sorts set_ids numerically so order does not matter', () => {
      const key1 = service.buildCacheKey(makeRouteParams({ set_ids: [3, 1, 2] }), {}, 'results');
      const key2 = service.buildCacheKey(makeRouteParams({ set_ids: [1, 2, 3] }), {}, 'results');

      expect(key1).toBe(key2);
    });

    it('produces a valid key with empty searchParams', () => {
      const key = service.buildCacheKey(makeRouteParams(), {}, 'results');

      expect(key).toBeTruthy();
      expect(key.startsWith('boardsesh:climb-search:v3:results:')).toBe(true);
    });

    it('matches expected key format', () => {
      const params = makeRouteParams();
      const key = service.buildCacheKey(params, { page: 1 }, 'results');
      const segments = key.split(':');

      // boardsesh:climb-search:version:suffix:board:layout:size:sets:angle:hash
      expect(segments[0]).toBe('boardsesh');
      expect(segments[1]).toBe('climb-search');
      expect(segments[2]).toBe('v3');
      expect(segments[3]).toBe('results');
      expect(segments[4]).toBe('kilter');
      expect(segments[5]).toBe('1');
      expect(segments[6]).toBe('10');
      // segments[7] is the sorted set_ids joined by comma
      expect(segments[7]).toBe('1,2,3');
      expect(segments[8]).toBe('40');
      // segments[9] is the 16-char hex hash
      expect(segments[9]).toMatch(/^[0-9a-f]{16}$/);
      expect(segments).toHaveLength(10);
    });

    it('sorts nested objects recursively for deterministic hashing', () => {
      const params = makeRouteParams();
      const search1: ClimbSearchParams = {
        holdsFilter: { b: { HAND: 'include' }, a: { STARTING: 'include' } },
      };
      const search2: ClimbSearchParams = {
        holdsFilter: { a: { STARTING: 'include' }, b: { HAND: 'include' } },
      };

      const key1 = service.buildCacheKey(params, search1, 'results');
      const key2 = service.buildCacheKey(params, search2, 'results');

      expect(key1).toBe(key2);
    });
  });

  describe('getCachedResult', () => {
    it('returns null when Redis is not connected', async () => {
      mockedRedis.isRedisConnected.mockReturnValue(false);

      const result = await service.getCachedResult('some-key');

      expect(result).toBeNull();
    });

    it('returns parsed JSON on cache hit', async () => {
      const data = { climbs: [{ id: 1 }], total: 5 };
      const mockGet = vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(JSON.stringify(data));
      mockedRedis.isRedisConnected.mockReturnValue(true);
      mockedRedis.getClients.mockReturnValue({
        publisher: { get: mockGet },
      } as unknown as ReturnType<typeof redisClientManager.getClients>);

      const result = await service.getCachedResult<{ climbs: { id: number }[]; total: number }>('test-key');

      expect(result).toEqual(data);
      expect(mockGet).toHaveBeenCalledWith('test-key');
    });

    it('returns null on cache miss', async () => {
      const mockGet = vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null);
      mockedRedis.isRedisConnected.mockReturnValue(true);
      mockedRedis.getClients.mockReturnValue({
        publisher: { get: mockGet },
      } as unknown as ReturnType<typeof redisClientManager.getClients>);

      const result = await service.getCachedResult('missing-key');

      expect(result).toBeNull();
    });

    it('returns null and logs error when Redis throws', async () => {
      const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      const mockGet = vi.fn().mockRejectedValue(new Error('connection lost'));
      mockedRedis.isRedisConnected.mockReturnValue(true);
      mockedRedis.getClients.mockReturnValue({
        publisher: { get: mockGet },
      } as unknown as ReturnType<typeof redisClientManager.getClients>);

      const result = await service.getCachedResult('bad-key');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[SearchCache] Error reading cache key',
        'bad-key',
        expect.objectContaining({ message: 'connection lost' }),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('setCachedResult', () => {
    it('does nothing when Redis is not connected', () => {
      mockedRedis.isRedisConnected.mockReturnValue(false);
      mockedRedis.getClients.mockClear();

      service.setCachedResult('key', { data: true });

      expect(mockedRedis.getClients).not.toHaveBeenCalled(); // eslint-disable-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` concern
    });

    it('calls publisher.set with correct arguments', () => {
      const mockSet = vi.fn().mockResolvedValue('OK');
      mockedRedis.isRedisConnected.mockReturnValue(true);
      mockedRedis.getClients.mockReturnValue({
        publisher: { set: mockSet },
      } as unknown as ReturnType<typeof redisClientManager.getClients>);

      service.setCachedResult('my-key', { foo: 'bar' }, 3600);

      expect(mockSet).toHaveBeenCalledWith('my-key', JSON.stringify({ foo: 'bar' }), 'EX', 3600);
    });

    it('uses default TTL when not specified', () => {
      const mockSet = vi.fn().mockResolvedValue('OK');
      mockedRedis.isRedisConnected.mockReturnValue(true);
      mockedRedis.getClients.mockReturnValue({
        publisher: { set: mockSet },
      } as unknown as ReturnType<typeof redisClientManager.getClients>);

      service.setCachedResult('my-key', [1, 2, 3]);

      expect(mockSet).toHaveBeenCalledWith('my-key', JSON.stringify([1, 2, 3]), 'EX', DEFAULT_SEARCH_CACHE_TTL);
    });

    it('catches and logs errors from publisher.set', async () => {
      const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      const setError = new Error('write failed');
      const mockSet = vi.fn().mockRejectedValue(setError);
      mockedRedis.isRedisConnected.mockReturnValue(true);
      mockedRedis.getClients.mockReturnValue({
        publisher: { set: mockSet },
      } as unknown as ReturnType<typeof redisClientManager.getClients>);

      service.setCachedResult('fail-key', 'data');

      // The .catch handler is async, so flush microtasks
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('[SearchCache] Error writing cache key', 'fail-key', setError);
      });

      consoleSpy.mockRestore();
    });
  });
});
