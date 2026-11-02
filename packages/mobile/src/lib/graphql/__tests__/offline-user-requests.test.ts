import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import { GET_TICKS } from '@boardsesh/graphql/operations';
import { GET_FAVORITES } from '@boardsesh/graphql/operations/favorites';
import {
  GET_ALL_USER_PLAYLISTS,
  GET_USER_PLAYLISTS,
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  GET_PLAYLISTS_FOR_CLIMB,
  GET_PLAYLISTS_FOR_CLIMBS,
  GET_PLAYLIST_SETTERS,
} from '@boardsesh/graphql/operations/playlists';

const readers = vi.hoisted(() => ({
  ticks: vi.fn(),
  favorites: vi.fn(),
  allPlaylists: vi.fn(),
  userPlaylists: vi.fn(),
  playlist: vi.fn(),
  playlistClimbs: vi.fn(),
  playlistsForClimb: vi.fn(),
  playlistsForClimbs: vi.fn(),
  playlistSetters: vi.fn(),
}));
const transport = vi.hoisted(() => ({
  request: vi.fn(),
  getDatabaseHandle: vi.fn(),
  canServeLocalUserData: vi.fn(),
  assertLocalUserDataOwner: vi.fn(),
  readLocalUserId: vi.fn(),
  isBoardDownloadedLocally: vi.fn(),
  recordOfflineRead: vi.fn(),
  recordOfflineReadUnavailable: vi.fn(),
  recordLocalUserRead: vi.fn(),
}));
const state = vi.hoisted(() => ({
  credentialGeneration: 0,
  connectivity: { effectiveOffline: false, reason: null as string | null },
}));

vi.mock('../../../db', () => ({ getDatabaseHandle: transport.getDatabaseHandle }));
vi.mock('../client', () => ({ getHttpClient: () => ({ request: transport.request }) }));
vi.mock('../../local-user-id', () => ({ readLocalUserId: transport.readLocalUserId }));
vi.mock('../../privacy/privacy-cache', () => ({ getCredentialGeneration: () => state.credentialGeneration }));
vi.mock('../../connectivity/connectivity-store', () => ({ getConnectivitySnapshot: () => state.connectivity }));
vi.mock('../../../offline/offline-usage-signal', () => ({
  recordOfflineRead: transport.recordOfflineRead,
  recordOfflineReadUnavailable: transport.recordOfflineReadUnavailable,
}));
vi.mock('../offline-user-read-recovery', () => ({ recordLocalUserRead: transport.recordLocalUserRead }));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/offline-sync')>()),
  canServeLocalUserData: transport.canServeLocalUserData,
  assertLocalUserDataOwner: transport.assertLocalUserDataOwner,
}));
vi.mock('../../../db/queries/get-ticks-local', () => ({ getTicksLocal: readers.ticks }));
vi.mock('../../../db/queries/get-favorite-status-local', () => ({ getFavoriteStatusLocal: readers.favorites }));
vi.mock('../../../db/queries/get-playlists-local', () => ({
  getAllUserPlaylistsLocal: readers.allPlaylists,
  getUserPlaylistsLocal: readers.userPlaylists,
  getPlaylistLocal: readers.playlist,
  getPlaylistClimbsLocal: readers.playlistClimbs,
  getPlaylistsForClimbLocal: readers.playlistsForClimb,
  getPlaylistsForClimbsLocal: readers.playlistsForClimbs,
  getPlaylistSettersLocal: readers.playlistSetters,
  getPlaylistReadUnavailableReason: vi.fn(async () => 'board_not_downloaded'),
}));
// The real user registrar is loaded. Catalogue readers are irrelevant here and
// must never be asked whether a user's rows require a board download.
vi.mock('../../../db/queries/board-download-status', () => ({
  isBoardDownloadedLocally: transport.isBoardDownloadedLocally,
  isBoardTypeDownloadedLocally: vi.fn(),
  isClimbLayoutDownloadedLocally: vi.fn(),
}));
vi.mock('../../../db/queries/search-climbs-local', () => ({
  searchClimbsLocal: vi.fn(),
  countClimbsLocal: vi.fn(),
  isOfflineSearchSupported: vi.fn(),
}));
vi.mock('../../../db/queries/get-climb-local', () => ({ getClimbLocal: vi.fn() }));
vi.mock('../../../db/queries/climb-revisions-local', () => ({ fillClimbRevisionNumbersLocal: vi.fn() }));
vi.mock('../../../db/queries/get-boardsesh-grade-local', () => ({
  getBoardseshGradeLocal: vi.fn(),
  getBoardseshGradesForAnglesLocal: vi.fn(),
}));
vi.mock('../../../db/queries/get-setter-stats-local', () => ({ getSetterStatsLocal: vi.fn() }));
vi.mock('../../../db/queries/get-hold-heatmap-local', () => ({ getHoldHeatmapLocalWithCount: vi.fn() }));
vi.mock('../../../db/queries/followed-authors-local', () => ({ canReadFollowedAuthors: vi.fn() }));
vi.mock('../../../db/queries/get-climb-stats-history-local', () => ({ getClimbStatsHistoryLocal: vi.fn() }));
vi.mock('../../../db/queries/get-similar-climbs-local', () => ({ getSimilarClimbsLocal: vi.fn() }));
vi.mock('../../../offline/hold-index-parser', () => ({ parseHoldRows: vi.fn() }));

