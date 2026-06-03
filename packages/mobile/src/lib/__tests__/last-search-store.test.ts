import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
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
    __raw: () => storage,
  };
});

const STORE_KEY = 'boardsesh_last_search_by_board';

const kilterBoard: BoardSearchConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  angle: 40,
};

const tensionBoard: BoardSearchConfig = {
  boardName: 'tension',
  layoutId: 9,
  sizeId: 3,
  setIds: '5',
  angle: 30,
};

const defaultFilters: ClimbFilters = {
  sortBy: 'ascents',
  sortOrder: 'desc',
  status: 'any',
};

const activeFilters: ClimbFilters = {
  sortBy: 'quality',
  sortOrder: 'desc',
  status: 'any',
  minGrade: 15,
};

async function resetStore() {
  const store = await import('expo-secure-store');
  (store as unknown as { __reset: () => void }).__reset();
}

async function rawStorage(): Promise<Record<string, string>> {
  const store = await import('expo-secure-store');
  return (store as unknown as { __raw: () => Record<string, string> }).__raw();
}

async function seedRaw(map: unknown) {
  const store = await import('expo-secure-store');
  await store.setItemAsync(STORE_KEY, JSON.stringify(map));
}

describe('boardConfigKey', () => {
  it('produces distinct keys for different board configs', async () => {
    const { boardConfigKey } = await import('../last-search-store');
    expect(boardConfigKey(kilterBoard)).not.toBe(boardConfigKey(tensionBoard));
  });

  it('produces identical keys for identical configs', async () => {
    const { boardConfigKey } = await import('../last-search-store');
    expect(boardConfigKey(kilterBoard)).toBe(boardConfigKey({ ...kilterBoard }));
  });

  it('differentiates configs that differ only by angle', async () => {
    const { boardConfigKey } = await import('../last-search-store');
    expect(boardConfigKey(kilterBoard)).not.toBe(boardConfigKey({ ...kilterBoard, angle: 45 }));
  });
});

describe('saveLastSearch / getLastSearch', () => {
  beforeEach(resetStore);

  it('round-trips a saved search for a board', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    const restored = await getLastSearch(kilterBoard);
    expect(restored?.filters).toEqual(activeFilters);
    expect(restored?.searchText).toBe('crimps');
    expect(typeof restored?.updatedAt).toBe('number');
  });

  it('returns null for a board that has never been searched', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    expect(await getLastSearch(tensionBoard)).toBeNull();
  });

  it('returns null when storage is empty', async () => {
    const { getLastSearch } = await import('../last-search-store');
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('keeps two different board configs isolated', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(tensionBoard, { ...defaultFilters, sortBy: 'name' }, 'slopers');

    const kilter = await getLastSearch(kilterBoard);
    const tension = await getLastSearch(tensionBoard);
    expect(kilter?.searchText).toBe('crimps');
    expect(kilter?.filters.minGrade).toBe(15);
    expect(tension?.searchText).toBe('slopers');
    expect(tension?.filters.sortBy).toBe('name');
  });

  it('overwrites the previous search for the same board', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(kilterBoard, { ...defaultFilters, sortBy: 'quality' }, 'jugs');
    const restored = await getLastSearch(kilterBoard);
    expect(restored?.searchText).toBe('jugs');
    expect(restored?.filters.minGrade).toBeUndefined();
  });
});

describe('saveLastSearch no-op on default/empty', () => {
  beforeEach(resetStore);

  it('does not persist when filters are default and search text is empty', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, defaultFilters, '');
    expect(await getLastSearch(kilterBoard)).toBeNull();
    expect(Object.keys(await rawStorage())).not.toContain(STORE_KEY);
  });

  it('does not persist when filters are default and search text is whitespace only', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, defaultFilters, '   ');
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('persists when only search text is set', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, defaultFilters, 'overhang');
    expect((await getLastSearch(kilterBoard))?.searchText).toBe('overhang');
  });

  it('persists when only filters are active', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, '');
    expect((await getLastSearch(kilterBoard))?.filters.minGrade).toBe(15);
  });

  it('deletes the saved entry when the search is reset to the clean default', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    expect(await getLastSearch(kilterBoard)).not.toBeNull();
    // Clearing back to default must erase the entry, not leave a stale one.
    await saveLastSearch(kilterBoard, defaultFilters, '');
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('clearing one board leaves other boards untouched', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(tensionBoard, activeFilters, 'slopers');
    await saveLastSearch(kilterBoard, defaultFilters, '');
    expect(await getLastSearch(kilterBoard)).toBeNull();
    expect((await getLastSearch(tensionBoard))?.searchText).toBe('slopers');
  });
});

