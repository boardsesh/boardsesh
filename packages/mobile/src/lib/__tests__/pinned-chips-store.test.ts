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
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'setters', 'benchmarks']));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(['grade', 'benchmarks']);
  });

  it('falls back to defaults for an empty stored array (never a blank row)', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify([]));
    const { loadPinnedChips } = await import('../pinned-chips-store');
    expect(await loadPinnedChips()).toEqual(DEFAULT_PINNED_CHIPS);
  });

  it('togglePin removes a pinned kind and persists the canonical-ordered rest', async () => {
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('benchmarks');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    expect(JSON.parse(raw as string)).toEqual(['grade', 'progress', 'shape', 'popularity', 'rating']);
  });

  it('togglePin re-adds an unpinned kind back into canonical order', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade', 'rating']));
    const { loadPinnedChips, togglePinnedChip } = await import('../pinned-chips-store');
    await loadPinnedChips();
    await togglePinnedChip('benchmarks');
    const raw = (await getMockStorage()).__getRaw(STORAGE_KEY);
    // benchmarks slots between grade and rating per catalog order, not at the end.
    expect(JSON.parse(raw as string)).toEqual(['grade', 'benchmarks', 'rating']);
  });

  it('a set before load wins over the persisted value (no clobber on race)', async () => {
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify(['grade']));
    const { setPinnedChips, loadPinnedChips } = await import('../pinned-chips-store');
    await setPinnedChips(['rating']);
    expect(await loadPinnedChips()).toEqual(['rating']);
  });
});
