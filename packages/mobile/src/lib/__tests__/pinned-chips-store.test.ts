import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STORAGE_KEY } from '../pinned-chips-store';
import { DEFAULT_PINNED_CHIPS } from '../pinnable-chips';

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
    },
  };
});

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    __getRaw: (key: string) => string | null;
  };
}

describe('pinned-chips-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getMockStorage()).__reset();
  });

  it('loads the default (all pinned) set when nothing is stored', async () => {
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(DEFAULT_PINNED_CHIPS);
  });

  it('loads a stored set, normalized into canonical order', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['rating', 'grade']));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['grade', 'rating']);
  });

  it('drops unknown kinds from a stored payload', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'setters', 'collection']));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['grade', 'collection']);
  });

  it('loads a stored "shape" pin as Tall + Wide without rewriting storage', async () => {
    const storage = await getMockStorage();
    const legacy = JSON.stringify(['grade', 'progress', 'collection', 'shape', 'popularity', 'rating']);
    storage.__setRaw(STORAGE_KEY, legacy);
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual([
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'popularity',
      'rating',
    ]);
    // Loading never writes: an older bundle can still read what it wrote.
    expect(storage.__getRaw(STORAGE_KEY)).toBe(legacy);
  });

  it('persists "shape" next to Tall + Wide while both are pinned (older bundles keep the Shape chip)', async () => {
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('rating');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual([
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'shape',
      'popularity',
    ]);
  });

  it('drops "shape" from storage once Tall or Wide is unpinned, so the unpinned one stays off', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['rating', 'shape']));
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['tall', 'wide', 'rating']);
    // After the split, Tall and Wide unpin independently.
    await togglePinnedChip('tall');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual(['wide', 'rating']);
  });

  it('round-trips a persisted set with the "shape" alias without duplicating Tall or Wide', async () => {
    const storage = await getMockStorage();
    const first = await import('../pinned-chips-store');
    await first.setPinnedChips(['grade', 'tall', 'wide']);
    expect(JSON.parse(storage.__getRaw(STORAGE_KEY) as string)).toEqual(['grade', 'tall', 'wide', 'shape']);
    // A fresh module (next launch) reads it back as the plain set.
    vi.resetModules();
    const second = await import('../pinned-chips-store');
    expect(await second.loadPinnedChips()).toEqual(['grade', 'tall', 'wide']);
  });

  it('falls back to defaults for an empty stored array (never a blank row)', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify([]));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(DEFAULT_PINNED_CHIPS);
  });

  it('togglePin removes a pinned kind and persists the canonical-ordered rest', async () => {
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('collection');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual(['grade', 'progress', 'tall', 'wide', 'shape', 'popularity', 'rating']);
  });

  it('togglePin re-adds an unpinned kind back into canonical order', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'rating']));
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('collection');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    // collection slots between grade and rating per catalog order, not at the end.
    expect(JSON.parse(raw as string)).toEqual(['grade', 'collection', 'rating']);
  });

  it('a set before load wins over the persisted value (no clobber on race)', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade']));
    const { setPinnedChips, loadPinnedChips } = await import('../pinned-chips-store');
    await setPinnedChips(['rating']);
    expect(await loadPinnedChips()).toEqual(['rating']);
  });

  it('togglePin during the load window flips the PERSISTED set, not the DEFAULT snapshot', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'rating']));
    const { togglePinnedChip } = await import('../pinned-chips-store');
    // Toggle WITHOUT awaiting loadPinnedChips first — simulates an early pin tap on
    // cold start. It must load the saved set first, then remove 'rating' from it,
    // rather than computing DEFAULT − 'rating' and discarding the customization.
    await togglePinnedChip('rating');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual(['grade']);
  });
});
