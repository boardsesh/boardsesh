import { describe, expect, it } from 'vitest';
import { parsePlaylistSetterSource, playlistSetterSourceParams } from '../playlist-setter-source';

describe('playlist setter source params', () => {
  it('round-trips a playlist and a smart list', () => {
    const playlist = { kind: 'playlist', playlistId: 'p-1' } as const;
    const liked = { kind: 'smart', smartType: 'LIKED_CLIMBS', userId: 'u-1' } as const;
    expect(playlistSetterSourceParams(playlist)).toEqual({ playlistId: 'p-1' });
    expect(parsePlaylistSetterSource(playlistSetterSourceParams(playlist))).toEqual(playlist);
    expect(parsePlaylistSetterSource(playlistSetterSourceParams(liked))).toEqual(liked);
  });

  it('names no list for missing or unknown params, or a recommendation', () => {
    expect(parsePlaylistSetterSource({})).toBeNull();
    expect(parsePlaylistSetterSource({ smartType: 'LIKED_CLIMBS' })).toBeNull();
    expect(parsePlaylistSetterSource({ smartType: 'RECOMMENDED_FRESH', userId: 'u-1' })).toBeNull();
  });
});
