// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  let writes = 0;
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        writes += 1;
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
        writes = 0;
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
      __getRaw: (key: string) => storage[key] ?? null,
      __keys: () => Object.keys(storage),
      __writes: () => writes,
    },
  };
});

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    __getRaw: (key: string) => string | null;
    __keys: () => string[];
    __writes: () => number;
  };
}

type FruitKind = 'apple' | 'banana' | 'cherry';
const FRUIT_CATALOG: readonly FruitKind[] = ['apple', 'banana', 'cherry'];

async function makeStores() {
  const { createPinnedChipsStore } = await import('../pinned-chips-store');
  const fruit = createPinnedChipsStore<FruitKind>({
    storageKey: 'pinnedFruitChips',
    catalog: FRUIT_CATALOG,
    defaults: ['apple', 'cherry'],
  });
  const colours = createPinnedChipsStore<'red' | 'blue'>({
    storageKey: 'pinnedColourChips',
    catalog: ['red', 'blue'],
    defaults: ['blue'],
  });
  return { fruit, colours };
}

describe('createPinnedChipsStore', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getMockStorage()).__reset();
  });

  it('starts at its defaults and falls back to them for an empty or garbage payload', async () => {
    const storage = await getMockStorage();
    const { fruit } = await makeStores();
    expect(await fruit.load()).toEqual(['apple', 'cherry']);

    storage.__setRaw('pinnedFruitChips', JSON.stringify([]));
    fruit.resetForTests();
    expect(await fruit.load()).toEqual(['apple', 'cherry']);

    storage.__setRaw('pinnedFruitChips', JSON.stringify({ not: 'an array' }));
    fruit.resetForTests();
    expect(await fruit.load()).toEqual(['apple', 'cherry']);
  });

  it('by default drops unknown and duplicate kinds and keeps the saved order', async () => {
    (await getMockStorage()).__setRaw('pinnedFruitChips', JSON.stringify(['cherry', 'durian', 'apple', 'cherry']));
    const { fruit } = await makeStores();
    expect(await fruit.load()).toEqual(['cherry', 'apple']);
  });

  it('persists under its own key only, a new pin last', async () => {
    const storage = await getMockStorage();
    const { fruit } = await makeStores();
    expect(fruit.storageKey).toBe('pinnedFruitChips');
    expect(fruit.catalog).toEqual(FRUIT_CATALOG);
    expect(fruit.defaults).toEqual(['apple', 'cherry']);
    await fruit.toggle('banana');
    expect(storage.__keys()).toEqual(['pinnedFruitChips']);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['apple', 'cherry', 'banana']);
  });

  it('keeps the order through set and a reload', async () => {
    const storage = await getMockStorage();
    const { fruit } = await makeStores();
    await fruit.set(['cherry', 'banana', 'apple']);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['cherry', 'banana', 'apple']);
    fruit.resetForTests();
    expect(await fruit.load()).toEqual(['cherry', 'banana', 'apple']);
  });

  it('moves a pinned kind one place and persists it, and leaves the ends and unpinned kinds alone', async () => {
    const storage = await getMockStorage();
    const { fruit } = await makeStores();
    await fruit.set(['apple', 'banana', 'cherry']);
    await fruit.move('cherry', -1);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['apple', 'cherry', 'banana']);
    await fruit.move('apple', 1);
    expect(await fruit.load()).toEqual(['cherry', 'apple', 'banana']);

    const writesBefore = storage.__writes();
    await fruit.move('cherry', -1);
    await fruit.move('banana', 1);
    await fruit.toggle('banana');
    await fruit.move('banana', -1);
    expect(await fruit.load()).toEqual(['cherry', 'apple']);
    // Only the toggle wrote: a move that goes nowhere writes nothing.
    expect(storage.__writes()).toBe(writesBefore + 1);
  });

  it('moves the SAVED order when a move lands during the load window', async () => {
    const storage = await getMockStorage();
    storage.__setRaw('pinnedFruitChips', JSON.stringify(['banana', 'cherry']));
    const { fruit } = await makeStores();
    // No load first: the snapshot is still the defaults (apple, cherry).
    await fruit.move('cherry', -1);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['cherry', 'banana']);
  });

  it('keeps two stores independent: state, storage and listeners', async () => {
    const storage = await getMockStorage();
    const { fruit, colours } = await makeStores();
    const fruitRenders = vi.fn();
    const colourRenders = vi.fn();
    const fruitHook = renderHook(() => {
      fruitRenders();
      return fruit.usePinnedChips();
    });
    const colourHook = renderHook(() => {
      colourRenders();
      return colours.usePinnedChips();
    });
    await waitFor(() => expect(fruitHook.result.current.loaded).toBe(true));
    await waitFor(() => expect(colourHook.result.current.loaded).toBe(true));
    const colourRendersBefore = colourRenders.mock.calls.length;
    const fruitRendersBefore = fruitRenders.mock.calls.length;

    await act(async () => {
      fruitHook.result.current.togglePin('banana');
    });
    await waitFor(() => expect(fruitHook.result.current.pinned).toEqual(['apple', 'cherry', 'banana']));
    expect(fruitHook.result.current.isPinned('banana')).toBe(true);
    expect(fruitRenders.mock.calls.length).toBeGreaterThan(fruitRendersBefore);

    // The other store never heard about it.
    expect(colourRenders.mock.calls.length).toBe(colourRendersBefore);
    expect(colourHook.result.current.pinned).toEqual(['blue']);
    expect(await colours.load()).toEqual(['blue']);
    expect(storage.__getRaw('pinnedColourChips')).toBeNull();
  });

  it('runs a custom normalize on load and on set, and persists through toStored', async () => {
    const storage = await getMockStorage();
    storage.__setRaw('pinnedFruitChips', JSON.stringify(['fig', 'cherry']));
    const { createPinnedChipsStore } = await import('../pinned-chips-store');
    // A retired 'fig' pin becomes 'banana'; the payload carries a version marker.
    const normalize = vi.fn((stored: readonly unknown[]): FruitKind[] => {
      const expanded = new Set(stored.map((kind) => (kind === 'fig' ? 'banana' : kind)));
      return FRUIT_CATALOG.filter((kind) => expanded.has(kind));
    });
    const store = createPinnedChipsStore<FruitKind>({
      storageKey: 'pinnedFruitChips',
      catalog: FRUIT_CATALOG,
      defaults: ['apple'],
      normalize,
      toStored: (kinds) => ['v2', ...kinds],
    });
    expect(await store.load()).toEqual(['banana', 'cherry']);
    await store.set(['cherry', 'fig' as unknown as FruitKind]);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['v2', 'banana', 'cherry']);
  });

  it('runs fromStored on load only; set and toggle keep using normalize', async () => {
    const storage = await getMockStorage();
    storage.__setRaw('pinnedFruitChips', JSON.stringify(['apple']));
    const { createPinnedChipsStore } = await import('../pinned-chips-store');
    // A load-only migration: a payload without 'banana' gains it.
    const fromStored = vi.fn((stored: readonly unknown[]): FruitKind[] => {
      const storedKinds = new Set([...stored, 'banana']);
      return FRUIT_CATALOG.filter((kind) => storedKinds.has(kind));
    });
    const store = createPinnedChipsStore<FruitKind>({
      storageKey: 'pinnedFruitChips',
      catalog: FRUIT_CATALOG,
      defaults: ['cherry'],
      fromStored,
    });
    expect(await store.load()).toEqual(['apple', 'banana']);
    expect(fromStored).toHaveBeenCalledTimes(1);

    // Unpinning 'banana' must stick: set and toggle never re-run the migration.
    await store.toggle('banana');
    expect(fromStored).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['apple']);
    const hook = renderHook(() => store.usePinnedChips());
    expect(hook.result.current.pinned).toEqual(['apple']);
  });

  it('falls back to the defaults when fromStored returns nothing', async () => {
    (await getMockStorage()).__setRaw('pinnedFruitChips', JSON.stringify(['apple']));
    const { createPinnedChipsStore } = await import('../pinned-chips-store');
    const store = createPinnedChipsStore<FruitKind>({
      storageKey: 'pinnedFruitChips',
      catalog: FRUIT_CATALOG,
      defaults: ['cherry'],
      fromStored: () => [],
    });
    expect(await store.load()).toEqual(['cherry']);
  });

  it('keeps togglePin referentially stable across renders', async () => {
    const { fruit } = await makeStores();
    const hook = renderHook(() => fruit.usePinnedChips());
    const firstToggle = hook.result.current.togglePin;
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    hook.rerender();
    expect(hook.result.current.togglePin).toBe(firstToggle);
  });
});

