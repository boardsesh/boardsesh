// A privacy event against the real pull client and the real on-device DDL: what
// the sync engine asks the server for, and which pages land, around a
// revalidation (issue #6306). The pull goes through the adapter, as it does in
// the app, so only the platform seams below are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ token: 'accepted-token', generation: 1 }));
const request = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-store', () => ({
  getAuthToken: async () => auth.token,
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, token: string) => `digest-${token}`,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
// The settings store's native MMKV entry breaks the test bundler's scan. Same
// in-memory stand-in as offline-sync-adapter.test.ts.
const settingsStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => settingsStorage.get(key),
    set: (key: string, value: string) => void settingsStorage.set(key, value),
    remove: (key: string) => void settingsStorage.delete(key),
    clearAll: () => settingsStorage.clear(),
  }),
}));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
}));
vi.mock('@react-native-community/netinfo', () => ({
  default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true, type: 'wifi' }) },
}));
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({
    effectiveOffline: false,
    deviceReachability: 'reachable',
    backend: 'reachable',
    reason: null,
  }),
  subscribeConnectivity: () => () => {},
  refreshDeviceState: async () => {},
  confirmBackendAvailability: async () => true,
}));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn(), addErrorBreadcrumb: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track }));
// The wall photograph is a filesystem asset; no row in these tests depends on it.
vi.mock('../spray-photo-sink', () => ({
  sprayWallPhotoSink: async () => {},
  createSprayWallDeletedSink: () => async () => {},
}));

import type { QueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  runMigrations,
  getCheckpoint,
  getCheckpointKey,
  isScopeDownloadComplete,
  type GraphQLFetch,
  type SyncOptions,
} from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { canReadPrivateCatalog } from '../catalog-access';
import { pullSync } from '../offline-sync-adapter';
import { revalidatePrivateCatalog } from '../privacy-revalidation';

const KILTER_SCOPE = 'kilter:1:1';
const SPRAY_SCOPE = 'spray:7:7';
const SERVER_CURSOR = { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '9' };
/** Where the engine leaves the cursor of a stream that has delivered no row. */
const EMPTY_STREAM_CURSOR = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
/** The three board tables the fake server has rows for. */
const BOARD_TABLE_RESOLVERS = ['syncClimbs', 'syncClimbStats', 'syncClimbGrades'];

type SyncAudience = 'REFERENCE' | 'PROTECTED';
type SyncRequest = { resolver: string; audience: SyncAudience; cursor: unknown };

const climbDocument = (uuid: string, boardType: string, layoutId: number, sizeId: number) => ({
  uuid,
  board_type: boardType,
  layout_id: layoutId,
  compatible_size_ids: [sizeId],
  frames: 'p1r13p2r13',
  is_draft: false,
  is_listed: true,
  is_hidden: false,
  retired_by_reset: false,
  // Authored by another Boardsesh account, and published.
  user_id: 'other',
  updated_at: SERVER_CURSOR.updatedAt,
  sync_seq: '5',
});
const statsDocument = (climbUuid: string, boardType: string) => ({
  board_type: boardType,
  climb_uuid: climbUuid,
  angle: 40,
  ascensionist_count: 12,
  fa_username: null,
  fa_at: null,
  updated_at: SERVER_CURSOR.updatedAt,
  sync_seq: 6,
});
const gradeDocument = (climbUuid: string, boardType: string) => ({
  board_type: boardType,
  climb_uuid: climbUuid,
  angle: 40,
  local_grade: 21.4,
  computed_at: SERVER_CURSOR.updatedAt,
  sync_seq: 7,
});

/**
 * One page per `resolver@boardType:layoutId` for a request with no cursor, an
 * empty page for everything else, and a log of every board request with the
 * stream and the cursor it carried. `holdNextPage` keeps one response on the
 * wire until it is released.
 *
 * The rows here are published climbs set by another account. On a catalogue
 * board those are reference rows, the same for everyone; on a spray wall, which
 * has no reference stream, they come through the protected one.
 */
function createSyncServer(firstPages: Record<string, Record<string, unknown>[]>) {
  const requests: SyncRequest[] = [];
  const heldPages = new Map<string, { markRequested: () => void; released: Promise<void> }>();
  const fetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: [], cursor: SERVER_CURSOR, hasMore: false } } as T;
    }
    const queryName = /\{\s*(sync[A-Za-z]+)\(/.exec(query)?.[1];
    if (!queryName) throw new Error(`Unexpected sync query: ${query}`);
    const { boardType, layoutId, cursor, audience } = (variables ?? {}) as {
      boardType?: string;
      layoutId?: number;
      cursor?: unknown;
      audience?: SyncAudience;
    };
    const resolver = boardType ? `${queryName}@${boardType}:${layoutId}` : queryName;
    const isBoardTable = BOARD_TABLE_RESOLVERS.includes(queryName);
    if (isBoardTable && !audience) throw new Error(`${resolver} was requested without an audience`);
    if (isBoardTable && audience) requests.push({ resolver, audience, cursor: cursor ?? null });
    const streamOfTheseRows: SyncAudience = boardType === 'spray' ? 'PROTECTED' : 'REFERENCE';
    // Past its first page a stream has nothing more: the cursor is set.
    const documents = cursor || (isBoardTable && audience !== streamOfTheseRows) ? [] : (firstPages[resolver] ?? []);
    const heldPage = heldPages.get(resolver);
    if (heldPage) {
      heldPages.delete(resolver);
      heldPage.markRequested();
      await heldPage.released;
    }
    return { [queryName]: { documents, cursor: SERVER_CURSOR, hasMore: false } } as T;
  }) as unknown as GraphQLFetch;
  return {
    fetch,
    requests,
    holdNextPage(resolver: string): { requested: Promise<void>; release: () => void } {
      let markRequested!: () => void;
      let release!: () => void;
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldPages.set(resolver, { markRequested, released });
      return { requested, release };
    },
  };
}

