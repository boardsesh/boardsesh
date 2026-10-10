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
  isClimbLayoutDownloadedLocally,
  getClimbStatsHistoryLocal,
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
  getClimbLocal,
  getBoardseshGradeLocal,
  getBoardseshGradesForAnglesLocal,
  request,
  recordOfflineRead,
  recordOfflineReadUnavailable,
  getSimilarClimbsLocal,
  ensureHoldIndex,
  getHoldHeatmapLocalWithCount,
  fillClimbRevisionNumbersLocal,
} = vi.hoisted(() => ({
  fillClimbRevisionNumbersLocal: vi.fn(),
  getHoldHeatmapLocalWithCount: vi.fn(),
  getSimilarClimbsLocal: vi.fn(),
  ensureHoldIndex: vi.fn(),
  getDatabaseHandle: vi.fn(),
  isBoardDownloadedLocally: vi.fn(),
  isBoardTypeDownloadedLocally: vi.fn(),
  isClimbLayoutDownloadedLocally: vi.fn(),
  getClimbStatsHistoryLocal: vi.fn(),
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

const catalog = vi.hoisted(() => ({ epoch: 0, allowed: true, repairRequired: false, privacyGeneration: 0 }));
vi.mock('../../../offline/privacy-revalidation', () => ({ needsPrivacyRevalidation: () => catalog.repairRequired }));
vi.mock('../../privacy/privacy-cache', () => ({ getPrivacyRevocationGeneration: () => catalog.privacyGeneration }));
vi.mock('../../../offline/catalog-access', () => ({
  canReadPrivateCatalog: vi.fn(async () => catalog.allowed),
  captureCatalogReadEpoch: () => catalog.epoch,
  isCatalogReadCurrent: (epoch: number) => epoch === catalog.epoch,
}));
vi.mock('../../../db', () => ({ getDatabaseHandle }));
vi.mock('../../../db/queries/board-download-status', () => ({
  isBoardDownloadedLocally,
  isBoardTypeDownloadedLocally,
  isClimbLayoutDownloadedLocally,
}));
vi.mock('../../../db/queries/get-climb-stats-history-local', () => ({ getClimbStatsHistoryLocal }));
vi.mock('../../../db/queries/search-climbs-local', () => ({
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
}));
vi.mock('../../../db/queries/get-climb-local', () => ({ getClimbLocal }));
vi.mock('../../../db/queries/climb-revisions-local', () => ({ fillClimbRevisionNumbersLocal }));
vi.mock('../../../db/queries/get-boardsesh-grade-local', () => ({
  getBoardseshGradeLocal,
  getBoardseshGradesForAnglesLocal,
}));
vi.mock('../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../db/queries/get-similar-climbs-local', () => ({ getSimilarClimbsLocal }));
vi.mock('../../../db/queries/get-hold-heatmap-local', () => ({ getHoldHeatmapLocalWithCount }));
vi.mock('../../../offline/hold-index-parser', () => ({ parseHoldRows: vi.fn() }));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/offline-sync')>()),
  ensureHoldIndex,
}));
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

