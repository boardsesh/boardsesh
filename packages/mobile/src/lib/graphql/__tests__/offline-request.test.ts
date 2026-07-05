import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

// Client-level offline-aware interceptor: routes a registered document to local
// SQLite when the board is downloaded + filters supported (even online), to the
// network otherwise (online), and to a per-op empty/null fallback when offline
// with no local data. Any unregistered document is a straight network passthrough.

const {
  getDatabaseHandle,
  isBoardDownloadedLocally,
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
  getClimbLocal,
  request,
} = vi.hoisted(() => ({
  getDatabaseHandle: vi.fn(),
  isBoardDownloadedLocally: vi.fn(),
  searchClimbsLocal: vi.fn(),
  countClimbsLocal: vi.fn(),
  isOfflineSearchSupported: vi.fn(),
  getClimbLocal: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../../../db', () => ({ getDatabaseHandle }));
vi.mock('../../../db/queries/board-download-status', () => ({ isBoardDownloadedLocally }));
vi.mock('../../../db/queries/search-climbs-local', () => ({
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
}));
vi.mock('../../../db/queries/get-climb-local', () => ({ getClimbLocal }));
vi.mock('../client', () => ({ getHttpClient: () => ({ request }) }));

const fakeDb = { tag: 'db' };

import { offlineAwareRequest } from '../offline-request';
import {
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_CLIMB,
  type SearchClimbsQueryResponse,
  type SearchClimbsCountQueryResponse,
  type GetClimbQueryResponse,
  type GetClimbQueryVariables,
} from '../operations';

const searchInput: ClimbSearchInput = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '', angle: 40 };
const climbVars: GetClimbQueryVariables = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 5,
  setIds: '',
  angle: 40,
  climbUuid: 'c1',
};

function setOnline(online: boolean) {
  vi.spyOn(onlineManager, 'isOnline').mockReturnValue(online);
}

beforeEach(() => {
  vi.clearAllMocks();
  getDatabaseHandle.mockReturnValue(fakeDb);
  isOfflineSearchSupported.mockReturnValue(true);
  searchClimbsLocal.mockResolvedValue({ climbs: [{ uuid: 'local' }], hasMore: false });
  countClimbsLocal.mockResolvedValue(7);
  getClimbLocal.mockResolvedValue({ uuid: 'local-detail' });
  request.mockResolvedValue({
    searchClimbs: { climbs: [{ uuid: 'net' }], hasMore: true, totalCount: 99 },
    climb: { uuid: 'net-detail' },
  });
});

describe('offlineAwareRequest — SEARCH_CLIMBS', () => {
  it('reads local when downloaded + supported, even online, returning the raw response shape', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [{ uuid: 'local' }], hasMore: false } });
    expect(searchClimbsLocal).toHaveBeenCalledWith(fakeDb, searchInput);
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the network when the board is not downloaded (online), with the { input } wrapping', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result.searchClimbs.climbs[0].uuid).toBe('net');
    expect(searchClimbsLocal).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(SEARCH_CLIMBS, { input: searchInput });
  });

  it('short-circuits an unsupported filter before probing the download (online, downloaded)', async () => {
    setOnline(true);
    isOfflineSearchSupported.mockReturnValue(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result.searchClimbs.climbs[0].uuid).toBe('net');
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalled();
  });

  it('returns the empty fallback when offline with no local data', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [], hasMore: false } });
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the network when the db handle is null (online)', async () => {
    setOnline(true);
    getDatabaseHandle.mockReturnValue(null);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result.searchClimbs.climbs[0].uuid).toBe('net');
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — SEARCH_CLIMBS_COUNT', () => {
  it('counts locally when downloaded (online)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result).toEqual({ searchClimbs: { totalCount: 7 } });
    expect(request).not.toHaveBeenCalled();
  });

  it('counts via the network when not downloaded', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result.searchClimbs.totalCount).toBe(99);
    expect(countClimbsLocal).not.toHaveBeenCalled();
  });

  it('returns totalCount 0 when offline with no local data', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result).toEqual({ searchClimbs: { totalCount: 0 } });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — GET_CLIMB', () => {
  it('reads detail locally when downloaded, without consulting the filter-support gate', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: { uuid: 'local-detail' } });
    expect(isOfflineSearchSupported).not.toHaveBeenCalled();
    expect(getClimbLocal).toHaveBeenCalledWith(fakeDb, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'c1',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads detail via the network when not downloaded, passing the vars through flat', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result.climb?.uuid).toBe('net-detail');
    expect(getClimbLocal).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(GET_CLIMB, climbVars);
  });

  it('returns { climb: null } when offline with no local data', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: null });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — unregistered document', () => {
  it('passes straight through to the network, even offline, without probing local sources', async () => {
    setOnline(false);
    request.mockResolvedValue({ ping: 'pong' });
    const result = await offlineAwareRequest<{ ping: string }>('query Ping { ping }', {});
    expect(result).toEqual({ ping: 'pong' });
    expect(getDatabaseHandle).not.toHaveBeenCalled();
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('query Ping { ping }', {});
  });
});
