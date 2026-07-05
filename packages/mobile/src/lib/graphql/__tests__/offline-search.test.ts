import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onlineManager } from '@tanstack/react-query';

// Local-first dispatcher: local when the board is downloaded + filters supported
// (even online); network otherwise (online); empty/null when offline with no local data.

const fakeDb = { tag: 'db' };
vi.mock('../../../db', () => ({ getDatabaseHandle: () => fakeDb }));

const isBoardDownloadedLocally = vi.fn();
vi.mock('../../../db/queries/board-download-status', () => ({
  isBoardDownloadedLocally: (...args: unknown[]) => isBoardDownloadedLocally(...args),
}));

const searchClimbsLocal = vi.fn();
const countClimbsLocal = vi.fn();
const isOfflineSearchSupported = vi.fn(() => true);
vi.mock('../../../db/queries/search-climbs-local', () => ({
  searchClimbsLocal: (...args: unknown[]) => searchClimbsLocal(...args),
  countClimbsLocal: (...args: unknown[]) => countClimbsLocal(...args),
  isOfflineSearchSupported: (...args: unknown[]) => isOfflineSearchSupported(...args),
}));

const getClimbLocal = vi.fn();
vi.mock('../../../db/queries/get-climb-local', () => ({
  getClimbLocal: (...args: unknown[]) => getClimbLocal(...args),
}));

const request = vi.fn();
vi.mock('../client', () => ({ getHttpClient: () => ({ request }) }));

import { resolveClimbSearch, resolveClimbSearchCount, resolveClimb } from '../offline-search';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const input = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '', angle: 40 } as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const climbVars = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '', angle: 40, climbUuid: 'c1' } as any;

function setOnline(online: boolean) {
  vi.spyOn(onlineManager, 'isOnline').mockReturnValue(online);
}

beforeEach(() => {
  vi.clearAllMocks();
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
