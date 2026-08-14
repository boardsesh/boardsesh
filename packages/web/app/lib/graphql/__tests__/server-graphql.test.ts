// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('graphql-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('graphql-request')>();
  class MockGraphQLClient {
    request = requestMock;
  }
  return {
    ...actual,
    GraphQLClient: MockGraphQLClient,
  };
});

vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: () => 'http://test.local/graphql',
}));

// Import after vi.mock so the mocks are applied to the helpers' transitive deps.
import {
  serverGroupedNotifications,
  serverMyBoards,
  serverPlaylist,
  serverPlaylistClimbs,
  serverUserPlaylists,
} from '../server-graphql';

describe('server-graphql helpers', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  describe('serverPlaylist', () => {
    it('returns the playlist field from the GraphQL response on success', async () => {
      const playlist = { uuid: 'pl-1', name: 'Project Picks', boardType: 'kilter' };
      requestMock.mockResolvedValueOnce({ playlist });

      const result = await serverPlaylist('auth-token', 'pl-1');

      expect(result).toEqual(playlist);
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('returns null and logs when the GraphQL request throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      requestMock.mockRejectedValueOnce(new Error('network down'));

      const result = await serverPlaylist('auth-token', 'pl-1');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('serverPlaylist failed:', expect.any(Error));
      errorSpy.mockRestore();
    });

    it('returns null without logging when the GraphQL response is { playlist: null } (not-found)', async () => {
      // The backend returns a 200 + `{ playlist: null }` for an unknown UUID
      // rather than throwing. We must surface that as `null` so the page
      // route can render the not-found state — and NOT log it as a failure,
      // since "playlist doesn't exist" is a normal user outcome.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      requestMock.mockResolvedValueOnce({ playlist: null });

      const result = await serverPlaylist('auth-token', 'missing-uuid');

      expect(result).toBeNull();
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('serverPlaylistClimbs', () => {
    it('returns the playlistClimbs payload on success', async () => {
      const payload = { climbs: [], totalCount: 0, hasMore: false };
      requestMock.mockResolvedValueOnce({ playlistClimbs: payload });

      const result = await serverPlaylistClimbs('auth-token', { playlistId: 'pl-1', page: 0, pageSize: 20 });

      expect(result).toEqual(payload);
    });

    it('returns null and logs when the GraphQL request throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      requestMock.mockRejectedValueOnce(new Error('boom'));

      const result = await serverPlaylistClimbs(undefined, { playlistId: 'pl-1' });

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('serverPlaylistClimbs failed:', expect.any(Error));
      errorSpy.mockRestore();
    });

    it('forwards the input as-is so the server fetch matches the client query key', async () => {
      requestMock.mockResolvedValueOnce({ playlistClimbs: { climbs: [], totalCount: 0, hasMore: false } });

      await serverPlaylistClimbs('auth-token', {
        playlistId: 'pl-1',
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20,26',
        angle: 40,
        page: 0,
        pageSize: 20,
      });

      const [, variables] = requestMock.mock.calls[0];
      expect(variables.input).toEqual({
        playlistId: 'pl-1',
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20,26',
        angle: 40,
        page: 0,
        pageSize: 20,
      });
    });
  });

  describe('error-fallback parity', () => {
    // These two were already in the file before this PR, but the previous
    // dynamic-import implementation swallowed errors silently. Asserting the
    // log here keeps the parity with the new helpers explicit.
    it('serverMyBoards logs + returns null on failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      requestMock.mockRejectedValueOnce(new Error('boom'));

      const result = await serverMyBoards('auth-token');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('serverMyBoards failed:', expect.any(Error));
      errorSpy.mockRestore();
    });

    it('serverUserPlaylists logs + returns null on failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      requestMock.mockRejectedValueOnce(new Error('boom'));

      const result = await serverUserPlaylists('auth-token');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('serverUserPlaylists failed:', expect.any(Error));
      errorSpy.mockRestore();
    });

    it('serverGroupedNotifications logs + returns null on failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      requestMock.mockRejectedValueOnce(new Error('boom'));

      const result = await serverGroupedNotifications('auth-token');

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('serverGroupedNotifications failed:', expect.any(Error));
      errorSpy.mockRestore();
    });
  });
});
