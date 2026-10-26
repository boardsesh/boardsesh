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

  it('loads a stored set in the order it was saved', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['rating', 'recent', 'grade']));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['rating', 'recent', 'grade']);
  });

  it('drops unknown kinds from a stored payload', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'setters', 'collection', '!recent']));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['grade', 'collection']);
  });

  it('loads a stored "shape" pin as Tall + Wide without rewriting storage', async () => {
    const storage = await getMockStorage();
    const legacy = JSON.stringify(['grade', 'progress', 'collection', 'shape', 'popularity', 'rating']);
    storage.__setRaw(STORAGE_KEY, legacy);
    const { loadPinnedChips } = await import('../pinned-chips-store');
    // Saved before Recent was pinnable too, so it gains Recent.
    expect(await loadPinnedChips()).toEqual([
      'recent',
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
      'recent',
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
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['rating', 'shape', '!recent']));
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    // The legacy Shape pin becomes Tall + Wide where it stood.
    expect(await loadPinnedChips()).toEqual(['rating', 'tall', 'wide']);
    // After the split, Tall and Wide unpin independently.
    await togglePinnedChip('tall');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual(['rating', 'wide', '!recent']);
  });

  it('round-trips a persisted set with the "shape" alias without duplicating Tall or Wide', async () => {
    const storage = await getMockStorage();
    const first = await import('../pinned-chips-store');
    await first.setPinnedChips(['grade', 'tall', 'wide']);
    expect(JSON.parse(storage.__getRaw(STORAGE_KEY) as string)).toEqual(['grade', 'tall', 'wide', 'shape', '!recent']);
    // A fresh module (next launch) reads it back as the plain set.
    vi.resetModules();
    const second = await import('../pinned-chips-store');
    expect(await second.loadPinnedChips()).toEqual(['grade', 'tall', 'wide']);
  });

  it('falls back to the full defaults for an empty stored array (never a blank row, never Recent alone)', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify([]));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(DEFAULT_PINNED_CHIPS);
    expect(DEFAULT_PINNED_CHIPS).toContain('recent');
  });

  it('falls back to the full defaults when every chip, Recent included, was unpinned', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['!recent']));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(DEFAULT_PINNED_CHIPS);
  });

  it('togglePin removes a pinned kind and persists the rest in their order', async () => {
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('collection');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual([
      'recent',
      'grade',
      'progress',
      'tall',
      'wide',
      'shape',
      'popularity',
      'rating',
    ]);
  });

  it('togglePin pins an unpinned kind last', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['recent', 'grade', 'rating']));
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('collection');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    // At the end of the row, where the climber can move it from.
    expect(JSON.parse(raw as string)).toEqual(['recent', 'grade', 'rating', 'collection']);
  });

  it('moves a pin and keeps the order, with the Shape alias, across a restart', async () => {
    const storage = await getMockStorage();
    const { loadPinnedChips, climbPinnedChipsStore, resetPinnedChipsStoreForTests } =
      await import('../pinned-chips-store');
    await loadPinnedChips();
    await climbPinnedChipsStore.move('rating', -1);
    await climbPinnedChipsStore.move('tall', -1);
    const moved = ['recent', 'grade', 'progress', 'tall', 'collection', 'wide', 'rating', 'popularity'];
    expect(await loadPinnedChips()).toEqual(moved);
    expect(JSON.parse(storage.__getRaw(STORAGE_KEY) as string)).toEqual([
      'recent',
      'grade',
      'progress',
      'tall',
      'collection',
      'wide',
      'shape',
      'rating',
      'popularity',
    ]);
    resetPinnedChipsStoreForTests();
    expect(await loadPinnedChips()).toEqual(moved);
  });

  it('a set before load wins over the persisted value (no clobber on race)', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade']));
    const { setPinnedChips, loadPinnedChips } = await import('../pinned-chips-store');
    await setPinnedChips(['rating']);
    expect(await loadPinnedChips()).toEqual(['rating']);
  });

  it('togglePin during the load window flips the PERSISTED set, not the DEFAULT snapshot', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'rating', '!recent']));
    const { togglePinnedChip } = await import('../pinned-chips-store');
    // Toggle WITHOUT awaiting loadPinnedChips first — simulates an early pin tap on
    // cold start. It must load the saved set first, then remove 'rating' from it,
    // rather than computing DEFAULT − 'rating' and discarding the customization.
    await togglePinnedChip('rating');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual(['grade', '!recent']);
  });
});

// Recent became pinnable after every saved list was written, so the store
// must tell "saved before Recent was pinnable" (keep it) from "unpinned" (hide it).
describe('pinned-chips-store: the Recent pin', () => {
  // What the defaults persisted as before Recent was pinnable (Tier-1 chips + the 'shape' alias).
  const savedBeforeRecentPin = ['grade', 'progress', 'collection', 'tall', 'wide', 'shape', 'popularity', 'rating'];

  beforeEach(async () => {
    vi.resetModules();
    (await getMockStorage()).__reset();
  });

  it('keeps Recent for a climber whose pins were saved before it was pinnable, without rewriting them', async () => {
    const storage = await getMockStorage();
    storage.__setRaw(STORAGE_KEY, JSON.stringify(savedBeforeRecentPin));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(DEFAULT_PINNED_CHIPS);
    expect(JSON.parse(storage.__getRaw(STORAGE_KEY) as string)).toEqual(savedBeforeRecentPin);
  });

  it('hides Recent, stays hidden after a restart, and comes back when pinned again', async () => {
    const storage = await getMockStorage();
    storage.__setRaw(STORAGE_KEY, JSON.stringify(savedBeforeRecentPin));
    const { loadPinnedChips, togglePinnedChip, resetPinnedChipsStoreForTests } = await import('../pinned-chips-store');
    await loadPinnedChips();

    await togglePinnedChip('recent');
    expect(JSON.parse(storage.__getRaw(STORAGE_KEY) as string)).toEqual([
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'shape',
      'popularity',
      'rating',
      '!recent',
    ]);

    // Restart: the store forgets its state and reads storage again.
    resetPinnedChipsStoreForTests();
    const afterRestart = await loadPinnedChips();
    expect(afterRestart).not.toContain('recent');
    expect(afterRestart).toEqual(DEFAULT_PINNED_CHIPS.filter((kind) => kind !== 'recent'));

    // Pinned again, it goes last like any pin; the climber can move it back up.
    await togglePinnedChip('recent');
    expect(JSON.parse(storage.__getRaw(STORAGE_KEY) as string)).toEqual([...savedBeforeRecentPin, 'recent']);
    resetPinnedChipsStoreForTests();
    expect(await loadPinnedChips()).toEqual([...DEFAULT_PINNED_CHIPS.filter((kind) => kind !== 'recent'), 'recent']);
  });

  it('leaves every other pin alone when Recent is hidden', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['sort', 'beta', 'grade']));
    const { loadPinnedChips, togglePinnedChip, resetPinnedChipsStoreForTests } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['recent', 'sort', 'beta', 'grade']);
    await togglePinnedChip('recent');
    resetPinnedChipsStoreForTests();
    expect(await loadPinnedChips()).toEqual(['sort', 'beta', 'grade']);
  });
});
