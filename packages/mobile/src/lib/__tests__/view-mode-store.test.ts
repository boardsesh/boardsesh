import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';

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

const STORE_KEY = 'boardsesh_climbs_view_mode_by_board';

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

async function resetStore() {
  const store = await import('expo-secure-store');
  (store as unknown as { __reset: () => void }).__reset();
}

async function rawStorage(): Promise<Record<string, string>> {
  const store = await import('expo-secure-store');
  return (store as unknown as { __raw: () => Record<string, string> }).__raw();
}

describe('view-mode-store', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('defaults to list for a board that was never set', async () => {
    const { getViewMode, DEFAULT_CLIMB_VIEW_MODE } = await import('../view-mode-store');
    expect(DEFAULT_CLIMB_VIEW_MODE).toBe('list');
    expect(await getViewMode(kilterBoard)).toBe('list');
  });

  it('persists and restores grid per board', async () => {
    const { saveViewMode, getViewMode } = await import('../view-mode-store');
    await saveViewMode(kilterBoard, 'grid');
    expect(await getViewMode(kilterBoard)).toBe('grid');
    // A different board is unaffected and keeps the default.
    expect(await getViewMode(tensionBoard)).toBe('list');
  });

  it('deletes the entry when saving the default list mode', async () => {
    const { saveViewMode, getViewMode } = await import('../view-mode-store');
    await saveViewMode(kilterBoard, 'grid');
    await saveViewMode(kilterBoard, 'list');
    expect(await getViewMode(kilterBoard)).toBe('list');
    const stored = JSON.parse((await rawStorage())[STORE_KEY] ?? '{}');
    expect(Object.keys(stored)).toHaveLength(0);
  });

  it('ignores malformed stored values and falls back to the default', async () => {
    const store = await import('expo-secure-store');
    await store.setItemAsync(STORE_KEY, JSON.stringify({ 'kilter|1|7|1,20|40': 'bogus' }));
    const { getViewMode } = await import('../view-mode-store');
    expect(await getViewMode(kilterBoard)).toBe('list');
  });
});
