import { describe, it, expect } from 'vitest';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import { sortAndFilterPlaylists, sortPlaylistsByName } from '../sort-filter-playlists';

// A minimal Playlist factory — the helper only reads `name`, so the rest is
// padding to satisfy the type.
function playlist(name: string): Playlist {
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