import { offlineAwareRequest } from '../offline-request';
import { setOfflineEngineEnabled, __resetOfflineEngineForTests } from '../../offline-engine';
import { BackendUnavailableError } from '../../connectivity/backend-unavailable-error';
import { createAbortError, createGraphqlTimeoutError } from '../request-timeout';

const fakeDb = { tag: 'user-db' };
const tickVariables = { input: { boardType: 'kilter', climbUuids: ['climb-1'] } };
const favoriteVariables = { boardName: 'kilter', climbUuids: ['climb-1'], angle: 25 };
const localTickResponse = { ticks: [{ uuid: 'tick-1', upvotes: 0, downvotes: 0, commentCount: 0 }] };
const serverTickResponse = { ticks: [{ uuid: 'tick-1', upvotes: 7, downvotes: 2, commentCount: 4 }] };

const registeredReads = [
  {
    name: 'ticks',
    document: GET_TICKS,
    variables: tickVariables,
    reader: readers.ticks,
    response: localTickResponse,
    family: 'logbook',
    boardName: 'kilter',
  },
  {
    name: 'favorites',
    document: GET_FAVORITES,
    variables: favoriteVariables,
    reader: readers.favorites,
    response: { favorites: ['climb-1'] },
    family: 'favorites',
    boardName: 'kilter',
  },
  {
    name: 'all owned playlists',
    document: GET_ALL_USER_PLAYLISTS,
    variables: { input: { pageSize: 200 } },
    reader: readers.allPlaylists,
    response: { allUserPlaylists: { playlists: [{ uuid: 'playlist-1' }], totalCount: 1, hasMore: false } },
    family: 'playlists',
    boardName: 'all',
  },
  {
    name: 'board owned playlists',
    document: GET_USER_PLAYLISTS,
    variables: { input: { boardType: 'kilter', layoutId: 1 } },
    reader: readers.userPlaylists,
    response: { userPlaylists: [{ uuid: 'playlist-1' }] },
    family: 'playlists',
    boardName: 'kilter',
  },
  {
    name: 'playlist metadata',
    document: GET_PLAYLIST,
    variables: { playlistId: 'playlist-1' },
    reader: readers.playlist,
    response: { playlist: { uuid: 'playlist-1', name: 'Projects' } },
    family: 'playlists',
    boardName: 'all',
  },
  {
    name: 'playlist climb page',
    document: GET_PLAYLIST_CLIMBS,
    variables: { input: { playlistId: 'playlist-1', page: 0, pageSize: 20, view: { sortBy: 'difficulty' } } },
    reader: readers.playlistClimbs,
    response: { playlistClimbs: { climbs: [{ uuid: 'climb-1' }], totalCount: 1, hasMore: false } },
    family: 'playlists',
    boardName: 'all',
  },
  {
    name: 'single-climb memberships',
    document: GET_PLAYLISTS_FOR_CLIMB,
    variables: { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1' } },
    reader: readers.playlistsForClimb,
    response: { playlistsForClimb: ['playlist-1'] },
    family: 'playlists',
    boardName: 'kilter',
  },
  {
    name: 'batch memberships',
    document: GET_PLAYLISTS_FOR_CLIMBS,
    variables: { input: { boardType: 'kilter', layoutId: 1, climbUuids: ['climb-1'] } },
    reader: readers.playlistsForClimbs,
    response: { playlistsForClimbs: [{ climbUuid: 'climb-1', playlistUuids: ['playlist-1'] }] },
    family: 'playlists',
    boardName: 'kilter',
  },
  {
    name: 'playlist setters',
    document: GET_PLAYLIST_SETTERS,
    variables: { input: { playlistId: 'playlist-1' } },
    reader: readers.playlistSetters,
    response: { playlistSetters: [{ username: 'setter', climbCount: 1 }] },
    family: 'playlists',
    boardName: 'all',
  },
];

function setOnline(online: boolean, reason = 'device_offline'): void {
  vi.spyOn(onlineManager, 'isOnline').mockReturnValue(online);
  state.connectivity = { effectiveOffline: !online, reason: online ? null : reason };
}

beforeEach(() => {
  vi.resetAllMocks();
  state.credentialGeneration = 0;
  setOfflineEngineEnabled(true);
  setOnline(true);
  transport.getDatabaseHandle.mockReturnValue(fakeDb);
  transport.canServeLocalUserData.mockResolvedValue(true);
  transport.assertLocalUserDataOwner.mockResolvedValue('ok');
  transport.readLocalUserId.mockResolvedValue('user-a');
  transport.request.mockResolvedValue(serverTickResponse);
  for (const read of registeredReads) read.reader.mockResolvedValue(read.response);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetOfflineEngineForTests();
});

describe('actual user-data registrations', () => {
  it.each(registeredReads)('keeps $name network-first while online with the engine enabled', async (read) => {
    const networkResponse = { serverAnswer: read.name };
    transport.request.mockResolvedValue(networkResponse);
    expect(await offlineAwareRequest(read.document, read.variables)).toBe(networkResponse);
    expect(transport.request).toHaveBeenCalledWith(read.document, read.variables);
    expect(transport.getDatabaseHandle).not.toHaveBeenCalled();
    expect(read.reader).not.toHaveBeenCalled();
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
  });

  it('preserves real vote and comment counts on a healthy connection', async () => {
    expect(await offlineAwareRequest(GET_TICKS, tickVariables)).toEqual(serverTickResponse);
    expect(readers.ticks).not.toHaveBeenCalled();
  });

  it.each(registeredReads)('serves $name offline without a catalogue-download gate', async (read) => {
    setOnline(false);
    expect(await offlineAwareRequest(read.document, read.variables)).toBe(read.response);
    expect(read.reader).toHaveBeenCalledOnce();
    expect(transport.canServeLocalUserData).toHaveBeenCalledWith(fakeDb, 'user-a');
    expect(transport.isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'offline_local',
      surface: read.family,
      boardName: read.boardName,
    });
    expect(transport.recordLocalUserRead).toHaveBeenCalledExactlyOnceWith(read.family, read.boardName);
  });

  it.each(['device_offline', 'backend_unreachable', 'offline_mode'])(
    'uses the effective-offline source selection and usage lane for %s',
    async (reason) => {
      setOnline(false, reason);
      const lane = reason === 'device_offline' ? 'offline_local' : `${reason}_local`;
      expect(await offlineAwareRequest(GET_TICKS, tickVariables)).toBe(localTickResponse);
      expect(transport.recordOfflineRead).toHaveBeenCalledWith({ lane, surface: 'logbook', boardName: 'kilter' });
    },
  );

  it('serves user data offline even when the online local-first platform gate is off', async () => {
    setOfflineEngineEnabled(false);
    setOnline(false);
    expect(await offlineAwareRequest(GET_TICKS, tickVariables)).toBe(localTickResponse);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('passes the requested UUIDs to the global-identity favorite reader', async () => {
    setOnline(false);
    await offlineAwareRequest(GET_FAVORITES, favoriteVariables);
    expect(readers.favorites).toHaveBeenCalledWith(fakeDb, ['climb-1'], 'user-a');
  });

  it.each([
    { document: GET_TICKS, variables: tickVariables, reader: readers.ticks, empty: { ticks: [] } },
    { document: GET_FAVORITES, variables: favoriteVariables, reader: readers.favorites, empty: { favorites: [] } },
    {
      document: GET_ALL_USER_PLAYLISTS,
      variables: { input: {} },
      reader: readers.allPlaylists,
      empty: { allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } },
    },
  ])('accepts a genuinely empty complete local answer', async ({ document, variables, reader, empty }) => {
    setOnline(false);
    reader.mockResolvedValue(empty);
    expect(await offlineAwareRequest(document, variables)).toBe(empty);
    expect(transport.request).not.toHaveBeenCalled();
  });
});

describe('unavailable local data does not become a sticky empty answer', () => {
  it.each(['no database', 'incomplete data', 'wrong owner', 'signed out', 'declined reader'])(
    'preserves the original backend-unavailable error with %s',
    async (missingSource) => {
      setOnline(false);
      const networkError = new BackendUnavailableError('device_offline');
      transport.request.mockRejectedValue(networkError);
      if (missingSource === 'no database') transport.getDatabaseHandle.mockReturnValue(null);
      if (missingSource === 'incomplete data') transport.canServeLocalUserData.mockResolvedValue(false);
      if (missingSource === 'wrong owner') transport.assertLocalUserDataOwner.mockResolvedValue('mismatch');
      if (missingSource === 'signed out') transport.readLocalUserId.mockResolvedValue(null);
      if (missingSource === 'declined reader') readers.ticks.mockResolvedValue(null);

      await expect(offlineAwareRequest(GET_TICKS, tickVariables)).rejects.toBe(networkError);
      expect(transport.request).toHaveBeenCalledWith(GET_TICKS, tickVariables);
      expect(transport.recordOfflineRead).not.toHaveBeenCalled();
      expect(transport.recordLocalUserRead).not.toHaveBeenCalled();
      expect(transport.recordOfflineReadUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: missingSource === 'no database' ? 'local_db_unavailable' : 'user_data_unavailable',
          surface: 'logbook',
          boardName: 'kilter',
        }),
      );
    },
  );

  it('keeps a missing playlist page unavailable instead of claiming zero climbs', async () => {
    setOnline(false);
    readers.playlistClimbs.mockResolvedValue(null);
    const networkError = new BackendUnavailableError('offline_mode');
    transport.request.mockRejectedValue(networkError);
    await expect(offlineAwareRequest(GET_PLAYLIST_CLIMBS, { input: { playlistId: 'partly-downloaded' } })).rejects.toBe(
      networkError,
    );
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
  });
});

