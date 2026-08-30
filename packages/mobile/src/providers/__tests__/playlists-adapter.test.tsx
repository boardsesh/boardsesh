// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import type { PlaylistsAdapter } from '@boardsesh/playlists-react';

let capturedAdapter: PlaylistsAdapter | undefined;
vi.mock('@boardsesh/playlists-react', () => ({
  PlaylistsAdapterProvider: ({ value, children }: { value: PlaylistsAdapter; children: ReactNode }) => {
    capturedAdapter = value;
    return children;
  },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'generated-local-uuid' }));

let useLocalPlaylists = false;
let useAccountFeatures = true;
let chooseLocalProfile = true;
let workOffline = false;
vi.mock('../auth-provider', () => ({
  useAuth: () => ({ accessCapabilities: { useLocalPlaylists, useAccountFeatures, chooseLocalProfile } }),
}));

vi.mock('../../settings', () => ({ useSetting: () => [workOffline, vi.fn()] }));

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

const fakeDb = { tag: 'local-db' };
vi.mock('../../db', () => ({ getDatabaseHandle: () => fakeDb }));

const localPlaylist: Playlist = {
  id: 'local-1',
  uuid: 'local-1',
  boardType: 'kilter',
  layoutId: 1,
  name: 'Projects',
  isPublic: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  climbCount: 0,
  followerCount: 0,
  isFollowedByMe: false,
  isPinnedByMe: false,
};
const getPlaylistsLocalMock = vi.hoisted(() => vi.fn(async () => [localPlaylist]));
const getPlaylistLocalMock = vi.hoisted(() => vi.fn(async () => localPlaylist));
const getPlaylistClimbsLocalMock = vi.hoisted(() => vi.fn(async () => ({ climbs: [], totalCount: 0, hasMore: false })));
const createPlaylistLocalMock = vi.hoisted(() => vi.fn(async () => localPlaylist));
const updatePlaylistLocalMock = vi.hoisted(() => vi.fn(async () => localPlaylist));
const deletePlaylistLocalMock = vi.hoisted(() => vi.fn(async () => true));
const removeClimbFromPlaylistLocalMock = vi.hoisted(() => vi.fn(async () => true));
const reorderPlaylistClimbLocalMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../hooks/use-offline-mutations', () => ({
  getPlaylistsLocal: getPlaylistsLocalMock,
  getPlaylistLocal: getPlaylistLocalMock,
  getPlaylistClimbsLocal: getPlaylistClimbsLocalMock,
  createPlaylistLocal: createPlaylistLocalMock,
  updatePlaylistLocal: updatePlaylistLocalMock,
  deletePlaylistLocal: deletePlaylistLocalMock,
  removeClimbFromPlaylistLocal: removeClimbFromPlaylistLocalMock,
  reorderPlaylistClimbLocal: reorderPlaylistClimbLocalMock,
}));

vi.mock('../../lib/playlists/recents-store', () => ({ mobileRecentsAdapter: {} }));

import { PlaylistsAdapterWrapper } from '../playlists-adapter';

beforeEach(() => {
  vi.clearAllMocks();
  capturedAdapter = undefined;
  useLocalPlaylists = false;
  useAccountFeatures = true;
  chooseLocalProfile = true;
  workOffline = false;
});

describe('PlaylistsAdapterWrapper', () => {
  it('retains the account GraphQL adapter outside local mode', async () => {
    requestMock.mockResolvedValue({ ok: true });
    render(<PlaylistsAdapterWrapper>{null}</PlaylistsAdapterWrapper>);

    await expect(capturedAdapter?.executeGraphQL('query Account')).resolves.toEqual({ ok: true });
    expect(capturedAdapter?.localLibrary).toBeUndefined();
  });

  it('uses local CRUD overrides and rejects GraphQL in local mode', async () => {
    useLocalPlaylists = true;
    render(<PlaylistsAdapterWrapper>{null}</PlaylistsAdapterWrapper>);

    await expect(capturedAdapter?.executeGraphQL('query MustNotRun')).rejects.toThrow(
      'Local playlists cannot use GraphQL',
    );
    await expect(capturedAdapter?.localLibrary?.list({ boardType: 'kilter', layoutId: 1 })).resolves.toMatchObject({
      playlists: [localPlaylist],
      totalCount: 1,
      hasMore: false,
    });
    await capturedAdapter?.localLibrary?.create({ boardType: 'kilter', layoutId: 1, name: 'Projects' });
    await capturedAdapter?.localLibrary?.get('local-1');
    await capturedAdapter?.localLibrary?.listClimbs({ playlistId: 'local-1' });
    await capturedAdapter?.localLibrary?.delete('local-1');
    await capturedAdapter?.localLibrary?.removeClimb({ playlistId: 'local-1', climbUuid: 'climb-1' });
    await capturedAdapter?.localLibrary?.reorderClimb({ playlistId: 'local-1', climbUuid: 'climb-1', newIndex: 0 });

    expect(createPlaylistLocalMock).toHaveBeenCalledWith(
      fakeDb,
      { boardType: 'kilter', layoutId: 1, name: 'Projects' },
      'generated-local-uuid',
      'local-only',
    );
    expect(deletePlaylistLocalMock).toHaveBeenCalledWith(fakeDb, 'local-1', 'local-only');
    expect(getPlaylistLocalMock).toHaveBeenCalledWith(fakeDb, 'local-1');
    expect(getPlaylistClimbsLocalMock).toHaveBeenCalledWith(fakeDb, { playlistId: 'local-1' });
    expect(removeClimbFromPlaylistLocalMock).toHaveBeenCalledWith(
      fakeDb,
      { playlistId: 'local-1', climbUuid: 'climb-1' },
      'local-only',
    );
    expect(reorderPlaylistClimbLocalMock).toHaveBeenCalledWith(
      fakeDb,
      { playlistId: 'local-1', climbUuid: 'climb-1', newIndex: 0 },
      'local-only',
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('uses account-delivery SQLite overrides in Work Offline', async () => {
    workOffline = true;
    render(<PlaylistsAdapterWrapper>{null}</PlaylistsAdapterWrapper>);

    await expect(capturedAdapter?.executeGraphQL('mutation Social')).rejects.toThrow('Go online');
    await capturedAdapter?.localLibrary?.create({ boardType: 'kilter', layoutId: 1, name: 'Projects' });
    await capturedAdapter?.localLibrary?.update({ playlistId: 'local-1', name: 'Next' });
    await capturedAdapter?.localLibrary?.delete('local-1');

    expect(createPlaylistLocalMock).toHaveBeenCalledWith(
      fakeDb,
      { boardType: 'kilter', layoutId: 1, name: 'Projects' },
      'generated-local-uuid',
      'account',
    );
    expect(updatePlaylistLocalMock).toHaveBeenCalledWith(fakeDb, { playlistId: 'local-1', name: 'Next' }, 'account');
    expect(deletePlaylistLocalMock).toHaveBeenCalledWith(fakeDb, 'local-1', 'account');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
