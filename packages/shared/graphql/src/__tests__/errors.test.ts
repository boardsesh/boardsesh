import { describe, it, expect } from 'vitest';
import { PLAYLIST_UPDATE_CONFLICT_CODE } from '@boardsesh/shared-schema';

import { isPlaylistUpdateConflictError, readPlaylistUpdateConflict } from '../errors';

const conflictExtensions = {
  code: PLAYLIST_UPDATE_CONFLICT_CODE,
  playlistUuid: 'pl-1',
  serverUpdatedAt: '2026-08-10T12:00:00.000Z',
  serverName: 'Renamed on the other phone',
  serverDescription: 'theirs',
  serverIsPublic: true,
  serverColor: '#6D28D9',
  serverIcon: '🔥',
};

describe('readPlaylistUpdateConflict', () => {
  it('reads a graphql-request ClientError (response.errors[])', () => {
    const clientError = {
      response: { errors: [{ message: 'This playlist changed somewhere else', extensions: conflictExtensions }] },
    };

    expect(isPlaylistUpdateConflictError(clientError)).toBe(true);
    expect(readPlaylistUpdateConflict(clientError)).toEqual({
      playlistUuid: 'pl-1',
      serverUpdatedAt: '2026-08-10T12:00:00.000Z',
      serverName: 'Renamed on the other phone',
      serverDescription: 'theirs',
      serverIsPublic: true,
      serverColor: '#6D28D9',
      serverIcon: '🔥',
    });
  });

  it('reads a re-thrown error carrying graphqlErrors[]', () => {
    const rethrown = Object.assign(new Error('update failed'), {
      graphqlErrors: [{ message: 'nope', extensions: conflictExtensions }],
    });

    expect(isPlaylistUpdateConflictError(rethrown)).toBe(true);
    expect(readPlaylistUpdateConflict(rethrown)?.serverName).toBe('Renamed on the other phone');
  });

  it('reports absent optional server values as null, not undefined', () => {
    const clientError = {
      response: {
        errors: [
          {
            extensions: {
              code: PLAYLIST_UPDATE_CONFLICT_CODE,
              playlistUuid: 'pl-1',
              serverUpdatedAt: '2026-08-10T12:00:00.000Z',
              serverName: 'Bare',
              serverDescription: null,
              serverIsPublic: false,
              serverColor: null,
              serverIcon: null,
            },
          },
        ],
      },
    };

    expect(readPlaylistUpdateConflict(clientError)).toEqual({
      playlistUuid: 'pl-1',
      serverUpdatedAt: '2026-08-10T12:00:00.000Z',
      serverName: 'Bare',
      serverDescription: null,
      serverIsPublic: false,
      serverColor: null,
      serverIcon: null,
    });
  });

  it('returns null for an unrelated error code', () => {
    const otherError = { response: { errors: [{ extensions: { code: 'BOARD_LIMIT_REACHED' } }] } };

    expect(isPlaylistUpdateConflictError(otherError)).toBe(false);
    expect(readPlaylistUpdateConflict(otherError)).toBeNull();
  });

  it('returns null for a conflict whose identity extensions did not survive', () => {
    // A proxy that strips extensions, or an older server: the caller can still
    // tell it IS a conflict, but there is nothing to show or retry against.
    const strippedError = { response: { errors: [{ extensions: { code: PLAYLIST_UPDATE_CONFLICT_CODE } }] } };

    expect(isPlaylistUpdateConflictError(strippedError)).toBe(true);
    expect(readPlaylistUpdateConflict(strippedError)).toBeNull();
  });

  it('returns null for a plain error with no GraphQL payload', () => {
    expect(isPlaylistUpdateConflictError(new Error('network down'))).toBe(false);
    expect(readPlaylistUpdateConflict(new Error('network down'))).toBeNull();
  });
});
