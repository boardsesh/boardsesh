import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

// Client-level offline-aware interceptor: routes a registered document to local
// SQLite when the board is downloaded + filters supported (even online), to the
// network otherwise (online), and to a per-op empty/null fallback when offline
// with no local data. Any unregistered document is a straight network passthrough.
// Reading downloaded data is NOT gated by the offline-engine flag — whenever the
// network is down a downloaded board reads local regardless of the flag (issue
// #3888); the flag only gates the ONLINE local-first optimization. The suites
// below run with the engine explicitly enabled (exercising the online path)
// except the final describe, which covers the flag-off online + offline paths.

const {
  getDatabaseHandle,
  isBoardDownloadedLocally,
  isBoardTypeDownloadedLocally,
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
  getClimbLocal,
  getBoardseshGradeLocal,
  getBoardseshGradesForAnglesLocal,
  request,
  recordOfflineRead,
  recordOfflineReadUnavailable,
} = vi.hoisted(() => ({
  getDatabaseHandle: vi.fn(),
  isBoardDownloadedLocally: vi.fn(),
  isBoardTypeDownloadedLocally: vi.fn(),
  searchClimbsLocal: vi.fn(),
  countClimbsLocal: vi.fn(),
  isOfflineSearchSupported: vi.fn(),
  getClimbLocal: vi.fn(),
  getBoardseshGradeLocal: vi.fn(),
  getBoardseshGradesForAnglesLocal: vi.fn(),
  request: vi.fn(),
  recordOfflineRead: vi.fn(),
  recordOfflineReadUnavailable: vi.fn(),
}));

vi.mock('../../../db', () => ({ getDatabaseHandle }));
vi.mock('../../../db/queries/board-download-status', () => ({
  isBoardDownloadedLocally,
  isBoardTypeDownloadedLocally,
}));
vi.mock('../../../db/queries/search-climbs-local', () => ({
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
}));
vi.mock('../../../db/queries/get-climb-local', () => ({ getClimbLocal }));
vi.mock('../../../db/queries/get-boardsesh-grade-local', () => ({
  getBoardseshGradeLocal,
  getBoardseshGradesForAnglesLocal,
}));
vi.mock('../client', () => ({ getHttpClient: () => ({ request }) }));
// The rollup gate itself is covered in @boardsesh/offline-sync; here we assert
// the interceptor hands it the right LANE for each terminal outcome (#4317).
vi.mock('../../../offline/offline-usage-signal', () => ({
  recordOfflineRead,
  recordOfflineReadUnavailable,
}));

// The connectivity store decides WHICH offline lane a local read belongs to
// (issue #4862): our outage, the climber's choice, or a tunnel.
const connectivity = vi.hoisted(() => ({
  snapshot: { effectiveOffline: false, reason: null as string | null },
}));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => connectivity.snapshot,
}));

const fakeDb = { tag: 'db' };

import { offlineAwareRequest } from '../offline-request';
import { setOfflineEngineEnabled, __resetOfflineEngineForTests } from '../../offline-engine';
import {
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_CLIMB,
  type SearchClimbsQueryResponse,
  type SearchClimbsCountQueryResponse,
  type GetClimbQueryResponse,
  type GetClimbQueryVariables,
} from '../operations';
import {
  BOARDSESH_GRADE,
  BOARDSESH_GRADES_FOR_ANGLES,
  type BoardseshGradeResponse,
  type BoardseshGradesForAnglesResponse,
} from '@boardsesh/graphql/operations';

const searchInput: ClimbSearchInput = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '', angle: 40 };
const climbVars: GetClimbQueryVariables = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 5,
  setIds: '',
  angle: 40,
  climbUuid: 'c1',
};
const gradeVars = { boardName: 'kilter', climbUuid: 'c1', angle: 40 };
const gradesForAnglesVars = { boardName: 'kilter', climbUuid: 'c1' };
const localGrade = {
  localGrade: 20,
  universalGrade: 19,
  gradeLow: 18,
  gradeHigh: 20,
  confidence: 'confirmed',
  ascensionistCount: 30,
  modelVersion: 'offline',
  computedAt: '2026-01-01T00:00:00Z',
};

