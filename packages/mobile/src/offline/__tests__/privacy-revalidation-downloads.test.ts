// A privacy event against the real pull client and the real on-device DDL: what
// the sync engine asks the server for, and which pages land, around a
// revalidation (issue #6306).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ token: 'accepted-token', generation: 1 }));
const request = vi.hoisted(() => vi.fn());
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

import {
  pullSync,
  runMigrations,
  getCheckpoint,
  getCheckpointKey,
  isScopeDownloadComplete,
  type GraphQLFetch,
  type QueryInvalidator,
} from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { canReadPrivateCatalog } from '../catalog-access';
import { revalidatePrivateCatalog } from '../privacy-revalidation';

const KILTER_SCOPE = 'kilter:1:1';
const SPRAY_SCOPE = 'spray:7:7';
const SERVER_CURSOR = { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '9' };
/** The three board tables the fake server has rows for. */
const BOARD_TABLE_RESOLVERS = ['syncClimbs', 'syncClimbStats', 'syncClimbGrades'];

type SyncRequest = { resolver: string; cursor: unknown };

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
 * empty page for everything else, and a log of every request with the cursor it
 * carried. `holdNextPage` keeps one response on the wire until it is released.
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
    const { boardType, layoutId, cursor } = (variables ?? {}) as {
      boardType?: string;
      layoutId?: number;
      cursor?: unknown;
    };
    const resolver = boardType ? `${queryName}@${boardType}:${layoutId}` : queryName;
    requests.push({ resolver, cursor: cursor ?? null });
    // Past its first page a table has nothing more: the cursor is set.
    const documents = cursor ? [] : (firstPages[resolver] ?? []);
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
const queryClient: QueryInvalidator = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };

beforeEach(async () => {
  auth.token = 'accepted-token';
  request.mockReset().mockImplementation(async () => ({ profile: { id: 'viewer' } }));
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
    const onScopeDownloadComplete = vi.fn();
    const options = { enabledBoards: [KILTER_SCOPE], onScopeDownloadComplete };
    await pullSync(database, queryClient, server.fetch, options);
    expect(onScopeDownloadComplete).toHaveBeenCalledOnce();
    expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
    const requestsForDownload = server.requests.length;

    for (let event = 1; event <= 3; event += 1) {
      await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE]);
      expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
      await pullSync(database, queryClient, server.fetch, options);
    }

    const laterBoardRequests = server.requests
      .slice(requestsForDownload)
      .filter(({ resolver }) => BOARD_TABLE_RESOLVERS.some((table) => resolver === `${table}@kilter:1`));
    // One delta request per table per cycle, each resuming from the cursor the
    // download left. A request without a cursor is the start of a re-crawl.
    expect(laterBoardRequests.map(({ cursor }) => cursor)).toEqual(Array.from({ length: 9 }, () => SERVER_CURSOR));
    // "Offline Board Download Completed" stays a once-per-download event.
    expect(onScopeDownloadComplete).toHaveBeenCalledOnce();
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
    const download = pullSync(database, queryClient, server.fetch, { enabledBoards: [KILTER_SCOPE] });
    await pageOnWire.requested;

    await revalidatePrivateCatalog(database, 'viewer', [KILTER_SCOPE]);
    pageOnWire.release();
    await download;

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'community-climb' }]);
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', KILTER_SCOPE))).toEqual(SERVER_CURSOR);
    // The same cycle went on to finish the download.
    expect(await isScopeDownloadComplete(database, KILTER_SCOPE)).toBe(true);
    expect(server.requests.filter(({ resolver }) => resolver === 'syncClimbs@kilter:1')).toHaveLength(1);
  });

  it('discards a spray page fetched before the event', async () => {
    const server = createSyncServer({
      'syncClimbs@spray:7': [climbDocument('spray-climb', 'spray', 7, 7)],
    });
    const pageOnWire = server.holdNextPage('syncClimbs@spray:7');
    const download = pullSync(database, queryClient, server.fetch, { enabledBoards: [SPRAY_SCOPE] });
    await pageOnWire.requested;

    await revalidatePrivateCatalog(database, 'viewer', [SPRAY_SCOPE]);
    pageOnWire.release();
    await download;

    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([]);
    expect(await getCheckpoint(database, getCheckpointKey('board_climbs', SPRAY_SCOPE))).toBeNull();
    expect(await isScopeDownloadComplete(database, SPRAY_SCOPE)).toBe(false);
  });
});
