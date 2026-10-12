// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
      __getRaw: (key: string) => storage[key] ?? null,
      __keys: () => Object.keys(storage),
    },
  };
});

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    __getRaw: (key: string) => string | null;
    __keys: () => string[];
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

  it('by default drops unknown and duplicate kinds and sorts into catalog order', async () => {
    (await getMockStorage()).__setRaw('pinnedFruitChips', JSON.stringify(['cherry', 'durian', 'apple', 'cherry']));
    const { fruit } = await makeStores();
    expect(await fruit.load()).toEqual(['apple', 'cherry']);
  });

  it('persists under its own key only, in catalog order', async () => {
    const storage = await getMockStorage();
    const { fruit } = await makeStores();
    expect(fruit.storageKey).toBe('pinnedFruitChips');
    await fruit.toggle('banana');
    expect(storage.__keys()).toEqual(['pinnedFruitChips']);
    expect(JSON.parse(storage.__getRaw('pinnedFruitChips') as string)).toEqual(['apple', 'banana', 'cherry']);
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
    await waitFor(() => expect(fruitHook.result.current.pinned).toEqual(['apple', 'banana', 'cherry']));
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

  it('keeps togglePin referentially stable across renders', async () => {
    const { fruit } = await makeStores();
    const hook = renderHook(() => fruit.usePinnedChips());
    const firstToggle = hook.result.current.togglePin;
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    hook.rerender();
    expect(hook.result.current.togglePin).toBe(firstToggle);
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
});