function setOnline(online: boolean) {
  vi.spyOn(onlineManager, 'isOnline').mockReturnValue(online);
  // onlineManager is DOWNSTREAM of the store since #4862, so a test that moves
  // one and not the other would assert a state the app cannot reach.
  connectivity.snapshot = { effectiveOffline: !online, reason: online ? null : 'device_offline' };
}

/** Offline for a specific reason — the split the lanes exist to make. */
function setOfflineBecause(reason: 'backend_unreachable' | 'offline_mode' | 'device_offline') {
  vi.spyOn(onlineManager, 'isOnline').mockReturnValue(false);
  connectivity.snapshot = { effectiveOffline: true, reason };
}

afterEach(() => {
  __resetOfflineEngineForTests();
});

beforeEach(() => {
  vi.clearAllMocks();
  connectivity.snapshot = { effectiveOffline: false, reason: null };
  setOfflineEngineEnabled(true);
  getDatabaseHandle.mockReturnValue(fakeDb);
  isOfflineSearchSupported.mockReturnValue(true);
  searchClimbsLocal.mockResolvedValue({ climbs: [{ uuid: 'local' }], hasMore: false });
  countClimbsLocal.mockResolvedValue(7);
  getClimbLocal.mockResolvedValue({ uuid: 'local-detail' });
  isBoardTypeDownloadedLocally.mockResolvedValue(true);
  getBoardseshGradeLocal.mockResolvedValue(localGrade);
  getBoardseshGradesForAnglesLocal.mockResolvedValue([{ angle: 40, ...localGrade }]);
  request.mockResolvedValue({
    searchClimbs: { climbs: [{ uuid: 'net' }], hasMore: true, totalCount: 99 },
    climb: { uuid: 'net-detail' },
    boardseshGrade: { ...localGrade, modelVersion: 'v1', localGrade: 99 },
    boardseshGradesForAngles: [{ angle: 40, ...localGrade, modelVersion: 'v1', localGrade: 99 }],
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

  it('serves a downloaded board from local SQLite while offline (the flagship offline browse)', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [{ uuid: 'local' }], hasMore: false } });
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

  it('degrades to the network when a registered document is called without variables (online)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS);
    expect(result.searchClimbs.climbs[0].uuid).toBe('net');
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(SEARCH_CLIMBS, undefined);
  });

  it('still returns the offline fallback when a registered document is called without variables (offline)', async () => {
    setOnline(false);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS);
    expect(result).toEqual({ searchClimbs: { climbs: [], hasMore: false } });
    expect(request).not.toHaveBeenCalled();
  });

  it('propagates a local read error to the caller instead of retrying over the network', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    searchClimbsLocal.mockRejectedValue(new Error('sqlite read failed'));
    await expect(offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput })).rejects.toThrow(
      'sqlite read failed',
    );
    expect(request).not.toHaveBeenCalled();
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

  it('short-circuits an unsupported filter to the network, same as the list (shared gate)', async () => {
    setOnline(true);
    isOfflineSearchSupported.mockReturnValue(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result.searchClimbs.totalCount).toBe(99);
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(countClimbsLocal).not.toHaveBeenCalled();
  });

  it('counts locally when downloaded (offline)', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result).toEqual({ searchClimbs: { totalCount: 7 } });
    expect(request).not.toHaveBeenCalled();
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

  it('retries a local miss over the network while online (row not synced yet, e.g. a live presence climb)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getClimbLocal.mockResolvedValue(null);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result.climb?.uuid).toBe('net-detail');
    expect(getClimbLocal).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(GET_CLIMB, climbVars);
  });

  it('lets a local miss stand while offline — { climb: null }, no doomed network call', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getClimbLocal.mockResolvedValue(null);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: null });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — empty search results are answers, not misses', () => {
  it('does not retry an empty local SEARCH_CLIMBS result over the network', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    searchClimbsLocal.mockResolvedValue({ climbs: [], hasMore: false });
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [], hasMore: false } });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — BOARDSESH_GRADE', () => {
  it('reads the grade locally when the board type is downloaded (online, local-first)', async () => {
    setOnline(true);
    const result = await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, gradeVars);
    expect(result).toEqual({ boardseshGrade: localGrade });
    expect(getBoardseshGradeLocal).toHaveBeenCalledWith(fakeDb, gradeVars);
    expect(request).not.toHaveBeenCalled();
  });

  it('serves the grade from local SQLite while offline', async () => {
    setOnline(false);
    const result = await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, gradeVars);
    expect(result.boardseshGrade?.confidence).toBe('confirmed');
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the network when the board type is not downloaded (online)', async () => {
    setOnline(true);
    isBoardTypeDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, gradeVars);
    expect(result.boardseshGrade?.modelVersion).toBe('v1');
    expect(getBoardseshGradeLocal).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(BOARDSESH_GRADE, gradeVars);
  });

  it('retries a local miss over the network while online (row not synced / wrong scope)', async () => {
    setOnline(true);
    getBoardseshGradeLocal.mockResolvedValue(null);
    const result = await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, gradeVars);
    expect(result.boardseshGrade?.modelVersion).toBe('v1');
    expect(getBoardseshGradeLocal).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(BOARDSESH_GRADE, gradeVars);
  });

  it('lets a local miss stand while offline — { boardseshGrade: null }, no doomed network call', async () => {
    setOnline(false);
    getBoardseshGradeLocal.mockResolvedValue(null);
    const result = await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, gradeVars);
    expect(result).toEqual({ boardseshGrade: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns { boardseshGrade: null } when offline with no local data', async () => {
    setOnline(false);
    isBoardTypeDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, gradeVars);
    expect(result).toEqual({ boardseshGrade: null });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — BOARDSESH_GRADES_FOR_ANGLES', () => {
  it('reads all angles locally when the board type is downloaded (online)', async () => {
    setOnline(true);
    const result = await offlineAwareRequest<BoardseshGradesForAnglesResponse>(
      BOARDSESH_GRADES_FOR_ANGLES,
      gradesForAnglesVars,
    );
    expect(result.boardseshGradesForAngles).toHaveLength(1);
    expect(result.boardseshGradesForAngles[0].angle).toBe(40);
    expect(getBoardseshGradesForAnglesLocal).toHaveBeenCalledWith(fakeDb, gradesForAnglesVars);
    expect(request).not.toHaveBeenCalled();
  });

  // Deliberate divergence from BOARDSESH_GRADE (see the "retries a local miss"
  // test above and the registration comment in offline-request.ts): a null single
  // grade IS retried over the network, but an empty by-angle list is NOT. An empty
  // list is often correct (MoonBoard / too-few-ascents climbs are never graded),
  // and neither grade op carries layout/size to distinguish "genuinely ungraded"
  // from "this scope hasn't synced to this device" — so retrying here would add a
  // network round trip on every chart open for the common ungraded case. Accepted
  // consequence: a climb whose grades never synced to this device (cross-scope via
  // party queue / deep link / similar climbs) can show a grade in the collapsed
  // view but an empty expanded by-angle chart, until the board's next sync.
  it('does not retry an empty local list over the network — an empty result is an answer (no grades)', async () => {
    setOnline(true);
    getBoardseshGradesForAnglesLocal.mockResolvedValue([]);
    const result = await offlineAwareRequest<BoardseshGradesForAnglesResponse>(
      BOARDSESH_GRADES_FOR_ANGLES,
      gradesForAnglesVars,
    );
    expect(result).toEqual({ boardseshGradesForAngles: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns the empty list when offline with no local data', async () => {
    setOnline(false);
    isBoardTypeDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<BoardseshGradesForAnglesResponse>(
      BOARDSESH_GRADES_FOR_ANGLES,
      gradesForAnglesVars,
    );
    expect(result).toEqual({ boardseshGradesForAngles: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the network when the board type is not downloaded (online)', async () => {
    setOnline(true);
    isBoardTypeDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<BoardseshGradesForAnglesResponse>(
      BOARDSESH_GRADES_FOR_ANGLES,
      gradesForAnglesVars,
    );
    expect(result.boardseshGradesForAngles[0].modelVersion).toBe('v1');
    expect(getBoardseshGradesForAnglesLocal).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(BOARDSESH_GRADES_FOR_ANGLES, gradesForAnglesVars);
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

describe('offlineAwareRequest — network-failure recovery (connected-but-unreachable)', () => {
  // onlineManager can read "online" when the network can't serve the request: its
  // NetInfo seed is async + defaults true (a cold start can lose the race), and it
  // tracks isConnected, not isInternetReachable. So a request that reaches the
  // network and THROWS must still fall back to local for a downloaded board — the
  // gym-wifi-with-a-dead-upstream / captive-portal case, which is the issue's
  // literal scenario when the flag hasn't resolved yet.

  it('serves a downloaded board from local SQLite when an online request throws (flag off — the cold-start race)', async () => {
    setOfflineEngineEnabled(false);
    setOnline(true); // onlineManager stale-true; the flag never resolved
    isBoardDownloadedLocally.mockResolvedValue(true);
    request.mockRejectedValue(new Error('Network request failed'));
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [{ uuid: 'local' }], hasMore: false } });
    expect(searchClimbsLocal).toHaveBeenCalledWith(fakeDb, searchInput);
  });

  it('serves a downloaded climb from local SQLite when the flag-on miss-retry hits a dead network', async () => {
    // Flag on + online: search serves local before the network, so the only
    // network-reaching path for a downloaded board is the detail miss-retry —
    // local read misses (row not synced), retries the network, the network
    // throws, and the catch recovers to the local (null) result. Set the flag
    // explicitly so this path is deterministic, and assert the local-first read
    // + network retry actually happened, not just the final shape (which the
    // flag-off catch-only path below produces too).
    setOfflineEngineEnabled(true);
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getClimbLocal.mockResolvedValue(null); // local miss → retry over network
    request.mockRejectedValue(new Error('Network request failed'));
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: null });
    // Local-first read for the miss, then the catch-block recovery read.
    expect(getClimbLocal).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(GET_CLIMB, climbVars);
  });

  it('serves a downloaded climb from local SQLite when a flag-off online request throws (cold-start race, detail op)', async () => {
    // Flag off + stale-online: no local-first probe, so the request goes straight
    // to the network, throws, and the catch block is the ONLY thing that reads
    // local — one read, returning the real detail. Distinct from test 1 (which
    // covers the same recovery for SEARCH_CLIMBS) and from the flag-on path above
    // (which reads local twice).
    setOfflineEngineEnabled(false);
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    request.mockRejectedValue(new Error('Network request failed'));
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: { uuid: 'local-detail' } });
    expect(getClimbLocal).toHaveBeenCalledTimes(1);
  });

  it('rethrows the network error when nothing is downloaded (not swallowed into an empty fallback)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    request.mockRejectedValue(new Error('Network request failed'));
    await expect(offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput })).rejects.toThrow(
      'Network request failed',
    );
    expect(searchClimbsLocal).not.toHaveBeenCalled();
  });

  it('rethrows an online network error for an unregistered document untouched', async () => {
    setOnline(true);
    request.mockRejectedValue(new Error('Network request failed'));
    await expect(offlineAwareRequest<{ ping: string }>('query Ping { ping }', {})).rejects.toThrow(
      'Network request failed',
    );
    expect(getDatabaseHandle).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — offline-engine flag OFF', () => {
  beforeEach(() => {
    setOfflineEngineEnabled(false);
  });

  // Online + flag off: the local-first optimization is disabled, so a registered
  // document is a straight network passthrough that never even probes local
  // (pre-offline behavior, and its cost, preserved for the majority).
  it('hits the network for a registered document even when the board is downloaded (online)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result.searchClimbs.climbs[0].uuid).toBe('net');
    expect(searchClimbsLocal).not.toHaveBeenCalled();
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(SEARCH_CLIMBS, { input: searchInput });
  });

  it('is the default state: without an explicit enable, the online optimization never engages', async () => {
    __resetOfflineEngineForTests();
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result.searchClimbs.totalCount).toBe(99);
    expect(countClimbsLocal).not.toHaveBeenCalled();
  });

  // Reading data already on disk is NOT gated by the flag (issue #3888): a
  // downloaded board must open offline even for a user whose flag never resolved
  // — e.g. a cold start with no signal, where PostHog can't deliver the flag.
  it('serves a downloaded board from local SQLite while offline (the #3888 fix)', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [{ uuid: 'local' }], hasMore: false } });
    expect(searchClimbsLocal).toHaveBeenCalledWith(fakeDb, searchInput);
    expect(request).not.toHaveBeenCalled();
  });

  it('counts a downloaded board locally while offline with the flag off', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, {
      input: searchInput,
    });
    expect(result).toEqual({ searchClimbs: { totalCount: 7 } });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads climb detail from local SQLite while offline with the flag off', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: { uuid: 'local-detail' } });
    expect(request).not.toHaveBeenCalled();
  });

  // Nothing downloaded + offline → the per-op empty/null fallback (an answer, not
  // a doomed network call), also flag-independent.
  it('returns the empty fallback offline when nothing is downloaded', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result).toEqual({ searchClimbs: { climbs: [], hasMore: false } });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns { climb: null } offline when nothing is downloaded (no doomed network call)', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);
    expect(result).toEqual({ climb: null });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('offlineAwareRequest — offline-usage signal lanes (#4317)', () => {
  // Four terminal outcomes are worth measuring, and each one has to reach the
  // rollup gate with the right lane or the north-star counts the wrong thing.

  it('records offline_local when a downloaded board is served while offline', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'offline_local',
      surface: 'search',
      boardName: 'kilter',
    });
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  it('records online_local when the flag-on latency short-circuit serves local while online', async () => {
    setOfflineEngineEnabled(true);
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'online_local',
      surface: 'climb_detail',
      boardName: 'kilter',
    });
  });

  it('records network_error_local when a dead network is rescued by the downloaded board', async () => {
    setOfflineEngineEnabled(false); // straight passthrough, so the network is the only lane
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    request.mockRejectedValue(new Error('Network request failed'));

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'network_error_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  it('records board_not_downloaded when offline with nothing local', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'board_not_downloaded',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'device_offline',
    });
    expect(recordOfflineRead).not.toHaveBeenCalled();
  });

  it('records filter_unsupported when the board IS downloaded but the filter needs a table we do not sync', async () => {
    setOnline(false);
    isOfflineSearchSupported.mockReturnValue(false);
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'filter_unsupported',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'device_offline',
    });
  });

  // Both gaps at once. Fixing #4002's filter coverage would still serve this
  // user nothing — they have no downloaded board to filter — so the read belongs
  // to #4318's conversion pool, not #4002's.
  it('prefers board_not_downloaded over filter_unsupported when the board was never downloaded', async () => {
    setOnline(false);
    isOfflineSearchSupported.mockReturnValue(false);
    isBoardDownloadedLocally.mockResolvedValue(false);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'board_not_downloaded',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'device_offline',
    });
  });

  // The supported-filter branch already ran (and failed) the download probe
  // inside canServeSearchLocal, so labelling that read must not pay for a
  // second SQLite round trip on every keystroke.
  it('does not re-probe the download when the filter was expressible', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(isBoardDownloadedLocally).toHaveBeenCalledOnce();
    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'board_not_downloaded',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'device_offline',
    });
  });

  // The local read happened, but it MISSED and the network answered instead —
  // counting it as served would inflate the north-star with reads the local DB
  // could not actually satisfy.
  it('does not record a served read when a local miss is answered by the network', async () => {
    setOfflineEngineEnabled(true);
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getClimbLocal.mockResolvedValue(null);

    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);

    expect(result.climb?.uuid).toBe('net-detail');
    expect(recordOfflineRead).not.toHaveBeenCalled();
  });

  // Offline, the miss can't be retried, so it is returned as-is — and what the
  // caller gets is `{ climb: null }`, the same nothing the empty fallback gives.
  // Counting that as offline_local would put "offline staring at an empty
  // screen" into the north-star, the one distinction this signal exists to make.
  it('does not record a served read for a local miss returned as-is while offline', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getClimbLocal.mockResolvedValue(null);

    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);

    expect(result).toEqual({ climb: null });
    expect(recordOfflineRead).not.toHaveBeenCalled();
    // No `unavailable` counterpart either: a null grade row is indistinguishable
    // from a genuinely ungraded climb, so the gap tile would be inventing a
    // number. Silence beats a wrong one.
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  it('does not record network_error_local when the rescue read itself misses', async () => {
    setOfflineEngineEnabled(false); // straight passthrough, so the catch block is the only local read
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getClimbLocal.mockResolvedValue(null);
    request.mockRejectedValue(new Error('Network request failed'));

    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);

    expect(result).toEqual({ climb: null });
    expect(recordOfflineRead).not.toHaveBeenCalled();
  });

  // Database init retries for up to 30s and can stay wedged for the whole launch
  // (#4313 / #4314). Reporting that as `board_not_downloaded` would put users who
  // DID download a board into the audience #4318 nudges to download one.
  it('records local_db_unavailable, not board_not_downloaded, when there is no database handle', async () => {
    setOnline(false);
    getDatabaseHandle.mockReturnValue(null);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'local_db_unavailable',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'device_offline',
    });
  });

  // The rescue read is what makes this lane "served"; if it throws, the caller
  // gets the network error and no data, so booking a served read would inflate
  // the north-star with reads nobody received.
  it('does not record network_error_local when the local rescue read itself throws', async () => {
    setOfflineEngineEnabled(false);
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    request.mockRejectedValue(new Error('Network request failed'));
    searchClimbsLocal.mockRejectedValue(new Error('database is locked'));

    await expect(offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput })).rejects.toThrow(
      'database is locked',
    );

    expect(recordOfflineRead).not.toHaveBeenCalled();
  });

  it('does not record anything for an unregistered document', async () => {
    setOnline(false);

    await offlineAwareRequest('query Unregistered { x }');

    expect(recordOfflineRead).not.toHaveBeenCalled();
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  // A registered document called without variables degrades to the fallback;
  // every accessor destructures the variables, so the signal has to sit this out
  // rather than throw on a read path.
  it('does not record an unavailable read when a registered document is called without variables', async () => {
    setOnline(false);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS);

    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  // #4862 split the offline lane in three. The reads that carried a climber
  // through OUR outage are the value a downloaded board earned when we broke,
  // and they were indistinguishable from a tunnel before this.
  it('records backend_unreachable_local when our server is what went down', async () => {
    setOfflineBecause('backend_unreachable');
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'backend_unreachable_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  // Chosen, not suffered — it belongs in the north-star but never in "how often
  // is anyone stranded?".
  it('records offline_mode_local when the climber turned offline mode on', async () => {
    setOfflineBecause('offline_mode');
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'offline_mode_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  // The residual bucket: offline before the store resolved a reason, i.e. a
  // cold start.
  it('records offline_local when the app is offline with no resolved reason', async () => {
    vi.spyOn(onlineManager, 'isOnline').mockReturnValue(false);
    connectivity.snapshot = { effectiveOffline: true, reason: null };
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'offline_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  // A gap our own outage created is not a climber who never downloaded a board,
  // and only one of those is an argument for a download nudge.
  it('stamps an empty read with the reason the app was offline', async () => {
    setOfflineBecause('backend_unreachable');
    isBoardDownloadedLocally.mockResolvedValue(false);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'board_not_downloaded',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'backend_unreachable',
    });
  });

  // The rescue lane is unchanged on purpose: it is a lying connection the store
  // has not classified yet, so relabelling it would claim a confirmation we do
  // not have.
  it('leaves the network-rescue lane alone during a confirmed outage', async () => {
    setOfflineEngineEnabled(false);
    vi.spyOn(onlineManager, 'isOnline').mockReturnValue(true);
    connectivity.snapshot = { effectiveOffline: false, reason: null };
    isBoardDownloadedLocally.mockResolvedValue(true);
    request.mockRejectedValue(new Error('Network request failed'));

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'network_error_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  it('reports the board the read was scoped to, not a hardcoded one', async () => {
    setOnline(false);
    isBoardTypeDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<BoardseshGradeResponse>(BOARDSESH_GRADE, { ...gradeVars, boardName: 'tension' });

    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'offline_local',
      surface: 'grade',
      boardName: 'tension',
    });
  });
});