describe('getLastSearch defensive validation', () => {
  beforeEach(resetStore);

  it('returns null when the stored value is not an object map', async () => {
    const { getLastSearch } = await import('../last-search-store');
    await seedRaw([1, 2, 3]);
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('drops malformed entries with an unknown sortBy', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'newest', sortOrder: 'desc', status: 'any' },
        searchText: 'x',
        updatedAt: 1,
      },
    });
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('drops malformed entries with an unknown status', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'mystery' },
        searchText: 'x',
        updatedAt: 1,
      },
    });
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('drops entries missing searchText or updatedAt', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any' },
      },
    });
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('normalizes a missing status (legacy entry) to "any"', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'ascents', sortOrder: 'desc', minGrade: 10 },
        searchText: 'x',
        updatedAt: 1,
      },
    });
    const restored = await getLastSearch(kilterBoard);
    expect(restored?.filters.status).toBe('any');
    expect(restored?.filters.minGrade).toBe(10);
  });

  it('keeps valid entries while dropping malformed siblings', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'bogus', sortOrder: 'desc', status: 'any' },
        searchText: 'x',
        updatedAt: 1,
      },
      [boardConfigKey(tensionBoard)]: {
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any' },
        searchText: 'good',
        updatedAt: 2,
      },
    });
    expect(await getLastSearch(kilterBoard)).toBeNull();
    expect((await getLastSearch(tensionBoard))?.searchText).toBe('good');
  });
});

describe('getLastSearch auth-gated stripping', () => {
  beforeEach(resetStore);

  it('strips auth-gated fields when isAuthenticated=false', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, { ...activeFilters, hideAttempted: true, showOnlyCompleted: true }, 'crimps');
    const restored = await getLastSearch(kilterBoard, { isAuthenticated: false });
    expect(restored?.filters).not.toHaveProperty('hideAttempted');
    expect(restored?.filters).not.toHaveProperty('showOnlyCompleted');
    expect(restored?.filters.minGrade).toBe(15);
  });

  it('keeps auth-gated fields when isAuthenticated=true', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, { ...activeFilters, hideAttempted: true }, 'crimps');
    const restored = await getLastSearch(kilterBoard, { isAuthenticated: true });
    expect(restored?.filters.hideAttempted).toBe(true);
  });
});

describe('map cap eviction', () => {
  beforeEach(resetStore);

  it('keeps only the 20 most-recently-updated boards', async () => {
    const { saveLastSearch, getLastSearch, boardConfigKey } = await import('../last-search-store');
    // Force a strictly increasing clock so eviction order is deterministic
    // even when saves land within the same real millisecond.
    let clock = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1));
    // Persist 25 distinct boards; updatedAt increases with each save.
    const boards: BoardSearchConfig[] = [];
    for (let index = 0; index < 25; index += 1) {
      const board: BoardSearchConfig = { ...kilterBoard, angle: index };
      boards.push(board);
      await saveLastSearch(board, activeFilters, `q${index}`);
    }
    nowSpy.mockRestore();

    const stored: unknown = JSON.parse((await rawStorage())[STORE_KEY]);
    expect(Object.keys(stored as Record<string, unknown>)).toHaveLength(20);

    // The 5 oldest boards (angles 0-4) should be evicted.
    expect(await getLastSearch(boards[0])).toBeNull();
    expect(await getLastSearch(boards[4])).toBeNull();
    // The newest boards survive.
    expect((await getLastSearch(boards[24]))?.searchText).toBe('q24');
    expect((await getLastSearch(boards[5]))?.searchText).toBe('q5');
    expect(boardConfigKey(boards[24])).toContain('|24');
  });
});

describe('clearLastSearch / clearAllLastSearches', () => {
  beforeEach(resetStore);

  it('clears only the targeted board', async () => {
    const { saveLastSearch, getLastSearch, clearLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(tensionBoard, activeFilters, 'slopers');
    await clearLastSearch(kilterBoard);
    expect(await getLastSearch(kilterBoard)).toBeNull();
    expect((await getLastSearch(tensionBoard))?.searchText).toBe('slopers');
  });

  it('is a no-op clearing a board that was never saved', async () => {
    const { saveLastSearch, getLastSearch, clearLastSearch } = await import('../last-search-store');
    await saveLastSearch(tensionBoard, activeFilters, 'slopers');
    await clearLastSearch(kilterBoard);
    expect((await getLastSearch(tensionBoard))?.searchText).toBe('slopers');
  });

  it('clears every board', async () => {
    const { saveLastSearch, getLastSearch, clearAllLastSearches } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(tensionBoard, activeFilters, 'slopers');
    await clearAllLastSearches();
    expect(await getLastSearch(kilterBoard)).toBeNull();
    expect(await getLastSearch(tensionBoard)).toBeNull();
  });
});

describe('saveLastSearch / getLastSearch board filters', () => {
  beforeEach(resetStore);

  it('round-trips board filters (benchmark) for a board', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps', { onlyBenchmarks: true });
    const restored = await getLastSearch(kilterBoard);
    expect(restored?.boardFilters.onlyBenchmarks).toBe(true);
  });

  it('persists a benchmark-only search (no climb filters, no text)', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, defaultFilters, '', { onlyBenchmarks: true });
    expect((await getLastSearch(kilterBoard))?.boardFilters.onlyBenchmarks).toBe(true);
  });

  it('deletes the entry when board filters also clear back to default', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, defaultFilters, '', { onlyBenchmarks: true });
    expect(await getLastSearch(kilterBoard)).not.toBeNull();
    await saveLastSearch(kilterBoard, defaultFilters, '', {});
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('defaults boardFilters to {} for entries written before the field existed', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', minGrade: 18 },
        searchText: 'x',
        updatedAt: 1,
      },
    });
    const restored = await getLastSearch(kilterBoard);
    expect(restored?.boardFilters).toEqual({});
  });
});
