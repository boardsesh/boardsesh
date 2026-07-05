import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { GetClimbQueryVariables } from '../operations';

// Local-first dispatcher: local when the board is downloaded + filters supported
// (even online); network otherwise (online); empty/null when offline with no local data.

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

import { resolveClimbSearch, resolveClimbSearchCount, resolveClimb } from '../offline-search';

const fakeDb = { tag: 'db' };
const input: ClimbSearchInput = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '', angle: 40 };
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

describe('resolveClimbSearch (local-first)', () => {
  it('reads local when downloaded + supported, even online', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await resolveClimbSearch(input);
    expect(result.climbs[0].uuid).toBe('local');
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the network when the board is not downloaded (online)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await resolveClimbSearch(input);
    expect(result.climbs[0].uuid).toBe('net');
    expect(searchClimbsLocal).not.toHaveBeenCalled();
  });

  it('falls back to the network for an unsupported filter (online, even if downloaded)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    isOfflineSearchSupported.mockReturnValue(false);
    const result = await resolveClimbSearch(input);
    expect(result.climbs[0].uuid).toBe('net');
  });

  it('returns empty when offline with no local data', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await resolveClimbSearch(input);
    expect(result.climbs).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('resolveClimbSearchCount + resolveClimb', () => {
  it('counts locally when downloaded (online)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    expect(await resolveClimbSearchCount(input)).toBe(7);
    expect(request).not.toHaveBeenCalled();
  });

  it('counts via network when not downloaded', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    expect(await resolveClimbSearchCount(input)).toBe(99);
  });

  it('reads climb detail locally when downloaded (online)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const climb = await resolveClimb(climbVars);
    expect(climb?.uuid).toBe('local-detail');
    expect(request).not.toHaveBeenCalled();
  });

  it('reads climb detail via network when not downloaded', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const climb = await resolveClimb(climbVars);
    expect(climb?.uuid).toBe('net-detail');
  });
});