describe('network-error rescue respects server verdicts', () => {
  it.each([
    { name: 'transport failure', error: new TypeError('Network request failed') },
    { name: 'known backend unavailability', error: new BackendUnavailableError('backend_unreachable') },
    { name: 'request deadline', error: createGraphqlTimeoutError(20_000) },
    { name: 'HTTP 500', error: { response: { status: 500 } } },
    { name: 'HTTP 503', error: { response: { status: 503 } } },
    { name: 'edge HTTP 404', error: { response: { status: 404 } } },
    {
      name: 'masked resolver failure',
      error: { response: { status: 200, errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } },
    },
  ])('rescues $name with complete owned local rows', async ({ error }) => {
    transport.request.mockRejectedValue(error);
    expect(await offlineAwareRequest(GET_TICKS, tickVariables)).toBe(localTickResponse);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(readers.ticks).toHaveBeenCalledOnce();
    expect(transport.recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'network_error_local',
      surface: 'logbook',
      boardName: 'kilter',
    });
  });

  it.each([
    { name: 'HTTP 401', error: { response: { status: 401 } } },
    { name: 'HTTP 403', error: { response: { status: 403 } } },
    {
      name: 'validation rejection',
      error: { response: { status: 200, errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] } },
    },
    { name: 'cancelled request', error: createAbortError('user navigated away') },
  ])('does not hide a $name behind cached rows', async ({ error }) => {
    transport.request.mockRejectedValue(error);
    await expect(offlineAwareRequest(GET_TICKS, tickVariables)).rejects.toBe(error);
    expect(readers.ticks).not.toHaveBeenCalled();
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
  });

  it('preserves the network error when a rescue reader declines', async () => {
    const networkError = new TypeError('Network request failed');
    transport.request.mockRejectedValue(networkError);
    readers.ticks.mockResolvedValue(null);
    await expect(offlineAwareRequest(GET_TICKS, tickVariables)).rejects.toBe(networkError);
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
  });
});

