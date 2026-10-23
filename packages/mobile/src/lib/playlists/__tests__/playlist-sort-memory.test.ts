import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
  createMMKV: vi.fn(() => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => {
      mockStorage.set(key, value);
    },
    remove: (key: string) => {
      mockStorage.delete(key);
    },
    clearAll: () => mockStorage.clear(),
  })),
}));

import { getSetting, resetAllSettings, setSetting } from '../../../settings';
import { MAX_REMEMBERED_LIST_SORTS, playlistSortMemoryKey, readListSort, writeListSort } from '../playlist-sort-memory';
import { playlistSortModel } from '../playlist-sort-model';

beforeEach(() => {
  mockStorage.clear();
  resetAllSettings();
});

describe('playlist sort memory', () => {
  it('opens a playlist with no memory on its own order', () => {
    expect(readListSort(playlistSortMemoryKey('p-1'), playlistSortModel)).toEqual({
      sortBy: 'position',
      sortOrder: 'asc',
    });
  });

  it('remembers a sort per playlist', () => {
    writeListSort('playlist:p-1', { sortBy: 'difficulty', sortOrder: 'desc' }, playlistSortModel);
    writeListSort('playlist:p-2', { sortBy: 'added', sortOrder: 'desc' }, playlistSortModel);
    expect(readListSort('playlist:p-1', playlistSortModel)).toEqual({ sortBy: 'difficulty', sortOrder: 'desc' });
    expect(readListSort('playlist:p-2', playlistSortModel)).toEqual({ sortBy: 'added', sortOrder: 'desc' });
  });

  it('keeps the newest first and drops the oldest past the cap', () => {
    for (let index = 0; index <= MAX_REMEMBERED_LIST_SORTS; index += 1) {
      writeListSort(`playlist:${index}`, { sortBy: 'name', sortOrder: 'asc' }, playlistSortModel);
    }
    const entries = getSetting('playlistSortsV1')?.entries ?? [];
    expect(entries).toHaveLength(MAX_REMEMBERED_LIST_SORTS);
    expect(entries[0]?.listKey).toBe(`playlist:${MAX_REMEMBERED_LIST_SORTS}`);
    expect(entries.some((entry) => entry.listKey === 'playlist:0')).toBe(false);
  });

  it('moves a list back to the front when its sort changes', () => {
    writeListSort('playlist:a', { sortBy: 'name', sortOrder: 'asc' }, playlistSortModel);
    writeListSort('playlist:b', { sortBy: 'name', sortOrder: 'asc' }, playlistSortModel);
    writeListSort('playlist:a', { sortBy: 'quality', sortOrder: 'desc' }, playlistSortModel);
    expect(getSetting('playlistSortsV1')?.entries.map((entry) => entry.listKey)).toEqual(['playlist:a', 'playlist:b']);
  });

  it('forgets a list put back on its own order, and stores nothing once empty', () => {
    writeListSort('playlist:a', { sortBy: 'name', sortOrder: 'desc' }, playlistSortModel);
    writeListSort('playlist:a', { sortBy: 'position', sortOrder: 'asc' }, playlistSortModel);
    expect(getSetting('playlistSortsV1')).toBeNull();
    expect(readListSort('playlist:a', playlistSortModel)).toEqual({ sortBy: 'position', sortOrder: 'asc' });
  });

  it('stores Random without its seed, and comes back with a new shuffle', () => {
    writeListSort('playlist:a', { sortBy: 'random', sortOrder: 'asc', sortSeed: '12345' }, playlistSortModel);
    expect(getSetting('playlistSortsV1')?.entries[0]).toEqual({
      listKey: 'playlist:a',
      sortBy: 'random',
      sortOrder: 'asc',
    });
    const restored = readListSort('playlist:a', playlistSortModel);
    expect(restored.sortBy).toBe('random');
    expect(restored.sortSeed).toMatch(/^\d+$/);
  });

  it('falls back on a key or direction the model no longer offers, and drops bad entries on the next write', () => {
    setSetting('playlistSortsV1', {
      entries: [
        { listKey: 'playlist:gone', sortBy: 'popular', sortOrder: 'desc' },
        { listKey: 'playlist:sideways', sortBy: 'difficulty', sortOrder: 'sideways' },
        { listKey: 'playlist:one-way', sortBy: 'position', sortOrder: 'desc' },
        { listKey: 42, sortBy: 'name', sortOrder: 'asc' } as unknown as {
          listKey: string;
          sortBy: string;
          sortOrder: string;
        },
      ],
    });
    expect(readListSort('playlist:gone', playlistSortModel)).toEqual({ sortBy: 'position', sortOrder: 'asc' });
    expect(readListSort('playlist:sideways', playlistSortModel)).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
    expect(readListSort('playlist:one-way', playlistSortModel)).toEqual({ sortBy: 'position', sortOrder: 'asc' });

    writeListSort('playlist:new', { sortBy: 'name', sortOrder: 'asc' }, playlistSortModel);
    const listKeys = getSetting('playlistSortsV1')?.entries.map((entry) => entry.listKey);
    expect(listKeys).not.toContain(42);
    expect(listKeys?.[0]).toBe('playlist:new');
  });

  it('survives a stored value that is not an object at all', () => {
    mockStorage.set('playlistSortsV1', JSON.stringify('garbage'));
    expect(readListSort('playlist:a', playlistSortModel)).toEqual({ sortBy: 'position', sortOrder: 'asc' });
    writeListSort('playlist:a', { sortBy: 'name', sortOrder: 'asc' }, playlistSortModel);
    expect(getSetting('playlistSortsV1')?.entries).toEqual([
      { listKey: 'playlist:a', sortBy: 'name', sortOrder: 'asc' },
    ]);
  });
});