describe('pin list helpers', () => {
  it('pins a kind last and unpins it, returning the same list when nothing changes', async () => {
    const { withChipPinned } = await import('../pinned-chips-store');
    const pinned: readonly FruitKind[] = ['cherry', 'apple'];
    expect(withChipPinned(pinned, 'banana', true)).toEqual(['cherry', 'apple', 'banana']);
    expect(withChipPinned(pinned, 'cherry', false)).toEqual(['apple']);
    expect(withChipPinned(pinned, 'apple', true)).toBe(pinned);
    expect(withChipPinned(pinned, 'banana', false)).toBe(pinned);
  });

  it('swaps a kind with its neighbour, and refuses the ends and unpinned kinds', async () => {
    const { canMovePinnedChip, withPinnedChipMoved } = await import('../pinned-chips-store');
    const pinned: readonly FruitKind[] = ['apple', 'banana', 'cherry'];
    expect(withPinnedChipMoved(pinned, 'banana', -1)).toEqual(['banana', 'apple', 'cherry']);
    expect(withPinnedChipMoved(pinned, 'banana', 1)).toEqual(['apple', 'cherry', 'banana']);
    expect(canMovePinnedChip(pinned, 'apple', -1)).toBe(false);
    expect(canMovePinnedChip(pinned, 'cherry', 1)).toBe(false);
    expect(withPinnedChipMoved(pinned, 'apple', -1)).toBe(pinned);
    expect(withPinnedChipMoved(['apple'] as readonly FruitKind[], 'banana', 1)).toEqual(['apple']);
    expect(canMovePinnedChip(['apple', 'cherry'] as readonly FruitKind[], 'banana', -1)).toBe(false);
  });

  it('keeps the stored order, catalog kinds only, each once', async () => {
    const { keepStoredPinOrder } = await import('../pinned-chips-store');
    expect(keepStoredPinOrder(FRUIT_CATALOG)(['cherry', 'fig', 7, null, 'apple', 'cherry'])).toEqual([
      'cherry',
      'apple',
    ]);
  });
});

describe('climbPinnedChipsStore', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getMockStorage()).__reset();
  });

  it('is the store behind the climbs exports, on the pinnedFilterChips key', async () => {
    const module = await import('../pinned-chips-store');
    expect(module.climbPinnedChipsStore.storageKey).toBe('pinnedFilterChips');
    expect(module.STORAGE_KEY).toBe('pinnedFilterChips');
    expect(module.usePinnedChips).toBe(module.climbPinnedChipsStore.usePinnedChips);
    expect(module.setPinnedChips).toBe(module.climbPinnedChipsStore.set);
  });

  it('gives an older saved list Recent on load, but never re-adds it on a pin change', async () => {
    const storage = await getMockStorage();
    storage.__setRaw('pinnedFilterChips', JSON.stringify(['grade', 'rating']));
    const { climbPinnedChipsStore } = await import('../pinned-chips-store');
    expect(await climbPinnedChipsStore.load()).toEqual(['recent', 'grade', 'rating']);
    await climbPinnedChipsStore.set(['grade', 'rating']);
    expect(JSON.parse(storage.__getRaw('pinnedFilterChips') as string)).toEqual(['grade', 'rating', '!recent']);
  });
});