import {
  NETWORK_ENRICHMENT_BUDGET_MS,
  offlineAwareRequest,
  registerOfflineOperationForTests,
} from '../offline-request';
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
  HOLD_HEATMAP_QUERY,
  type HoldHeatmapQueryResponse,
  type HoldHeatmapQueryVariables,
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsResponse,
  type SimilarClimbsVariables,
} from '@boardsesh/graphql/operations';
import {
  CLIMB_STATS_HISTORY,
  type ClimbStatsHistoryResponse,
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
const statsHistoryVars = { boardName: 'kilter', climbUuid: 'c1' };
const localStatsEntry = {
  angle: 40,
  ascensionistCount: 12,
  qualityAverage: 2.8,
  difficultyAverage: 20.4,
  displayDifficulty: 20.1,
  createdAt: '2026-09-25T10:00:00Z',
};
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
  catalog.epoch = 0;
  catalog.repairRequired = false;
  catalog.privacyGeneration = 0;
  catalog.allowed = true;
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
  isClimbLayoutDownloadedLocally.mockResolvedValue(true);
  getClimbStatsHistoryLocal.mockResolvedValue([localStatsEntry]);
  // The phone holds none of the network climbs unless a test says otherwise:
  // the fill hands back the array it was given.
  fillClimbRevisionNumbersLocal.mockImplementation(
    async (_db: unknown, _boardType: string, climbs: unknown[]) => climbs,
  );
  request.mockResolvedValue({
    climbStatsHistory: [{ ...localStatsEntry, ascensionistCount: 99 }],
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

// A spray climb that lost a hold is listed with a badge, so a wall search sends
// no hold-integrity value at all. The climber's own drafts list sends ANY.
describe('offlineAwareRequest — spray searches over the network', () => {
  const sprayInput: ClimbSearchInput = { boardName: 'spray', layoutId: 7, sizeId: 7, setIds: '1', angle: 25 };

  beforeEach(() => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
  });

  it('sends no holdIntegrity on a wall search and a wall count', async () => {
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: sprayInput });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: sprayInput });
    await offlineAwareRequest<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input: sprayInput });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS_COUNT, { input: sprayInput });
    const sent = request.mock.calls.at(-1)?.[1] as { input: ClimbSearchInput };
    expect('holdIntegrity' in sent.input).toBe(false);
  });

  it('drops a value an older caller still builds', async () => {
    for (const holdIntegrity of ['INTACT', 'BROKEN', 'ANY'] as const) {
      await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: { ...sprayInput, holdIntegrity } });
      expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: sprayInput });
    }
  });

  // ANY, not nothing: the current server hides retired climbs from every spray
  // search without a value, drafts included, and a draft retired by an old full
  // reset would then be out of reach.
  it("sends ANY for the climber's drafts, so a draft that lost a hold still lists", async () => {
    const draftsInput: ClimbSearchInput = { ...sprayInput, onlyDrafts: true };
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: draftsInput });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: { ...draftsInput, holdIntegrity: 'ANY' } });
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
      input: { ...draftsInput, holdIntegrity: 'INTACT' },
    });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: { ...draftsInput, holdIntegrity: 'ANY' } });
  });

  it('keeps a catalogue drafts search free of any value', async () => {
    const draftsInput: ClimbSearchInput = { ...searchInput, onlyDrafts: true };
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: draftsInput });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: draftsInput });
  });

  it('leaves a catalogue search untouched and drops a stale value from it', async () => {
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: searchInput });
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
      input: { ...searchInput, holdIntegrity: 'BROKEN' },
    });
    expect(request).toHaveBeenLastCalledWith(SEARCH_CLIMBS, { input: searchInput });
  });

  it('leaves the local read to apply the rule itself', async () => {
    isBoardDownloadedLocally.mockResolvedValue(true);
    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: sprayInput });
    expect(searchClimbsLocal).toHaveBeenCalledWith(fakeDb, sprayInput);
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

