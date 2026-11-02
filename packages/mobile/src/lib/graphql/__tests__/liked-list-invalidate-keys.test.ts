import { describe, expect, it } from 'vitest';
import { TABLE_INVALIDATE_KEYS } from '@boardsesh/offline-sync';
import { LIKED_LIST_QUERY_KEY_PREFIX, SMART_PLAYLIST_COUNTS_QUERY_KEY } from '@boardsesh/playlists-react';

// offline-sync spells these keys by hand (it cannot import playlists-react).
// If the owner of a key renames it, the drainer's invalidation silently stops
// matching and an un-liked climb comes back on the Liked list (#5304).
describe('user_favorites invalidation keys', () => {
  it('include the Liked list prefix and the library count key the readers build', () => {
    const keys = TABLE_INVALIDATE_KEYS.user_favorites;
    expect(keys).toContainEqual([...LIKED_LIST_QUERY_KEY_PREFIX]);
    expect(keys).toContainEqual([SMART_PLAYLIST_COUNTS_QUERY_KEY]);
  });
});
