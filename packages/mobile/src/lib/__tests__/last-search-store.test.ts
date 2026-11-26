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

  it('keeps the whole search, name and board filters included, at another angle of the same board', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps', { onlyBenchmarks: true });
    const restored = await getLastSearch({ ...kilterBoard, angle: 25 });
    expect(restored?.filters).toEqual(activeFilters);
    expect(restored?.searchText).toBe('crimps');
    expect(restored?.boardFilters).toEqual({ onlyBenchmarks: true });
  });

  it('carries the filters to another board but clears the name and the hold and zone picks', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps', {
      onlyBenchmarks: true,
      holdsFilter: { hold_5: { HAND: 'include' } },
      zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 },
      zoneMode: 'anyHold',
    });
    const restored = await getLastSearch(tensionBoard);
    expect(restored?.filters).toEqual(activeFilters);
    expect(restored?.searchText).toBe('');
    expect(restored?.boardFilters).toEqual({ onlyBenchmarks: true });
  });

  it('treats another set of holds on the same layout as another board', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    expect((await getLastSearch({ ...kilterBoard, setIds: '1' }))?.searchText).toBe('');
  });

  it('returns null when storage is empty', async () => {
    const { getLastSearch } = await import('../last-search-store');
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('keeps one search: a save on another board replaces the earlier one', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(tensionBoard, { ...defaultFilters, sortBy: 'name' }, 'slopers');

    const kilter = await getLastSearch(kilterBoard);
    const tension = await getLastSearch(tensionBoard);
    expect(kilter?.filters.sortBy).toBe('name');
    expect(kilter?.searchText).toBe('');
    expect(tension?.searchText).toBe('slopers');
    expect(Object.keys(JSON.parse((await rawStorage())[STORE_KEY]))).toEqual(['latest']);
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

  // The Other angles switch is its own filter: a Woods search with only it on
  // must come back on return, not be deleted as a clean default.
  it('persists when only the other-angles switch is on', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    const woodsBoard: BoardSearchConfig = { boardName: 'woods', layoutId: 1, sizeId: 1, setIds: '1', angle: 30 };
    await saveLastSearch(woodsBoard, { ...defaultFilters, includeOtherAngles: true }, '');
    expect((await getLastSearch(woodsBoard))?.filters.includeOtherAngles).toBe(true);
  });

  it('deletes the saved entry when the search is reset to the clean default', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    expect(await getLastSearch(kilterBoard)).not.toBeNull();
    // Clearing back to default must erase the entry, not leave a stale one.
    await saveLastSearch(kilterBoard, defaultFilters, '');
    expect(await getLastSearch(kilterBoard)).toBeNull();
  });

  it('clearing on any board clears the one saved search', async () => {
    const { saveLastSearch, getLastSearch } = await import('../last-search-store');
    await saveLastSearch(kilterBoard, activeFilters, 'crimps');
    await saveLastSearch(tensionBoard, defaultFilters, '');
    expect(await getLastSearch(kilterBoard)).toBeNull();
    expect(await getLastSearch(tensionBoard)).toBeNull();
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
    expect((await getLastSearch(kilterBoard))?.searchText).toBe('');
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

describe('per-board maps written by older app versions', () => {
  beforeEach(resetStore);

  it('restores the newest entry, with its name only on the board it was typed on', async () => {
    const { boardConfigKey, getLastSearch } = await import('../last-search-store');
    await seedRaw({
      [boardConfigKey(kilterBoard)]: {
        filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', minGrade: 12 },
        searchText: 'old',
        updatedAt: 1,
      },
      [boardConfigKey(tensionBoard)]: {
        filters: { sortBy: 'quality', sortOrder: 'desc', status: 'any', minGrade: 20 },
        searchText: 'newest',
        boardFilters: { holdsFilter: { hold_5: { HAND: 'include' } } },
        updatedAt: 2,
      },
    });
    const onTension = await getLastSearch({ ...tensionBoard, angle: 50 });
    expect(onTension?.filters.minGrade).toBe(20);
    expect(onTension?.searchText).toBe('newest');
    expect(onTension?.boardFilters).toEqual({ holdsFilter: { hold_5: { HAND: 'include' } } });
    const onKilter = await getLastSearch(kilterBoard);
    expect(onKilter?.filters.minGrade).toBe(20);
    expect(onKilter?.searchText).toBe('');
    expect(onKilter?.boardFilters).toEqual({});
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