let database: TestSqliteDb;
const queryClient = { invalidateQueries: vi.fn().mockResolvedValue(undefined) } as unknown as QueryClient;
/** Online, and on a metered link so no refresh replay adds requests to the log. */
const syncOptions = (enabledBoards: string[]): SyncOptions => ({
  enabledBoards,
  isOnline: () => true,
  isOnUnmeteredNetwork: async () => false,
});
/** The telemetry event the phone in #6306 sent 42 times in 43 minutes. */
const completedDownloadEvents = () =>
  track.mock.calls.filter(([eventName]) => eventName === SHARED_EVENTS.OfflineBoardDownloadCompleted);

beforeEach(async () => {
  auth.token = 'accepted-token';
  request.mockReset().mockImplementation(async () => ({ profile: { id: 'viewer' } }));
  track.mockClear();
  // The purge epochs are module-level; a purge in one case must not leak into the next.
  __resetDrainerStateForTests();
  database = createTestDatabase();
  await runMigrations(database);
});
afterEach(() => database?.close());

describe('a privacy event and the sync engine', () => {
  it('asks for no board table from the start again after three events in a row', async () => {
    const server = createSyncServer({
      'syncClimbs@kilter:1': [climbDocument('community-climb', 'kilter', 1, 1)],
      'syncClimbStats@kilter:1': [statsDocument('community-climb', 'kilter')],
      'syncClimbGrades@kilter:1': [gradeDocument('community-climb', 'kilter')],
    });
    const options = syncOptions([KILTER_SCOPE]);
    await pullSync(database, queryClient, server.fetch, options);
    expect(completedDownloadEvents()).toHaveLength(1);
    expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
    const requestsForDownload = server.requests.length;

    for (let event = 1; event <= 3; event += 1) {
      await revalidatePrivateCatalog(database, 'viewer');
      expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
      await pullSync(database, queryClient, server.fetch, options);
    }

    const laterBoardRequests = server.requests
      .slice(requestsForDownload)
      .filter(({ resolver }) => BOARD_TABLE_RESOLVERS.some((table) => resolver === `${table}@kilter:1`));
    const cursorsOf = (audience: SyncAudience) =>
      laterBoardRequests.filter((boardRequest) => boardRequest.audience === audience).map(({ cursor }) => cursor);
    // The public catalogue: one delta request per table per cycle, each resuming
    // from the cursor the download left. A request without a cursor is the
    // start of a re-crawl.
    expect(cursorsOf('REFERENCE')).toEqual(Array.from({ length: 9 }, () => SERVER_CURSOR));
    // The climber's own drafts and unlisted climbs: one small request per table
    // per cycle. This climber has none, so that stream's cursor never leaves
    // the start. The first event for an account forgets whose cursor it was,
    // which is the one cycle that sends none at all; no later event does that.
    expect(cursorsOf('PROTECTED')).toEqual([null, null, null, ...Array.from({ length: 6 }, () => EMPTY_STREAM_CURSOR)]);
    // "Offline Board Download Completed" stays a once-per-download event.
    expect(completedDownloadEvents()).toHaveLength(1);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'community-climb' }]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_stats')).toEqual([
      { climb_uuid: 'community-climb' },
    ]);
    expect(await database.getAllAsync('SELECT climb_uuid FROM board_climb_grades')).toEqual([
      { climb_uuid: 'community-climb' },
    ]);
    expect(await canReadPrivateCatalog(database)).toBe(true);
  });

  it('lets a catalogue page already on the wire land after the event', async () => {
    const server = createSyncServer({
      'syncClimbs@kilter:1': [climbDocument('community-climb', 'kilter', 1, 1)],
      'syncClimbStats@kilter:1': [statsDocument('community-climb', 'kilter')],
      'syncClimbGrades@kilter:1': [gradeDocument('community-climb', 'kilter')],
    });
    const pageOnWire = server.holdNextPage('syncClimbs@kilter:1');
    const download = pullSync(database, queryClient, server.fetch, syncOptions([KILTER_SCOPE]));
    await pageOnWire.requested;

    await revalidatePrivateCatalog(database, 'viewer');
    pageOnWire.release();
    await download;

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'community-climb' }]);
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', KILTER_SCOPE))).toEqual(SERVER_CURSOR);
    // The same cycle went on to finish the download.
    expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
    expect(
      server.requests.filter(
        ({ resolver, audience }) => resolver === 'syncClimbs@kilter:1' && audience === 'REFERENCE',
      ),
    ).toHaveLength(1);
  });

  it('discards a spray page fetched before the event', async () => {
    const server = createSyncServer({
      'syncClimbs@spray:7': [climbDocument('spray-climb', 'spray', 7, 7)],
    });
    const pageOnWire = server.holdNextPage('syncClimbs@spray:7');
    const download = pullSync(database, queryClient, server.fetch, syncOptions([SPRAY_SCOPE]));
    await pageOnWire.requested;

    await revalidatePrivateCatalog(database, 'viewer');
    pageOnWire.release();
    await download;

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([]);
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', SPRAY_SCOPE))).toBeNull();
    expect(await isScopeDownloadComplete(database, SPRAY_SCOPE)).toBe(false);
  });
});
