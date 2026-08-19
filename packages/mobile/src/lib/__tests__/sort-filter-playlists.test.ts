import { describe, it, expect } from 'vitest';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import {
  filterPlaylistsByBoard,
  hasPlaylistForBoard,
  sortAndFilterPlaylists,
  sortPlaylistsByName,
} from '../sort-filter-playlists';

// A minimal Playlist factory — the helper only reads `name`, so the rest is
// padding to satisfy the type.
function playlist(name: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: name,
    uuid: name,
    boardType: 'kilter',
    layoutId: 1,
    name,
    isPublic: false,
    createdAt: '',
    updatedAt: '',
    climbCount: 0,
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
    ...overrides,
  } as Playlist;
}

const names = (playlists: Playlist[]) => playlists.map((entry) => entry.name);

describe('sortAndFilterPlaylists', () => {
  it('sorts playlists by name without applying a filter', () => {
    const input = [playlist('warmups'), playlist('Projects'), playlist('anti-style')];
    expect(names(sortPlaylistsByName(input))).toEqual(['anti-style', 'Projects', 'warmups']);
  });

  it('does not mutate the input array when sorting by name', () => {
    const input = [playlist('b'), playlist('a')];
    sortPlaylistsByName(input);
    expect(names(input)).toEqual(['b', 'a']);
  });

  it('sorts alphabetically, case- and accent-insensitively', () => {
    const input = [playlist('banana'), playlist('Apple'), playlist('Éclair'), playlist('cherry')];
    expect(names(sortAndFilterPlaylists(input, ''))).toEqual(['Apple', 'banana', 'cherry', 'Éclair']);
  });

  it('does not mutate the input array', () => {
    const input = [playlist('b'), playlist('a')];
    sortAndFilterPlaylists(input, '');
    expect(names(input)).toEqual(['b', 'a']);
  });

  it('filters by case-insensitive substring of the name', () => {
    const input = [playlist('Crimps @ 45'), playlist('Dynos'), playlist('Slab crimping')];
    expect(names(sortAndFilterPlaylists(input, 'CRIMP'))).toEqual(['Crimps @ 45', 'Slab crimping']);
  });

  it('trims the query and returns everything when it is blank', () => {
    const input = [playlist('b'), playlist('a')];
    expect(names(sortAndFilterPlaylists(input, '   '))).toEqual(['a', 'b']);
  });

  it('returns an empty array when nothing matches', () => {
    const input = [playlist('Projects'), playlist('Warmups')];
    expect(sortAndFilterPlaylists(input, 'zzz')).toEqual([]);
  });
});

describe('filterPlaylistsByBoard', () => {
  it('keeps playlists matching both boardType and layoutId', () => {
    const input = [playlist('Kilter 9', { boardType: 'kilter', layoutId: 9 })];
    expect(names(filterPlaylistsByBoard(input, 'kilter', 9))).toEqual(['Kilter 9']);
  });

  it('drops playlists with a mismatched boardType', () => {
    const input = [playlist('Tension climbs', { boardType: 'tension', layoutId: 9 })];
    expect(filterPlaylistsByBoard(input, 'kilter', 9)).toEqual([]);
  });

  it('drops playlists with a mismatched layoutId', () => {
    const input = [playlist('Other layout', { boardType: 'kilter', layoutId: 8 })];
    expect(filterPlaylistsByBoard(input, 'kilter', 9)).toEqual([]);
  });

  // Mirrors the backend rule (`layout_id = $layout OR layout_id IS NULL`) that
  // userPlaylists/allUserPlaylists apply: a layout-less playlist belongs to the
  // whole board, so it stays an add target on every layout of that board.
  it('keeps playlists with a null layoutId (Aurora/Kilter-synced circuits)', () => {
    const input = [playlist('Aurora circuit', { boardType: 'kilter', layoutId: null })];
    expect(names(filterPlaylistsByBoard(input, 'kilter', 9))).toEqual(['Aurora circuit']);
  });

  it('still drops a null-layout playlist belonging to another board', () => {
    const input = [playlist('Tension circuit', { boardType: 'tension', layoutId: null })];
    expect(filterPlaylistsByBoard(input, 'kilter', 9)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [playlist('a', { boardType: 'tension' }), playlist('b', { boardType: 'kilter', layoutId: 1 })];
    filterPlaylistsByBoard(input, 'kilter', 1);
    expect(names(input)).toEqual(['a', 'b']);
  });
});

describe('hasPlaylistForBoard', () => {
  // Agrees with filterPlaylistsByBoard by construction (shared predicate); these
  // pin the agreement, since the play drawer reserves or drops a layout slot on
  // this answer alone.
  it('is false with no playlists at all', () => {
    expect(hasPlaylistForBoard([], 'kilter', 9)).toBe(false);
  });

  it('is true for a playlist on this board and layout', () => {
    expect(hasPlaylistForBoard([playlist('Kilter 9', { boardType: 'kilter', layoutId: 9 })], 'kilter', 9)).toBe(true);
  });

  it('is true for a board-wide playlist with no layout of its own', () => {
    expect(hasPlaylistForBoard([playlist('Circuit', { boardType: 'kilter', layoutId: null })], 'kilter', 9)).toBe(true);
  });

  it('is false for another board, and for another layout of this board', () => {
    expect(hasPlaylistForBoard([playlist('Tension', { boardType: 'tension', layoutId: 9 })], 'kilter', 9)).toBe(false);
    expect(hasPlaylistForBoard([playlist('Layout 8', { boardType: 'kilter', layoutId: 8 })], 'kilter', 9)).toBe(false);
  });

  it('finds a match past non-matching entries', () => {
    const input = [
      playlist('Tension', { boardType: 'tension', layoutId: 9 }),
      playlist('Layout 8', { boardType: 'kilter', layoutId: 8 }),
      playlist('Kilter 9', { boardType: 'kilter', layoutId: 9 }),
    ];
    expect(hasPlaylistForBoard(input, 'kilter', 9)).toBe(true);
  });
});