describe('in-flight identity, connectivity and cancellation changes', () => {
  it('rejects a local answer after a credential transition without booking a served read', async () => {
    setOnline(false);
    readers.ticks.mockImplementationOnce(async () => {
      state.credentialGeneration += 1;
      return localTickResponse;
    });
    await expect(offlineAwareRequest(GET_TICKS, tickVariables)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
    expect(transport.recordLocalUserRead).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('uses HTTP if connectivity returns while the local read is awaiting SQLite', async () => {
    setOnline(false);
    readers.ticks.mockImplementationOnce(async () => {
      setOnline(true);
      return localTickResponse;
    });
    expect(await offlineAwareRequest(GET_TICKS, tickVariables)).toBe(serverTickResponse);
    expect(transport.request).toHaveBeenCalledWith(GET_TICKS, tickVariables);
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
  });

  it('forwards the original AbortSignal to HTTP', async () => {
    const controller = new AbortController();
    expect(await offlineAwareRequest(GET_TICKS, tickVariables, { signal: controller.signal })).toBe(serverTickResponse);
    expect(transport.request).toHaveBeenCalledWith({
      document: GET_TICKS,
      variables: tickVariables,
      signal: controller.signal,
    });
  });

  it('does no work for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(offlineAwareRequest(GET_TICKS, tickVariables, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transport.request).not.toHaveBeenCalled();
    expect(readers.ticks).not.toHaveBeenCalled();
  });

  it('does not rescue HTTP cancelled by its caller', async () => {
    const controller = new AbortController();
    transport.request.mockImplementationOnce(async () => {
      controller.abort();
      throw createAbortError('cancelled');
    });
    await expect(offlineAwareRequest(GET_TICKS, tickVariables, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(readers.ticks).not.toHaveBeenCalled();
  });

  it('discards local rows if the caller cancels while SQLite is reading', async () => {
    setOnline(false);
    const controller = new AbortController();
    readers.ticks.mockImplementationOnce(async () => {
      controller.abort();
      return localTickResponse;
    });
    await expect(offlineAwareRequest(GET_TICKS, tickVariables, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transport.recordOfflineRead).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });
});
