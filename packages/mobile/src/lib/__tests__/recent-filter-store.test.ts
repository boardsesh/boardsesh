import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFilterKey } from '../filter-key';
import type { ClimbFilters } from '../climb-filter-types';

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  return {
    getItemAsync: vi.fn(async (key: string) => storage[key] ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      storage[key] = value;
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      delete storage[key];
    }),
    __reset: () => {
      storage = {};
    },
  };
});

const defaultFilters: ClimbFilters = {
  sortBy: 'popular',
  sortOrder: 'desc',
  status: 'any',
};

describe('getFilterKey', () => {
  it('produces a stable key regardless of property insertion order', () => {
    const filtersA: ClimbFilters = { sortBy: 'popular', sortOrder: 'desc', status: 'any', minGrade: 10 };
    const filtersB: ClimbFilters = { minGrade: 10, sortOrder: 'desc', sortBy: 'popular', status: 'any' };
    expect(getFilterKey(filtersA, '')).toBe(getFilterKey(filtersB, ''));
  });

  it('includes search text in the key', () => {
    const keyWithText = getFilterKey(defaultFilters, 'hello');
    const keyWithoutText = getFilterKey(defaultFilters, '');
    expect(keyWithText).not.toBe(keyWithoutText);
  });

  it('differentiates filters with different values', () => {
    const filtersA: ClimbFilters = { ...defaultFilters, minGrade: 5 };
    const filtersB: ClimbFilters = { ...defaultFilters, minGrade: 10 };
    expect(getFilterKey(filtersA, '')).not.toBe(getFilterKey(filtersB, ''));
  });

  it('treats undefined optional fields as absent', () => {
    const filtersA: ClimbFilters = { sortBy: 'popular', sortOrder: 'desc', status: 'any' };
    const filtersB: ClimbFilters = { sortBy: 'popular', sortOrder: 'desc', status: 'any', minGrade: undefined };
    expect(getFilterKey(filtersA, '')).toBe(getFilterKey(filtersB, ''));
  });

  it('returns valid JSON', () => {
    const key = getFilterKey(defaultFilters, 'test');
    expect(() => JSON.parse(key)).not.toThrow();
  });
});

describe('getRecentFilters sanitizer', () => {
  beforeEach(async () => {
    const store = await import('expo-secure-store');
    (store as unknown as { __reset: () => void }).__reset();
  });

  async function seed(entries: unknown[]) {
    const store = await import('expo-secure-store');
    await store.setItemAsync('boardsesh_recent_filters', JSON.stringify(entries));
  }

  it('drops entries whose sortBy is not a known SortOption', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: '1',
        label: 'legacy',
        filters: { sortBy: 'newest', sortOrder: 'desc', status: 'any' },
        searchText: '',
        timestamp: 0,
      },
      {
        id: '2',
        label: 'ok',
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any' },
        searchText: '',
        timestamp: 1,
      },
    ]);
    const result = await getRecentFilters();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('2');
  });

  it('drops entries whose status is not a known StatusFilter', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: 'bad',
        label: 'x',
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'mystery' },
        searchText: '',
        timestamp: 0,
      },
    ]);
    expect(await getRecentFilters()).toHaveLength(0);
  });

  it('returns an empty array if storage value is not an array', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed({ foo: 'bar' } as unknown as unknown[]);
    expect(await getRecentFilters()).toEqual([]);
  });

  it('strips auth-gated fields when isAuthenticated=false', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: '1',
        label: 'gated',
        filters: {
          sortBy: 'ascents',
          sortOrder: 'desc',
          status: 'any',
          hideAttempted: true,
          showOnlyCompleted: true,
          minGrade: 10,
        },
        searchText: '',
        timestamp: 0,
      },
    ]);
    const result = await getRecentFilters({ isAuthenticated: false });
    expect(result[0]?.filters).not.toHaveProperty('hideAttempted');
    expect(result[0]?.filters).not.toHaveProperty('showOnlyCompleted');
    expect(result[0]?.filters.minGrade).toBe(10);
  });

  it('normalizes entries missing status (legacy app versions) to status="any"', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: '1',
        label: 'pre-status',
        filters: { sortBy: 'ascents', sortOrder: 'desc', minGrade: 10 },
        searchText: '',
        timestamp: 0,
      },
    ]);
    const result = await getRecentFilters();
    expect(result).toHaveLength(1);
    expect(result[0]?.filters.status).toBe('any');
  });

  it('strips the legacy implicit boulders-only default from unversioned entries', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: '1',
        label: 'legacy-boulders-default',
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', boulders: true, routes: false, minGrade: 10 },
        searchText: '',
        timestamp: 0,
      },
    ]);
    const result = await getRecentFilters();
    expect(result[0]?.filters.minGrade).toBe(10);
    expect(result[0]?.filters.boulders).toBeUndefined();
    expect(result[0]?.filters.routes).toBeUndefined();
  });

  it('keeps explicit boulders-only filters from current-schema entries', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: '1',
        label: 'Boulders',
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', boulders: true, routes: false },
        searchText: '',
        timestamp: 0,
        filterSchemaVersion: 2,
      },
    ]);
    const result = await getRecentFilters();
    expect(result[0]?.filters.boulders).toBe(true);
    expect(result[0]?.filters.routes).toBe(false);
  });

  it('keeps auth-gated fields when isAuthenticated=true', async () => {
    const { getRecentFilters } = await import('../recent-filter-store');
    await seed([
      {
        id: '1',
        label: 'gated',
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', hideAttempted: true },
        searchText: '',
        timestamp: 0,
      },
    ]);
    const result = await getRecentFilters({ isAuthenticated: true });
    expect(result[0]?.filters.hideAttempted).toBe(true);
  });
});
