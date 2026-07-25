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
}

afterEach(() => {
  __resetOfflineEngineForTests();
});

beforeEach(() => {
  vi.clearAllMocks();
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