// #6023. SearchClimbs and GetClimb cannot select `revisionNumber` /
// `holdsRevisionNumber` while the screenshot fixtures pin their text, so a climb
// read over the network gets them from the phone's own copy of the climb.
describe('offlineAwareRequest — climb version numbers on a network answer', () => {
  const versioned = (climbs: Array<{ uuid: string }>) =>
    climbs.map((climb) => ({ ...climb, revisionNumber: 4, holdsRevisionNumber: 3 }));

  it('fills a network search page from the phone, in one call for the whole page', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    fillClimbRevisionNumbersLocal.mockImplementation(async (_db, _boardType, climbs) => versioned(climbs));

    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(fillClimbRevisionNumbersLocal).toHaveBeenCalledTimes(1);
    expect(fillClimbRevisionNumbersLocal).toHaveBeenCalledWith(fakeDb, 'kilter', [{ uuid: 'net' }]);
    expect(result.searchClimbs.climbs).toEqual([{ uuid: 'net', revisionNumber: 4, holdsRevisionNumber: 3 }]);
    // The rest of the server's answer is untouched.
    expect(result.searchClimbs.hasMore).toBe(true);
  });

  it('hands back the network response itself when the phone holds none of the climbs', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const networkResponse = { searchClimbs: { climbs: [{ uuid: 'net' }], hasMore: false } };
    request.mockResolvedValue(networkResponse);

    expect(await offlineAwareRequest(SEARCH_CLIMBS, { input: searchInput })).toBe(networkResponse);
  });

  it('fills a network climb detail', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    fillClimbRevisionNumbersLocal.mockImplementation(async (_db, _boardType, climbs) => versioned(climbs));

    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);

    expect(fillClimbRevisionNumbersLocal).toHaveBeenCalledWith(fakeDb, 'kilter', [{ uuid: 'net-detail' }]);
    expect(result.climb).toEqual({ uuid: 'net-detail', revisionNumber: 4, holdsRevisionNumber: 3 });
  });

  it('does not ask the phone about a climb the server did not find', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    request.mockResolvedValue({ climb: null });

    const result = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, climbVars);

    expect(result.climb).toBeNull();
    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
  });

  it('keeps the network answer when the local read throws, and does not run the local rescue', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    fillClimbRevisionNumbersLocal.mockRejectedValue(new Error('database is locked'));

    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(result.searchClimbs.climbs).toEqual([{ uuid: 'net' }]);
    expect(searchClimbsLocal).not.toHaveBeenCalled();
    expect(recordOfflineRead).not.toHaveBeenCalled();
  });

  it('keeps the network answer when there is no database handle', async () => {
    setOnline(true);
    getDatabaseHandle.mockReturnValue(null);

    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(result.searchClimbs.climbs).toEqual([{ uuid: 'net' }]);
    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
  });

  // The network already answered. A busy SQLite file (a snapshot import, a
  // sync page) must not hold the screen back for a number it can live without.
  it('hands over the network answer un-enriched when the local read outlasts its budget', async () => {
    vi.useFakeTimers();
    try {
      setOnline(true);
      isBoardDownloadedLocally.mockResolvedValue(false);
      let finishLocalRead: (climbs: unknown[]) => void = () => {};
      fillClimbRevisionNumbersLocal.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishLocalRead = resolve;
          }),
      );

      let settled: SearchClimbsQueryResponse | undefined;
      const pending = offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput }).then(
        (response) => {
          settled = response;
          return response;
        },
      );

      await vi.advanceTimersByTimeAsync(NETWORK_ENRICHMENT_BUDGET_MS - 1);
      expect(settled).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.searchClimbs.climbs).toEqual([{ uuid: 'net' }]);
      expect(result.searchClimbs.hasMore).toBe(true);

      // The late read changes nothing and raises nothing.
      finishLocalRead(versioned([{ uuid: 'net' }]));
      await vi.advanceTimersByTimeAsync(0);
      expect(result.searchClimbs.climbs).toEqual([{ uuid: 'net' }]);
      expect(searchClimbsLocal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a local read that rejects after the budget ran out', async () => {
    vi.useFakeTimers();
    try {
      setOnline(true);
      isBoardDownloadedLocally.mockResolvedValue(false);
      let failLocalRead: (error: Error) => void = () => {};
      fillClimbRevisionNumbersLocal.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            failLocalRead = reject;
          }),
      );

      const pending = offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
      await vi.advanceTimersByTimeAsync(NETWORK_ENRICHMENT_BUDGET_MS);
      expect((await pending).searchClimbs.climbs).toEqual([{ uuid: 'net' }]);

      failLocalRead(new Error('database is locked'));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind when the local read answers in time', async () => {
    vi.useFakeTimers();
    try {
      setOnline(true);
      isBoardDownloadedLocally.mockResolvedValue(false);

      await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the local read outright when the offline engine is off', async () => {
    setOnline(true);
    setOfflineEngineEnabled(false);

    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(result.searchClimbs.climbs).toEqual([{ uuid: 'net' }]);
    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
    // Not even a handle lookup on behalf of the enrichment.
    expect(getDatabaseHandle).not.toHaveBeenCalled();
  });

  // Any registered enrichment, not only the two real ones: whatever it does
  // wrong, the caller gets the network's own object back.
  describe('a registered enrichNetworkResponse that fails', () => {
    type EnrichVars = { boardName: string };
    type EnrichResponse = { items: string[] };
    const ENRICH_DOC = 'query EnrichmentFailureProbe { items }';
    const networkAnswer: EnrichResponse = { items: ['net'] };

    async function requestWithEnrichment(enrichNetworkResponse: () => Promise<EnrichResponse>) {
      const resolveLocal = vi.fn();
      const unregister = registerOfflineOperationForTests<EnrichVars, EnrichResponse>({
        document: ENRICH_DOC,
        surface: 'search',
        boardNameOf: ({ boardName }) => boardName,
        canServeLocal: async () => false,
        resolveLocal,
        offlineFallback: () => ({ items: [] }),
        enrichNetworkResponse,
      });
      try {
        setOnline(true);
        request.mockResolvedValue(networkAnswer);
        const result = await offlineAwareRequest<EnrichResponse>(ENRICH_DOC, { boardName: 'kilter' });
        return { result, resolveLocal };
      } finally {
        unregister();
      }
    }

    it('returns the raw network answer when it throws synchronously', async () => {
      const enrich = vi.fn((): Promise<EnrichResponse> => {
        throw new Error('thrown before any promise existed');
      });

      const { result, resolveLocal } = await requestWithEnrichment(enrich);

      expect(enrich).toHaveBeenCalledTimes(1);
      expect(result).toBe(networkAnswer);
      // Not mistaken for a network failure: no local rescue, no offline lane.
      expect(resolveLocal).not.toHaveBeenCalled();
      expect(recordOfflineRead).not.toHaveBeenCalled();
    });

    it('returns the raw network answer when it rejects', async () => {
      const enrich = vi.fn(async (): Promise<EnrichResponse> => {
        throw new Error('database is locked');
      });

      const { result, resolveLocal } = await requestWithEnrichment(enrich);

      expect(enrich).toHaveBeenCalledTimes(1);
      expect(result).toBe(networkAnswer);
      expect(resolveLocal).not.toHaveBeenCalled();
      expect(recordOfflineRead).not.toHaveBeenCalled();
    });
  });

  it('does not touch a local answer: the local readers select the numbers themselves', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);

    await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });

    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
  });

  it('leaves operations with no climbs in them alone', async () => {
    setOnline(true);
    isBoardTypeDownloadedLocally.mockResolvedValue(false);

    await offlineAwareRequest(BOARDSESH_GRADE, gradeVars);

    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
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

describe('offlineAwareRequest — CLIMB_STATS_HISTORY', () => {
  it("reads the per-angle stats locally when the climb's layout is downloaded (online)", async () => {
    setOnline(true);
    const result = await offlineAwareRequest<ClimbStatsHistoryResponse>(CLIMB_STATS_HISTORY, statsHistoryVars);
    expect(result).toEqual({ climbStatsHistory: [localStatsEntry] });
    expect(isClimbLayoutDownloadedLocally).toHaveBeenCalledWith(fakeDb, 'kilter', 'c1');
    expect(getClimbStatsHistoryLocal).toHaveBeenCalledWith(fakeDb, statsHistoryVars);
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps an empty local list — past the layout gate, no ascents is a real answer', async () => {
    setOnline(true);
    getClimbStatsHistoryLocal.mockResolvedValue([]);
    const result = await offlineAwareRequest<ClimbStatsHistoryResponse>(CLIMB_STATS_HISTORY, statsHistoryVars);
    expect(result).toEqual({ climbStatsHistory: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it("asks the server when the climb's layout is not downloaded (online)", async () => {
    setOnline(true);
    isClimbLayoutDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<ClimbStatsHistoryResponse>(CLIMB_STATS_HISTORY, statsHistoryVars);
    expect(result.climbStatsHistory[0].ascensionistCount).toBe(99);
    expect(getClimbStatsHistoryLocal).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(CLIMB_STATS_HISTORY, statsHistoryVars);
  });

  it('returns the empty list offline with nothing local', async () => {
    setOnline(false);
    isClimbLayoutDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<ClimbStatsHistoryResponse>(CLIMB_STATS_HISTORY, statsHistoryVars);
    expect(result).toEqual({ climbStatsHistory: [] });
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

// `local-only` ops (similar climbs): the server resolver is admin-gated, so a
// non-admin reaching it would see an auth error instead of an empty strip. The
// policy must never touch the network — not online, not as a rescue.
describe('offlineAwareRequest — local-only network policy', () => {
  const LOCAL_ONLY_DOC = 'query LocalOnlyTest { localOnlyTest }';
  type LocalOnlyVars = { boardName: string };
  type LocalOnlyResponse = { items: string[] };
  const canServeLocal = vi.fn<() => Promise<boolean>>();
  const resolveLocal = vi.fn<() => Promise<LocalOnlyResponse>>();
  let unregister: () => void = () => undefined;

  beforeEach(() => {
    canServeLocal.mockResolvedValue(true);
    resolveLocal.mockResolvedValue({ items: ['local'] });
    unregister = registerOfflineOperationForTests<LocalOnlyVars, LocalOnlyResponse>({
      document: LOCAL_ONLY_DOC,
      networkPolicy: 'local-only',
      surface: 'search',
      boardNameOf: ({ boardName }) => boardName,
      canServeLocal,
      resolveLocal,
      offlineFallback: () => ({ items: [] }),
    });
  });

  afterEach(() => {
    unregister();
  });

  it('serves local while online and records the online_local lane', async () => {
    setOnline(true);
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' });
    expect(result).toEqual({ items: ['local'] });
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'online_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  it('serves local while offline under the offline lane', async () => {
    setOfflineBecause('backend_unreachable');
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' });
    expect(result).toEqual({ items: ['local'] });
    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'backend_unreachable_local',
      surface: 'search',
      boardName: 'kilter',
    });
  });

  it('returns the fallback ONLINE when local cannot serve, without calling the network or the gap signal', async () => {
    setOnline(true);
    canServeLocal.mockResolvedValue(false);
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' });
    expect(result).toEqual({ items: [] });
    expect(request).not.toHaveBeenCalled();
    expect(resolveLocal).not.toHaveBeenCalled();
    // Online is not an offline gap: recording it would share the rollup's dedupe key.
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  it('returns the fallback OFFLINE when local cannot serve, with the offline reason', async () => {
    setOnline(false);
    canServeLocal.mockResolvedValue(false);
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' });
    expect(result).toEqual({ items: [] });
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineReadUnavailable).toHaveBeenCalledExactlyOnceWith({
      reason: 'board_not_downloaded',
      surface: 'search',
      boardName: 'kilter',
      connectivityReason: 'device_offline',
    });
  });

  it('names a missing db handle as its own reason and still skips the network', async () => {
    setOnline(false);
    getDatabaseHandle.mockReturnValue(null);
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' });
    expect(result).toEqual({ items: [] });
    expect(canServeLocal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineReadUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'local_db_unavailable' }),
    );
  });

  it('ignores the offline-engine flag: flag off + online still reads local, never the network', async () => {
    setOfflineEngineEnabled(false);
    setOnline(true);
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' });
    expect(result).toEqual({ items: ['local'] });
    expect(request).not.toHaveBeenCalled();
  });

  it('propagates a local read error instead of rescuing through the network', async () => {
    setOnline(true);
    resolveLocal.mockRejectedValue(new Error('sqlite read failed'));
    await expect(offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC, { boardName: 'kilter' })).rejects.toThrow(
      'sqlite read failed',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('returns the fallback with no signal when called without variables', async () => {
    setOnline(true);
    const result = await offlineAwareRequest<LocalOnlyResponse>(LOCAL_ONLY_DOC);
    expect(result).toEqual({ items: [] });
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });
});

// Similar climbs is registered local-only: the server resolver is admin-gated,
// so a climber whose board is not downloaded gets an empty strip from here and
// the download offer from the section — never a request.
describe('offlineAwareRequest — SIMILAR_CLIMBS_QUERY (local-only)', () => {
  const similarVars: SimilarClimbsVariables = {
    input: { boardType: 'kilter', layoutId: 1, sizeId: 5, climbUuid: 'c1', angle: 40, limit: 12 },
  };

  beforeEach(() => {
    ensureHoldIndex.mockResolvedValue({ status: 'complete' });
    getSimilarClimbsLocal.mockResolvedValue([{ uuid: 'twin' }]);
  });

  it('builds the holds index, then answers from SQLite while online', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, similarVars);
    expect(result).toEqual({ similarClimbs: [{ uuid: 'twin' }] });
    expect(isBoardDownloadedLocally).toHaveBeenCalledWith(fakeDb, { boardType: 'kilter', layoutId: 1, sizeId: 5 });
    expect(ensureHoldIndex).toHaveBeenCalledWith(
      fakeDb,
      { boardType: 'kilter', layoutId: 1, sizeId: 5 },
      expect.objectContaining({ parseHoldRows: expect.any(Function) }),
    );
    expect(ensureHoldIndex.mock.invocationCallOrder[0]).toBeLessThan(getSimilarClimbsLocal.mock.invocationCallOrder[0]);
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'online_local',
      surface: 'similar_climbs',
      boardName: 'kilter',
    });
  });

  it('returns an empty strip ONLINE for a board that is not downloaded — no request', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, similarVars);
    expect(result).toEqual({ similarClimbs: [] });
    expect(request).not.toHaveBeenCalled();
    expect(ensureHoldIndex).not.toHaveBeenCalled();
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  it('returns an empty strip OFFLINE for a board that is not downloaded', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, similarVars);
    expect(result).toEqual({ similarClimbs: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('throws on an aborted index build so a partial strip is never cached', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    ensureHoldIndex.mockResolvedValue({ status: 'aborted' });
    await expect(offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, similarVars)).rejects.toThrow(
      'interrupted',
    );
    expect(getSimilarClimbsLocal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('treats an empty local list as the answer, not a miss to retry', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    getSimilarClimbsLocal.mockResolvedValue([]);
    const result = await offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, similarVars);
    expect(result).toEqual({ similarClimbs: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('cannot serve an input without a size (the scope is size-exact)', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, {
      input: { ...similarVars.input, sizeId: null },
    });
    expect(result).toEqual({ similarClimbs: [] });
    expect(isBoardDownloadedLocally).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

// The hold heatmap is local-only too, and gated like search: the climb set is the
// list's, so a filter SQLite cannot express declines exactly as search does.
describe('offlineAwareRequest — HOLD_HEATMAP_QUERY (local-only)', () => {
  const heatmapVars: HoldHeatmapQueryVariables = {
    input: { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '1', angle: 40 },
  };
  const stat = { holdId: 7, totalUses: 2, startingUses: 0, handUses: 2, footUses: 0, finishUses: 0, totalAscents: 5 };

  beforeEach(() => {
    getHoldHeatmapLocalWithCount.mockResolvedValue({ holdStats: [stat], climbCount: 12 });
    isOfflineSearchSupported.mockReturnValue(true);
  });

  it('answers from SQLite while online for a downloaded board', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<HoldHeatmapQueryResponse>(HOLD_HEATMAP_QUERY, heatmapVars);
    // The phone's answer carries how many climbs it counted, for the legend.
    expect(result).toEqual({ holdHeatmap: [stat], climbCount: 12 });
    // No `withStats` variable → the grade column is still read (the safe default).
    expect(getHoldHeatmapLocalWithCount).toHaveBeenCalledWith(fakeDb, heatmapVars.input, { withStats: true });
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineRead).toHaveBeenCalledExactlyOnceWith({
      lane: 'online_local',
      surface: 'hold_heatmap',
      boardName: 'kilter',
    });
  });

  it('returns the unavailable fallback ONLINE for a board that is not downloaded — no request', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    const result = await offlineAwareRequest<HoldHeatmapQueryResponse>(HOLD_HEATMAP_QUERY, heatmapVars);
    expect(result).toEqual({ holdHeatmap: [], unavailable: true });
    expect(request).not.toHaveBeenCalled();
    expect(getHoldHeatmapLocalWithCount).not.toHaveBeenCalled();
    // Online, the unavailable signal stays quiet (local-only records offline gaps only).
    expect(recordOfflineReadUnavailable).not.toHaveBeenCalled();
  });

  it('declines a filter SQLite cannot run on a downloaded board — no request', async () => {
    setOnline(false);
    isOfflineSearchSupported.mockReturnValue(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    const result = await offlineAwareRequest<HoldHeatmapQueryResponse>(HOLD_HEATMAP_QUERY, heatmapVars);
    expect(result).toEqual({ holdHeatmap: [], unavailable: true });
    expect(request).not.toHaveBeenCalled();
    expect(recordOfflineReadUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'filter_unsupported', surface: 'hold_heatmap' }),
    );
  });
});

describe('withdrawn downloaded catalogue reads', () => {
  it('serves HTTP immediately while local privacy repair is pending or failed', async () => {
    setOnline(true);
    catalog.repairRequired = true;
    const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(response.searchClimbs.climbs[0].uuid).toBe('net');
    expect(searchClimbsLocal).not.toHaveBeenCalled();
    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps local-only reads fail closed during repair (online=%s)', async (online) => {
    setOnline(online);
    catalog.repairRequired = true;
    expect(
      await offlineAwareRequest(SIMILAR_CLIMBS_QUERY, { input: { boardType: 'kilter', layoutId: 1, sizeId: 5 } }),
    ).toEqual({ similarClimbs: [] });
    expect(request).not.toHaveBeenCalled();
    expect(getSimilarClimbsLocal).not.toHaveBeenCalled();
  });

  it('returns the offline fallback without waiting for a failed local repair', async () => {
    setOnline(false);
    catalog.repairRequired = true;
    expect(await offlineAwareRequest(GET_CLIMB, climbVars)).toEqual({ climb: null });
    expect(request).not.toHaveBeenCalled();
    expect(getClimbLocal).not.toHaveBeenCalled();
  });

  it('never rescues a failed HTTP request with a withdrawn catalogue', async () => {
    setOnline(true);
    catalog.repairRequired = true;
    request.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(offlineAwareRequest(GET_CLIMB, climbVars)).rejects.toThrow('network unavailable');
    expect(getClimbLocal).not.toHaveBeenCalled();
  });

  it('discards a network response when credentials or privacy change while it is in flight', async () => {
    setOnline(true);
    catalog.repairRequired = true;
    request.mockImplementationOnce(async () => {
      catalog.privacyGeneration += 1;
      return { climb: { uuid: 'withdrawn' } };
    });
    await expect(offlineAwareRequest(GET_CLIMB, climbVars)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Privacy changed during climb request',
    });
    expect(fillClimbRevisionNumbersLocal).not.toHaveBeenCalled();
  });

  it('discards an answer withdrawn while local network enrichment is pending', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    fillClimbRevisionNumbersLocal.mockImplementationOnce(async (_db: unknown, _board: string, climbs: unknown[]) => {
      catalog.privacyGeneration += 1;
      catalog.epoch += 1;
      return climbs;
    });
    await expect(offlineAwareRequest(SEARCH_CLIMBS, { input: searchInput })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not rescue an old failed request from a newly authorized catalogue', async () => {
    setOnline(true);
    isBoardDownloadedLocally.mockResolvedValue(false);
    request.mockImplementationOnce(async () => {
      catalog.epoch += 1;
      throw new Error('old request failed');
    });
    await expect(offlineAwareRequest(SEARCH_CLIMBS, { input: searchInput })).rejects.toThrow('old request failed');
    expect(searchClimbsLocal).not.toHaveBeenCalled();
  });

  it('discards a local result that finishes after privacy revalidation', async () => {
    setOnline(false);
    isBoardDownloadedLocally.mockResolvedValue(true);
    searchClimbsLocal.mockImplementationOnce(async () => {
      catalog.epoch += 1;
      return { climbs: [{ uuid: 'withdrawn' }], hasMore: false };
    });
    const result = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input: searchInput });
    expect(result.searchClimbs.climbs).toEqual([]);
  });
  it('does not rescue a failed request with a different account catalogue', async () => {
    setOnline(true);
    catalog.allowed = false;
    isBoardDownloadedLocally.mockResolvedValue(true);
    request.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(offlineAwareRequest(SEARCH_CLIMBS, { input: searchInput })).rejects.toThrow('network unavailable');
    expect(searchClimbsLocal).not.toHaveBeenCalled();
  });
});
