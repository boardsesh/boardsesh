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
    },
  };
});

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
  };
}

describe('playlist pinned chips', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getMockStorage()).__reset();
  });

  it('keeps its own storage key, apart from the Climbs and Logbook pins', async () => {
    const { PLAYLIST_PINNED_CHIPS_STORAGE_KEY } = await import('../playlist-pinned-chips-store');
    const { STORAGE_KEY } = await import('../pinned-chips-store');
    const { LOGBOOK_PINNED_CHIPS_STORAGE_KEY } = await import('../logbook-pinned-chips-store');
    expect(PLAYLIST_PINNED_CHIPS_STORAGE_KEY).toBe('pinnedPlaylistChips');
    expect(PLAYLIST_PINNED_CHIPS_STORAGE_KEY).not.toBe(STORAGE_KEY);
    expect(PLAYLIST_PINNED_CHIPS_STORAGE_KEY).not.toBe(LOGBOOK_PINNED_CHIPS_STORAGE_KEY);
  });

  it('starts with Grade, Your progress and Sort', async () => {
    const { playlistPinnedChipsStore } = await import('../playlist-pinned-chips-store');
    expect(await playlistPinnedChipsStore.load()).toEqual(['grade', 'progress', 'sort']);
  });

  it('drops kinds a playlist cannot pin and keeps the saved order', async () => {
    (await getMockStorage()).__setRaw(
      'pinnedPlaylistChips',
      JSON.stringify(['sort', 'recent', 'boardFit', 'collection', 'tall', 'grade']),
    );
    const { playlistPinnedChipsStore } = await import('../playlist-pinned-chips-store');
    expect(await playlistPinnedChipsStore.load()).toEqual(['sort', 'boardFit', 'grade']);
  });

  it('pins a new chip last and moves it', async () => {
    const { playlistPinnedChipsStore } = await import('../playlist-pinned-chips-store');
    await playlistPinnedChipsStore.toggle('beta');
    expect(await playlistPinnedChipsStore.load()).toEqual(['grade', 'progress', 'sort', 'beta']);
    await playlistPinnedChipsStore.move('beta', -1);
    expect(await playlistPinnedChipsStore.load()).toEqual(['grade', 'progress', 'beta', 'sort']);
  });

  it('draws "Fits my board" right before Sort, which stays last', async () => {
    const { PLAYLIST_PINNABLE_CHIP_KINDS } = await import('../playlist-pinnable-chips');
    expect(PLAYLIST_PINNABLE_CHIP_KINDS.at(-1)).toBe('sort');
    expect(PLAYLIST_PINNABLE_CHIP_KINDS.at(-2)).toBe('boardFit');
    expect(PLAYLIST_PINNABLE_CHIP_KINDS).not.toContain('recent');
    expect(PLAYLIST_PINNABLE_CHIP_KINDS).not.toContain('collection');
  });
});
