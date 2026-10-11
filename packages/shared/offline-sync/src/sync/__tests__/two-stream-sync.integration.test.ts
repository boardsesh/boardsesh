// The two-stream board sync (issue #6306), against real SQLite and a backend
// that splits rows the way the resolvers do.
//
// Each board table is pulled twice. The REFERENCE stream is every published and
// listed climb, whoever set it: the same rows for every viewer, and what a
// snapshot artifact holds. The PROTECTED stream is what only this viewer is
// sent: on a catalogue board their own drafts and unlisted climbs, on a spray
// wall everything. A privacy event changes nothing on a catalogue board. Before
// this, such an event deleted every board cursor and every completion marker,
// and a phone re-crawled a whole board (about 2,200 pages for Kilter) after
// each launch.
//
// The snapshot-import half is in two-stream-import.integration.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryInvalidator } from '../../database';
import { runMigrations } from '../../db/migrations';
import { ensureHoldIndex } from '../../holds-index/hold-index';
import { getHoldSet } from '../../holds-index/query';
import {
  __resetDrainerStateForTests,
  beginProtectedWithdrawal,
  capturePurgeToken,
  hasProtectedWithdrawalLanded,
  hasPurgeLanded,
} from '../../mutation-queue/drainer';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { markScopeDownloaded } from '../../testing/downloaded-scope';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import {
  getCheckpoint,
  getProtectedCheckpoint,
  isScopeDownloadComplete,
  isScopeProtectedComplete,
  resetProtectedSyncState,
  setCheckpoint,
  setProtectedCheckpoint,
} from '../checkpoints';
import { pullSync, type ScopeDownloadCompleteInfo, type SyncOptions } from '../pull-client';
import {
  createTwoStreamBackend,
  cursorAt,
  leftReferenceMarker,
  simulatePrivacyRevalidation,
  type ServerClimb,
  type ServerDeletion,
  type TwoStreamBackendOptions,
} from './helpers/two-stream-fixtures';

const SCOPE_KEY = 'kilter:1:12';
const SCOPE = { boardType: 'kilter', layoutId: 1, sizeId: 12 };
const VIEWER = 'viewer';
const CLIMBS_KEY = `checkpoint:board_climbs:${SCOPE_KEY}`;
const STATS_KEY = `checkpoint:board_climb_stats:${SCOPE_KEY}`;
const GRADES_KEY = `checkpoint:board_climb_grades:${SCOPE_KEY}`;

// Published and listed, so public: a manufacturer climb, the viewer's own
// climb, and another climber's climb.
const catalogueClimb = (sequence: number, uuid = `catalogue-${sequence}`): ServerClimb => ({
  uuid,
  ownerId: null,
  cursor: cursorAt(sequence),
  stats: { faUsername: 'Manufacturer Setter' },
  grade: true,
});
const ownClimb: ServerClimb = { uuid: 'viewer-own', ownerId: VIEWER, cursor: cursorAt(40), stats: {}, grade: true };
const friendClimb: ServerClimb = {
  uuid: 'friend-climb',
  ownerId: 'friend',
  cursor: cursorAt(41),
  stats: { faUsername: 'A Private Climber' },
  grade: true,
};
// Not published, so sent to their owner alone: the viewer's draft, and another
// climber's.
const DRAFT = { is_draft: true, is_listed: false };
const ownDraft: ServerClimb = {
  uuid: 'viewer-draft',
  ownerId: VIEWER,
  cursor: cursorAt(45),
  fields: DRAFT,
  stats: { faUsername: 'A Private Climber' },
  grade: true,
};
const friendDraft: ServerClimb = { ...ownDraft, uuid: 'friend-draft', ownerId: 'friend', cursor: cursorAt(46) };
const ownDrafts = (count: number): ServerClimb[] =>
  Array.from({ length: count }, (_unused, index) => ({
    uuid: `viewer-draft-${index}`,
    ownerId: VIEWER,
    cursor: cursorAt(100 + index),
    fields: DRAFT,
  }));

let db: TestSqliteDb;
let queryClient: QueryInvalidator;

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await ensureMutationQueueTable(db);
  queryClient = { invalidateQueries: vi.fn() };
  __resetDrainerStateForTests();
});

afterEach(() => {
  __resetDrainerStateForTests();
  db.close();
});

const localClimbs = async (): Promise<string[]> =>
  (await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid')).map((row) => row.uuid);
const localStats = async (): Promise<Array<{ climb_uuid: string; fa_username: string | null }>> =>
  db.getAllAsync('SELECT climb_uuid, fa_username FROM board_climb_stats ORDER BY climb_uuid');
const localGrades = async (): Promise<string[]> =>
  (await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_grades ORDER BY climb_uuid')).map(
    (row) => row.climb_uuid,
  );

function backend(climbs: ServerClimb[] | (() => ServerClimb[]), extra: Partial<TwoStreamBackendOptions> = {}) {
  return createTwoStreamBackend({ climbs: typeof climbs === 'function' ? climbs : () => climbs, ...extra });
}

const sync = (fetch: ReturnType<typeof backend>['fetch'], options: SyncOptions = {}) =>
  pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], ...options });

describe('pulling a board as a reference and a protected stream', () => {
  it('asks each table for its reference rows, then its protected rows, and lands both', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb, ownDraft, friendDraft]);

    await sync(server.fetch);

    expect(server.requestsFor().map((request) => [request.queryName, request.audience])).toEqual([
      ['syncClimbs', 'REFERENCE'],
      ['syncClimbs', 'PROTECTED'],
      ['syncClimbStats', 'REFERENCE'],
      ['syncClimbStats', 'PROTECTED'],
      ['syncClimbGrades', 'REFERENCE'],
      ['syncClimbGrades', 'PROTECTED'],
    ]);
    // Every published climb, whoever set it, and the viewer's own draft. Another
    // climber's draft is sent to nobody but them.
    expect(await localClimbs()).toEqual(['catalogue-10', 'friend-climb', 'viewer-draft', 'viewer-own']);
    expect(await localGrades()).toEqual(['catalogue-10', 'friend-climb', 'viewer-draft', 'viewer-own']);
  });

  it('keeps a published climb another climber set, as a reference row like any other', async () => {
    // Two boards, the first one full of owned published climbs. Each of them is
    // public, so neither board may be held up by them.
    const tensionClimb: ServerClimb = { ...catalogueClimb(12, 'tension-12'), boardType: 'tension', layoutId: 9 };
    const server = backend([
      friendClimb,
      { ...friendClimb, uuid: 'friend-climb-2', cursor: cursorAt(42) },
      tensionClimb,
    ]);

    await pullSync(db, queryClient, server.fetch, { enabledBoards: [SCOPE_KEY, 'tension:9:12'] });

    expect(await localClimbs()).toEqual(['friend-climb', 'friend-climb-2', 'tension-12']);
    expect(
      await db.getAllAsync('SELECT uuid, user_id FROM board_climbs WHERE board_type = ? ORDER BY uuid', ['kilter']),
    ).toEqual([
      { uuid: 'friend-climb', user_id: 'friend' },
      { uuid: 'friend-climb-2', user_id: 'friend' },
    ]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(42));
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await isScopeDownloadComplete(db, 'tension:9:12')).toBe(true);
  });

  it('keeps one cursor per stream in the table’s checkpoint row', async () => {
    const server = backend([catalogueClimb(10), friendClimb, ownDraft]);

    await sync(server.fetch);

    // The reference cursor is where the last published row was; the protected
    // one is where the viewer's last own row was. Neither moved the other.
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(41));
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(45), complete: true });
    expect(await getCheckpoint(db, STATS_KEY)).toEqual(cursorAt(41));
    expect(await getProtectedCheckpoint(db, GRADES_KEY)).toMatchObject({ ...cursorAt(45), complete: true });
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('resumes each stream from its own cursor on the next cycle', async () => {
    let climbs = [catalogueClimb(10), ownDraft];
    const server = backend(() => climbs);
    await sync(server.fetch);
    server.requests.length = 0;

    climbs = [...climbs, catalogueClimb(50), { ...ownDraft, uuid: 'viewer-draft-2', cursor: cursorAt(60) }];
    await sync(server.fetch);

    expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(10)]);
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([cursorAt(45)]);
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-50', 'viewer-draft', 'viewer-draft-2']);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(50));
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject(cursorAt(60));
  });

  it('pages the protected stream and stamps a cursor per page', async () => {
    const stampedAfterPage: unknown[] = [];
    const server = backend(ownDrafts(5), {
      pageSize: 2,
      onRequest: async (request) => {
        if (request.queryName === 'syncClimbs' && request.audience === 'PROTECTED') {
          stampedAfterPage.push(await getProtectedCheckpoint(db, CLIMBS_KEY));
        }
      },
    });

    await sync(server.fetch);

    expect(await localClimbs()).toEqual(ownDrafts(5).map((climb) => climb.uuid));
    // Before each request: nothing, then a cursor per committed page. Complete
    // only once the tail is reached, so a cycle cut short mid-stream is not.
    expect(stampedAfterPage).toEqual([
      null,
      expect.objectContaining({ ...cursorAt(101), complete: false }),
      expect.objectContaining({ ...cursorAt(103), complete: false }),
    ]);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(104), complete: true });
  });

  it('marks a board the climber has no draft on as protected-complete, and writes nothing on later cycles', async () => {
    const server = backend([catalogueClimb(10), friendClimb]);
    await sync(server.fetch);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    // No protected row was ever written, so the cursor is still the epoch.
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ syncSeq: '0', complete: true });
    const protectedClimbsAfterFirst = await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CLIMBS_KEY]);

    const runAsync = vi.spyOn(db, 'runAsync');
    const transactions = vi.spyOn(db, 'withExclusiveTransactionAsync');
    await sync(server.fetch);

    // An unchanged board is a few requests, no transaction and no checkpoint
    // write: the tail it reached before is already on record.
    expect(await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [CLIMBS_KEY])).toEqual(
      protectedClimbsAfterFirst,
    );
    expect(transactions).not.toHaveBeenCalled();
    expect(runAsync.mock.calls.filter(([sql]) => String(sql).includes('$.protected'))).toHaveLength(0);
  });

  it('asks for every protected stream on every cycle: they are a handful of rows and cheap to ask for', async () => {
    const server = backend([catalogueClimb(10), ownDraft]);
    await sync(server.fetch);
    server.requests.length = 0;

    await sync(server.fetch);

    expect(server.requestsFor(undefined, 'PROTECTED').map((request) => request.queryName)).toEqual([
      'syncClimbs',
      'syncClimbStats',
      'syncClimbGrades',
    ]);
  });

  describe('scope completion', () => {
    it('needs both tails: a board whose protected stream has not been reached is not complete', async () => {
      let protectedReachable = false;
      const server = backend([catalogueClimb(10), ownDraft], {
        onRequest: (request) => {
          if (request.audience === 'PROTECTED' && !protectedReachable) throw new Error('connection dropped');
        },
      });
      const onScopeDownloadComplete = vi.fn();

      await expect(sync(server.fetch, { onScopeDownloadComplete })).rejects.toThrow('connection dropped');

      // The public catalogue is down, and that is not the board.
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(10));
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();

      protectedReachable = true;
      await sync(server.fetch, { onScopeDownloadComplete });

      expect(await localClimbs()).toEqual(['catalogue-10', 'viewer-draft']);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    });

    it('reports the protected time and row count, and that the pull was split', async () => {
      const server = backend([catalogueClimb(10), friendClimb, ownDraft]);
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, { onScopeDownloadComplete: (info) => completions.push(info) });

      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ scopeKey: SCOPE_KEY, method: 'paged', audienceMode: 'split' });
      // The viewer's one draft, with its stats and its grade row.
      expect(completions[0].phases.protectedRows).toBe(3);
      expect(completions[0].phases.protectedPullMs).toBeGreaterThanOrEqual(0);
    });

    it('leaves protectedRows out when a protected stream resumed from an earlier cycle’s cursor', async () => {
      // The first cycle dies on its second protected climbs page.
      let protectedClimbPages = 0;
      const server = backend(ownDrafts(4), {
        pageSize: 2,
        onRequest: (request) => {
          if (request.audience !== 'PROTECTED' || request.queryName !== 'syncClimbs') return;
          protectedClimbPages += 1;
          if (protectedClimbPages === 2) throw new Error('connection dropped');
        },
      });
      const completions: ScopeDownloadCompleteInfo[] = [];
      const options = { onScopeDownloadComplete: (info: ScopeDownloadCompleteInfo) => completions.push(info) };
      await expect(sync(server.fetch, options)).rejects.toThrow('connection dropped');

      await sync(server.fetch, options);

      expect(completions).toHaveLength(1);
      // Two of the four rows were written by the cycle that failed: a count
      // here would under-report, so there is none.
      expect(Object.hasOwn(completions[0].phases, 'protectedRows')).toBe(false);
    });
  });

  describe('first-ascent credit', () => {
    const localFirstAscents = () =>
      db.getAllAsync<{ climb_uuid: string; fa_username: string | null; fa_at: string | null }>(
        'SELECT climb_uuid, fa_username, fa_at FROM board_climb_stats ORDER BY climb_uuid',
      );
    const MANUFACTURER_CREDIT = { fa_username: 'Manufacturer Setter', fa_at: '2020-01-01T00:00:00Z' };

    it('writes a reference stats row as it is given: the stored credit, or none', async () => {
      // The server sends the upstream credit for a climb with no owner, and none
      // where the name would come from Boardsesh ticks.
      await sync(backend([catalogueClimb(10), friendClimb]).fetch);

      expect(await localFirstAscents()).toEqual([
        { climb_uuid: 'catalogue-10', ...MANUFACTURER_CREDIT },
        { climb_uuid: 'friend-climb', fa_username: null, fa_at: null },
      ]);
    });

    it('writes a credit a reference page does carry, on an owned climb too', async () => {
      const server = backend([friendClimb]);
      const fetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        const response = await server.fetch<Record<string, { documents: Record<string, unknown>[] }>>(query, variables);
        if (query.includes('syncClimbStats(') && variables?.audience === 'REFERENCE') {
          for (const document of response.syncClimbStats.documents) Object.assign(document, MANUFACTURER_CREDIT);
        }
        return response as T;
      }) as typeof server.fetch;

      await sync(fetch);

      expect(await localFirstAscents()).toEqual([{ climb_uuid: 'friend-climb', ...MANUFACTURER_CREDIT }]);
    });

    it('keeps both columns on the reference rows and stores neither on the protected ones, in the same cycle', async () => {
      // The backend ships a name on the protected page too, so only the stream a
      // row came through decides what is stored.
      const server = backend([catalogueClimb(10), ownDraft], { leakProtectedFirstAscent: true });

      await sync(server.fetch);
      // A second cycle resumes both streams; neither may disturb the other's rows.
      await sync(server.fetch);

      expect(await localFirstAscents()).toEqual([
        { climb_uuid: 'catalogue-10', ...MANUFACTURER_CREDIT },
        { climb_uuid: 'viewer-draft', fa_username: null, fa_at: null },
      ]);
    });

    it('clears a name an earlier bundle stored when the protected replay rewrites the row', async () => {
      // The single stream of an earlier bundle delivered this row with a name the
      // server had filled in for this viewer. Same row version as the server's.
      await db.runAsync(
        `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username, fa_at, updated_at, sync_seq)
         VALUES ('kilter', 'viewer-draft', 40, 'A Private Climber', '2020-01-01T00:00:00Z', ?, ?)`,
        [ownDraft.cursor.updatedAt, Number(ownDraft.cursor.syncSeq)],
      );

      await sync(backend([ownDraft]).fetch);

      expect(
        await db.getAllAsync('SELECT climb_uuid, fa_username, fa_at, display_difficulty FROM board_climb_stats'),
      ).toEqual([{ climb_uuid: 'viewer-draft', fa_username: null, fa_at: null, display_difficulty: 20 }]);
    });
  });
});

describe('a spray wall, which has no reference rows', () => {
  const WALL_SCOPE_KEY = 'spray:7:7';
  const wallClimb = (uuid: string, ownerId: string, sequence: number): ServerClimb => ({
    uuid,
    ownerId,
    cursor: cursorAt(sequence),
    boardType: 'spray',
    layoutId: 7,
    sizeId: 7,
    stats: {},
  });
  const wall = {
    layout_id: 7,
    board_uuid: 'wall-uuid',
    name: 'Garage wall',
    reference_width: 1000,
    reference_height: 1000,
    current_version_number: 1,
    photo_key: null,
    holds: [],
    homography: null,
    updated_at: cursorAt(5).updatedAt,
    sync_seq: 7,
  };

  it('pulls everything through the protected stream and never asks for a reference one', async () => {
    const server = backend([wallClimb('mine', VIEWER, 10), wallClimb('theirs', 'friend', 11)], {
      walls: () => ({ 7: wall }),
    });

    await pullSync(db, queryClient, server.fetch, { enabledBoards: [WALL_SCOPE_KEY] });

    expect(server.requestsFor().map((request) => [request.queryName, request.audience])).toEqual([
      ['syncClimbs', 'PROTECTED'],
      ['syncClimbStats', 'PROTECTED'],
      ['syncClimbGrades', 'PROTECTED'],
      // The wall's resolver takes no audience: it is one viewer-scoped stream.
      ['syncSprayWalls', undefined],
    ]);
    expect(await localClimbs()).toEqual(['mine', 'theirs']);
    expect(await db.getAllAsync('SELECT name FROM spray_walls')).toEqual([{ name: 'Garage wall' }]);
    expect(await isScopeDownloadComplete(db, WALL_SCOPE_KEY)).toBe(true);
    expect(await isScopeProtectedComplete(db, WALL_SCOPE_KEY)).toBe(true);
    // No table of a wall ever gets a reference cursor.
    for (const tableName of ['board_climbs', 'board_climb_stats', 'spray_walls']) {
      expect(await getCheckpoint(db, `checkpoint:${tableName}:${WALL_SCOPE_KEY}`)).toBeNull();
    }
  });

  it('does not ask a catalogue board for a wall', async () => {
    const server = backend([catalogueClimb(10)]);

    await sync(server.fetch);

    expect(server.requestsFor('syncSprayWalls')).toHaveLength(0);
  });

  it('completes a wall download once, and not again after a privacy event', async () => {
    const server = backend([wallClimb('mine', VIEWER, 10), wallClimb('theirs', 'friend', 11)], {
      walls: () => ({ 7: wall }),
    });
    const onScopeDownloadComplete = vi.fn();
    const options = { enabledBoards: [WALL_SCOPE_KEY], onScopeDownloadComplete };
    await pullSync(db, queryClient, server.fetch, options);

    await simulatePrivacyRevalidation(db, VIEWER);
    // The wall row and the other climber's climb are gone until the replay.
    expect(await localClimbs()).toEqual(['mine']);
    expect(await isScopeProtectedComplete(db, WALL_SCOPE_KEY)).toBe(false);
    expect(await isScopeDownloadComplete(db, WALL_SCOPE_KEY)).toBe(true);

    await pullSync(db, queryClient, server.fetch, options);

    expect(await localClimbs()).toEqual(['mine', 'theirs']);
    expect(await db.getAllAsync('SELECT name FROM spray_walls')).toEqual([{ name: 'Garage wall' }]);
    expect(await isScopeProtectedComplete(db, WALL_SCOPE_KEY)).toBe(true);
    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
  });

  it('does not finish a wall on protected tails an event has just voided', async () => {
    // The event lands after the LAST stream committed its tail and before the
    // completion marker is written: every stream reported its tail, and the
    // purge that is about to run takes them back.
    let lastStreamFetched = false;
    const server = backend([wallClimb('mine', VIEWER, 10), wallClimb('theirs', 'friend', 11)], {
      walls: () => ({ 7: wall }),
      onRequest: (request) => {
        if (request.queryName === 'syncSprayWalls') lastStreamFetched = true;
      },
    });
    const exclusive = db.withExclusiveTransactionAsync.bind(db);
    vi.spyOn(db, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        await task(transaction);
        if (lastStreamFetched) {
          lastStreamFetched = false;
          beginProtectedWithdrawal();
        }
      }),
    );
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, queryClient, server.fetch, { enabledBoards: [WALL_SCOPE_KEY], onScopeDownloadComplete });

    expect(await isScopeDownloadComplete(db, WALL_SCOPE_KEY)).toBe(false);
    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
  });

  // THE FENCE. A wall page is the server's answer to "which walls may this
  // viewer see", as of when it was built. One built before a privacy event must
  // not be written after the event's purge: it would put a withdrawn row back,
  // under a cursor past it.
  describe('the fence on a wall’s pages', () => {
    let friendWallIsVisible = true;
    const wallBackend = (extra: Partial<TwoStreamBackendOptions> = {}) =>
      backend([wallClimb('mine', VIEWER, 10), wallClimb('theirs', 'friend', 11)], {
        walls: () => ({ 7: wall }),
        canSee: (climb) => climb.ownerId === VIEWER || friendWallIsVisible,
        ...extra,
      });
    const syncWall = (fetch: ReturnType<typeof backend>['fetch'], options: SyncOptions = {}) =>
      pullSync(db, queryClient, fetch, { enabledBoards: [WALL_SCOPE_KEY], ...options });
    const WALL_CLIMBS_KEY = `checkpoint:board_climbs:${WALL_SCOPE_KEY}`;

    beforeEach(() => {
      friendWallIsVisible = true;
    });

    it('drops a page that was on the wire when the event landed', async () => {
      let eventFired = false;
      const server = wallBackend({
        onRequest: async (request) => {
          if (request.queryName !== 'syncClimbs' || eventFired) return;
          eventFired = true;
          // The server built this page while the other climber's climb was
          // visible. The event, and the purge, happen before the response
          // arrives; the response itself still carries the row.
          await simulatePrivacyRevalidation(db, VIEWER);
        },
      });

      await syncWall(server.fetch);
      friendWallIsVisible = false;

      expect(await localClimbs()).toEqual([]);
      expect(await getProtectedCheckpoint(db, WALL_CLIMBS_KEY)).toBeNull();
      // The rest of the cycle's streams for the wall were not even asked.
      expect(server.requestsFor('syncClimbStats')).toHaveLength(0);
      expect(server.requestsFor('syncSprayWalls')).toHaveLength(0);

      await syncWall(server.fetch);
      expect(await localClimbs()).toEqual(['mine']);
    });

    it('drops a page whose write was waiting for the lock when the event landed', async () => {
      const server = wallBackend();
      const exclusive = db.withExclusiveTransactionAsync.bind(db);
      let armed = false;
      vi.spyOn(db, 'withExclusiveTransactionAsync').mockImplementation((task) =>
        exclusive(async (transaction) => {
          // The page has been fetched and its transaction is opening.
          if (armed) {
            armed = false;
            beginProtectedWithdrawal();
          }
          await task(transaction);
        }),
      );
      const fetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        const response = await server.fetch<T>(query, variables);
        if (query.includes('syncClimbs(')) armed = true;
        return response;
      }) as typeof server.fetch;

      await syncWall(fetch);

      // Its rows were rolled back with its cursor.
      expect(await localClimbs()).toEqual([]);
      expect(await getProtectedCheckpoint(db, WALL_CLIMBS_KEY)).toBeNull();
    });

    it('does not let a cycle queued before the event write wall rows after it', async () => {
      const server = wallBackend();
      let releaseFirst!: () => void;
      const firstCycleBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const blockingFetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes('syncDeletions')) await firstCycleBlocked;
        return server.fetch<T>(query, variables);
      }) as typeof server.fetch;
      const firstCycle = pullSync(db, queryClient, blockingFetch, { enabledBoards: [] });
      // Queued behind the first, and so before the event below.
      const queuedCycle = syncWall(server.fetch);

      await simulatePrivacyRevalidation(db, VIEWER);
      releaseFirst();
      await firstCycle;
      await queuedCycle;

      expect(server.requestsFor()).toHaveLength(0);
      expect(await localClimbs()).toEqual([]);
    });

    it('pulls no wall row while the platform says a revalidation is pending', async () => {
      const server = wallBackend();

      await syncWall(server.fetch, { isProtectedSyncAllowed: () => false });

      expect(server.requestsFor()).toHaveLength(0);
      expect(await localClimbs()).toEqual([]);
      expect(await isScopeDownloadComplete(db, WALL_SCOPE_KEY)).toBe(false);
    });

    it('is its own generation: it is not a purge, and a purge is not it', () => {
      const token = capturePurgeToken();
      beginProtectedWithdrawal();

      expect(hasProtectedWithdrawalLanded(token)).toBe(true);
      // Reference pages, imports, user tables and the outbox read these, and none
      // of them may stop for a privacy event.
      expect(hasPurgeLanded(token)).toBe(false);
      expect(hasPurgeLanded(token, 'kilter:1')).toBe(false);
      expect(hasProtectedWithdrawalLanded(capturePurgeToken())).toBe(false);
    });
  });
});

// A published climb is public whoever set it, and a catalogue board's protected
// stream is the climber's own drafts. So no privacy setting, anybody's, changes
// which of a catalogue board's rows this device may hold, and a privacy event
// (one arrives on every launch and reconnect) has nothing to take back.
describe('a privacy event, on a catalogue board', () => {
  const boardClimbs = [catalogueClimb(10), catalogueClimb(11), friendClimb, ownClimb, ownDraft];
  const allUuids = ['catalogue-10', 'catalogue-11', 'friend-climb', 'viewer-draft', 'viewer-own'];

  it('removes nothing, resets no cursor, and starts no stream over', async () => {
    const server = backend(boardClimbs);
    await sync(server.fetch);
    const metaBefore = await db.getAllAsync('SELECT key, value FROM sync_meta ORDER BY key');
    server.requests.length = 0;

    await simulatePrivacyRevalidation(db, VIEWER);

    expect(await localClimbs()).toEqual(allUuids);
    expect(await localStats()).toHaveLength(5);
    expect(await db.getAllAsync('SELECT key, value FROM sync_meta ORDER BY key')).toEqual(metaBefore);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);

    await sync(server.fetch);

    // Every request of the next cycle resumes from a cursor.
    expect(server.requestsFor().every((request) => request.cursor !== undefined)).toBe(true);
    expect(await localClimbs()).toEqual(allUuids);
  });

  it('does not re-fire the download-completed event, however many follow', async () => {
    const server = backend(boardClimbs);
    const onScopeDownloadComplete = vi.fn();
    await sync(server.fetch, { onScopeDownloadComplete });

    for (let event = 0; event < 3; event += 1) {
      await simulatePrivacyRevalidation(db, VIEWER);
      await sync(server.fetch, { onScopeDownloadComplete });
    }

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
  });

  it('does not hold the board’s own protected stream back while a revalidation is pending', async () => {
    const server = backend(boardClimbs);

    // The platform's gate is closed, as it is from the event until the purge of
    // wall rows has committed. It is not asked about a catalogue board.
    await sync(server.fetch, { isProtectedSyncAllowed: () => false });

    expect(await localClimbs()).toEqual(allUuids);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('lets a protected page land though the event arrived while it was on the wire', async () => {
    let eventFired = false;
    const server = backend(boardClimbs, {
      onRequest: async (request) => {
        if (request.queryName !== 'syncClimbs' || request.audience !== 'PROTECTED' || eventFired) return;
        eventFired = true;
        await simulatePrivacyRevalidation(db, VIEWER);
      },
    });
    const onScopeDownloadComplete = vi.fn();

    await sync(server.fetch, { onScopeDownloadComplete });

    expect(await localClimbs()).toEqual(allUuids);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(45), complete: true });
    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
  });

  it('carries a download in progress straight through it', async () => {
    // 12 manufacturer climbs at 5 a page: three reference pages for the climbs.
    const bigCatalogue = Array.from({ length: 12 }, (_unused, index) => catalogueClimb(10 + index));
    let eventFired = false;
    const server = backend([...bigCatalogue, ownDraft], {
      pageSize: 5,
      onRequest: async (request) => {
        const isSecondReferencePage =
          request.queryName === 'syncClimbs' && request.audience === 'REFERENCE' && request.cursor !== undefined;
        if (isSecondReferencePage && !eventFired) {
          eventFired = true;
          await simulatePrivacyRevalidation(db, VIEWER);
        }
      },
    });
    const onScopeDownloadComplete = vi.fn();

    await sync(server.fetch, { onScopeDownloadComplete });

    // One cycle, each page from where the one before it ended, and done.
    expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
      undefined,
      cursorAt(14),
      cursorAt(19),
    ]);
    expect(await localClimbs()).toEqual([...bigCatalogue.map((climb) => climb.uuid), 'viewer-draft'].sort());
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
  });
});

// What does change a catalogue board's protected rows is the ACCOUNT: they are
// one climber's own drafts and unlisted climbs.
describe('a change of account', () => {
  it('replays the protected streams for the new climber, from the start', async () => {
    const previousDraft: ServerClimb = {
      ...ownDraft,
      uuid: 'previous-draft',
      ownerId: 'previous',
      cursor: cursorAt(70),
    };
    const olderDraftOfTheNewClimber: ServerClimb = { ...ownDraft, uuid: 'viewer-old-draft', cursor: cursorAt(20) };
    const climbs = [catalogueClimb(10), previousDraft, olderDraftOfTheNewClimber];
    await sync(backend(climbs, { viewerId: 'previous' }).fetch);
    expect(await localClimbs()).toEqual(['catalogue-10', 'previous-draft']);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(70), complete: true });

    // The sign-out deletes the previous climber's rows (mobile's wipe) and
    // forgets how far their protected streams got.
    await db.runAsync("DELETE FROM board_climbs WHERE uuid = 'previous-draft'");
    await resetProtectedSyncState(db);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(false);
    // The public catalogue and its cursor stay.
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(10));

    const server = backend(climbs, { viewerId: VIEWER });
    await sync(server.fetch);

    // A draft older than the previous climber's cursor still arrives.
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
    expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(10)]);
    expect(await localClimbs()).toEqual(['catalogue-10', 'viewer-old-draft']);
  });
});

// A cursor written at an older refresh revision is not resumed: the stream is
// replayed from the epoch so a column synced since reaches every row. The
// replay deletes nothing, and `complete` says exactly that, so it stays set
// from the replay's first page on. These pin what that does and does not let
// through while the replay is part-way.
describe('a protected stream replayed for a newer revision', () => {
  const authored = ownDrafts(5);
  const authoredUuids = authored.map((climb) => climb.uuid);

  /** The climbs cursor as a bundle one revision back left it: at the tail, complete. */
  const rewindClimbsRevision = async () => {
    const stored = await getProtectedCheckpoint(db, CLIMBS_KEY);
    if (!stored) throw new Error('expected a protected climbs cursor');
    await setProtectedCheckpoint(db, CLIMBS_KEY, { ...stored, revision: 0 });
  };

  /** A backend that pages by two and drops the connection before the second protected climbs page. */
  function backendThatDropsMidReplay(climbs: ServerClimb[] | (() => ServerClimb[]), midReplay: () => Promise<void>) {
    let dropped = false;
    return backend(climbs, {
      pageSize: 2,
      onRequest: async (request) => {
        const isSecondProtectedClimbsPage =
          request.queryName === 'syncClimbs' && request.audience === 'PROTECTED' && request.cursor !== undefined;
        if (!isSecondProtectedClimbsPage || dropped) return;
        dropped = true;
        await midReplay();
        throw new Error('connection dropped');
      },
    });
  }

  it('stays complete from the first page, with every row still on the device, and resumes where it stopped', async () => {
    await sync(backend(authored).fetch);
    await rewindClimbsRevision();
    const onScopeDownloadComplete = vi.fn();
    let afterPageOne: unknown;
    const server = backendThatDropsMidReplay(authored, async () => {
      afterPageOne = {
        cursor: await getProtectedCheckpoint(db, CLIMBS_KEY),
        isScopeProtectedComplete: await isScopeProtectedComplete(db, SCOPE_KEY),
        climbs: await localClimbs(),
      };
    });

    await sync(server.fetch, { onScopeDownloadComplete }).catch(() => {});

    // One page in: the cursor is back near the start and already at the new
    // revision, and the flag never dropped. Nothing was deleted to replay, so
    // all five climbs are here, which is what a reader of the flag is asking.
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([
      undefined,
      cursorAt(101),
    ]);
    expect(afterPageOne).toEqual({
      cursor: expect.objectContaining({ ...cursorAt(101), complete: true, revision: 1 }),
      isScopeProtectedComplete: true,
      climbs: authoredUuids,
    });
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);

    // The next cycle carries on from page one. It neither starts the replay
    // again nor takes the flag for "at the tail" and skips the rest.
    server.requests.length = 0;
    await sync(server.fetch, { onScopeDownloadComplete });

    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([
      cursorAt(101),
      cursorAt(103),
    ]);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({
      ...cursorAt(104),
      complete: true,
      revision: 1,
    });
    expect(await localClimbs()).toEqual(authoredUuids);
    // A board that was already downloaded did not download again.
    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
  });

  it('does not finish a first download on the flag: the replay has to reach its tail', async () => {
    // A wall whose every protected stream has been to its tail, at the revision
    // before the current one, and which has not finished downloading: no
    // `scope-complete:` marker.
    const WALL_SCOPE_KEY = 'spray:7:7';
    const WALL_CLIMBS_KEY = `checkpoint:board_climbs:${WALL_SCOPE_KEY}`;
    const wallClimbs: ServerClimb[] = Array.from({ length: 5 }, (_unused, index) => ({
      uuid: `wall-${index}`,
      ownerId: VIEWER,
      cursor: cursorAt(100 + index),
      boardType: 'spray',
      layoutId: 7,
      sizeId: 7,
    }));
    const options = { enabledBoards: [WALL_SCOPE_KEY] };
    await pullSync(db, queryClient, backend(wallClimbs).fetch, options);
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${WALL_SCOPE_KEY}`]);
    const stored = await getProtectedCheckpoint(db, WALL_CLIMBS_KEY);
    if (!stored) throw new Error('expected a protected climbs cursor');
    await setProtectedCheckpoint(db, WALL_CLIMBS_KEY, { ...stored, revision: 1 });
    const completions: ScopeDownloadCompleteInfo[] = [];
    const onScopeDownloadComplete = (info: ScopeDownloadCompleteInfo) => completions.push(info);
    // The climbs replay alone is cut short, after its first page and without
    // an error. Every other stream then runs to its tail, so the cycle reaches
    // the point where it decides whether the wall is done with only this one
    // stream short of it.
    let refusals = 0;
    const server = backend(wallClimbs, {
      pageSize: 2,
      onRequest: (request) => {
        // The gate closes while the second climbs page is on the wire, for the
        // one check that decides whether that page may be written.
        if (request.queryName === 'syncClimbs' && request.cursor !== undefined) refusals = 1;
      },
    });
    const isProtectedSyncAllowed = () => {
      if (refusals === 0) return true;
      refusals -= 1;
      return false;
    };

    await pullSync(db, queryClient, server.fetch, { ...options, onScopeDownloadComplete, isProtectedSyncAllowed });

    expect(await getProtectedCheckpoint(db, WALL_CLIMBS_KEY)).toMatchObject({ ...cursorAt(101), complete: true });
    expect(server.requestsFor('syncClimbStats', 'PROTECTED')).not.toEqual([]);
    expect(await isScopeProtectedComplete(db, WALL_SCOPE_KEY)).toBe(true);
    expect(await isScopeDownloadComplete(db, WALL_SCOPE_KEY)).toBe(false);
    expect(completions).toEqual([]);

    await pullSync(db, queryClient, server.fetch, { ...options, onScopeDownloadComplete });

    expect(await isScopeDownloadComplete(db, WALL_SCOPE_KEY)).toBe(true);
    expect(completions).toHaveLength(1);
  });

  it('loses the flag to a reset that lands mid-replay, like any other protected cursor', async () => {
    await sync(backend(authored).fetch);
    await rewindClimbsRevision();
    const server = backendThatDropsMidReplay(authored, async () => {});
    await sync(server.fetch).catch(() => {});
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);

    // A change of account, say.
    await resetProtectedSyncState(db);

    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(false);

    // Not sticky across the reset: complete again only at the tail.
    const stampedBeforeRequest: unknown[] = [];
    const afterReset = backend(authored, {
      pageSize: 2,
      onRequest: async (request) => {
        if (request.queryName === 'syncClimbs' && request.audience === 'PROTECTED') {
          stampedBeforeRequest.push((await getProtectedCheckpoint(db, CLIMBS_KEY))?.complete ?? null);
        }
      },
    });
    await sync(afterReset.fetch);

    expect(stampedBeforeRequest).toEqual([null, false, false]);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    expect(await localClimbs()).toEqual(authoredUuids);
  });
});

// The backend ships before the client, so a backend that does not know
// `audience` means it was rolled back. A pull without the argument is the one
// stream of every row the viewer may see, and writing that under the reference
// cursor would put other climbers' rows where no privacy event replays them.
describe('a backend that does not know the audience argument', () => {
  it('pulls no board table, says so once, and finishes everything else', async () => {
    const server = backend([catalogueClimb(10), friendClimb], { supportsAudience: false });
    const onAudienceUnsupported = vi.fn();
    const phases: string[] = [];
    await setCheckpoint(db, 'checkpoint:boardsesh_ticks', cursorAt(1));

    await pullSync(db, queryClient, server.fetch, {
      enabledBoards: [SCOPE_KEY, 'kilter:2:12'],
      onAudienceUnsupported,
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(await localClimbs()).toEqual([]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toBeNull();
    // One refused request, then nothing more for this board or the next.
    expect(server.requestsFor()).toHaveLength(1);
    expect(onAudienceUnsupported).toHaveBeenCalledTimes(1);
    expect(onAudienceUnsupported).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: 'board_climbs', scopeKey: SCOPE_KEY }),
    );
    // Deletions and the user tables ran, and the cycle ended normally.
    expect(server.requests.some((request) => request.queryName === 'syncDeletions')).toBe(true);
    expect(server.requests.some((request) => request.queryName === 'syncTicks')).toBe(true);
    expect(phases.at(-1)).toBe('idle');
    expect(
      await db.getFirstAsync("SELECT key FROM sync_meta WHERE key = 'checkpoint:user_data_complete'"),
    ).not.toBeNull();
  });

  it('never falls back to a request without the argument', async () => {
    const server = backend([catalogueClimb(10), friendClimb], { supportsAudience: false });

    await sync(server.fetch);

    for (const [query] of server.fetch.mock.calls) {
      if (/sync(Climbs|ClimbStats|ClimbGrades)\(/.test(query)) expect(query).toContain('audience: $audience');
    }
  });

  it('leaves a downloaded board as it was, and syncs it again once the backend knows the argument', async () => {
    let supportsAudience = true;
    let climbs = [catalogueClimb(10), ownClimb];
    const makeServer = () => backend(() => climbs, { supportsAudience });
    await sync(makeServer().fetch);

    supportsAudience = false;
    climbs = [...climbs, catalogueClimb(50)];
    await sync(makeServer().fetch);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await localClimbs()).toEqual(['catalogue-10', 'viewer-own']);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(40));

    supportsAudience = true;
    await sync(makeServer().fetch);
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-50', 'viewer-own']);
  });

  it.each([
    ['graphql-js, as thrown', 'Unknown argument "audience" on field "Query.syncClimbs".'],
    ['the enum the variable is declared with', 'Unknown type "SyncAudience".'],
    [
      'graphql-request, which quotes the response as JSON',
      'GraphQL Error (Code: 400): {"response":{"errors":[{"message":"Unknown argument \\"audience\\" on field \\"Query.syncClimbs\\"."}]}}',
    ],
  ])('recognises the validation error from %s', async (_label, message) => {
    const onAudienceUnsupported = vi.fn();
    const server = backend([catalogueClimb(10)], {
      onRequest: (request) => {
        if (request.boardType !== undefined) throw new Error(message);
      },
    });

    await expect(sync(server.fetch, { onAudienceUnsupported })).resolves.toBeUndefined();

    expect(onAudienceUnsupported).toHaveBeenCalledTimes(1);
  });

  it('recognises it wrapped as the cause of another error', async () => {
    const onAudienceUnsupported = vi.fn();
    const server = backend([catalogueClimb(10)], {
      onRequest: (request) => {
        if (request.boardType === undefined) return;
        throw new Error('Request failed', {
          cause: new Error('Unknown argument "audience" on field "Query.syncClimbs".'),
        });
      },
    });

    await sync(server.fetch, { onAudienceUnsupported });

    expect(onAudienceUnsupported).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Internal server error while resolving audience',
    'Unknown argument "sizeId" on field "Query.syncClimbs".',
    'Variable "$audience" got invalid value "PRIVATE"',
  ])('does not mistake another failure for it: %s', async (message) => {
    const onAudienceUnsupported = vi.fn();
    const server = backend([catalogueClimb(10)], {
      onRequest: (request) => {
        if (request.boardType !== undefined) throw new Error(message);
      },
    });

    await expect(sync(server.fetch, { onAudienceUnsupported })).rejects.toThrow(message);

    expect(onAudienceUnsupported).not.toHaveBeenCalled();
  });

  it('keeps the cycle going when the reporter itself throws', async () => {
    const server = backend([catalogueClimb(10)], { supportsAudience: false });

    await expect(
      sync(server.fetch, {
        onAudienceUnsupported: () => {
          throw new Error('reporter broke');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the holds index and the two streams', () => {
  const parseHoldRows = (_boardType: string, frames: string) =>
    [...frames.matchAll(/p(\d+)r\d+/g)].map((match) => ({ holdId: Number(match[1]), holdState: 'HAND' }));
  const indexOptions = { parseHoldRows, yieldToHost: async () => {} };
  const holdIndex = { parseHoldRows };
  const holdIds = async (uuid: string) => (await getHoldSet(db, uuid))?.map((hold) => hold.holdId) ?? null;

  it('does not wait for a catalogue board’s protected stream: nothing in it is ever indexed', async () => {
    const server = backend([catalogueClimb(10), friendClimb, ownDraft]);
    await sync(server.fetch, { holdIndex });
    expect(await holdIds('friend-climb')).toEqual([1, 2]);
    // A draft is not indexed, whoever owns it.
    expect(await holdIds('viewer-draft')).toBeNull();

    // An import, or a change of account, resets the board's protected cursors.
    await resetProtectedSyncState(db);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(false);

    // Similar climbs still answers offline, before the replay has run.
    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('complete');
  });

  it('waits for a wall’s rows to be back after a privacy event', async () => {
    const WALL_SCOPE = { boardType: 'spray', layoutId: 7, sizeId: 7 };
    const wallClimbs: ServerClimb[] = ['mine', 'theirs'].map((uuid, index) => ({
      uuid,
      ownerId: uuid === 'mine' ? VIEWER : 'friend',
      cursor: cursorAt(10 + index),
      boardType: 'spray',
      layoutId: 7,
      sizeId: 7,
    }));
    const server = backend(wallClimbs);
    const syncWall = () => pullSync(db, queryClient, server.fetch, { enabledBoards: ['spray:7:7'], holdIndex });
    await syncWall();
    expect((await ensureHoldIndex(db, WALL_SCOPE, indexOptions)).status).toBe('complete');
    expect(await holdIds('theirs')).toEqual([1, 2]);

    await simulatePrivacyRevalidation(db, VIEWER);

    // A reader asking now must not build an index of half a wall.
    expect((await ensureHoldIndex(db, WALL_SCOPE, indexOptions)).status).toBe('not-downloaded');

    await syncWall();
    expect((await ensureHoldIndex(db, WALL_SCOPE, indexOptions)).status).toBe('complete');
    expect(await holdIds('theirs')).toEqual([1, 2]);
  });

  // The watermark assumes rows arrive in `sync_seq` order. One stream delivers
  // them that way. A saved-climb mirror, or a sibling size, can put a newer row
  // on the device first, so each climbs page says what it changed.
  describe('a climb that arrives behind the watermark', () => {
    /** What the saved-climb mirror does: the climber's own new climb, written ahead of the pull. */
    const mirrorOwnClimb = async (uuid: string, sequence: number) => {
      await db.runAsync(
        `INSERT INTO board_climbs
           (uuid, board_type, layout_id, user_id, compatible_size_ids, frames, is_listed, is_draft, is_hidden, updated_at, sync_seq)
         VALUES (?, 'kilter', 1, ?, '[12]', 'p1r13p2r13', 1, 0, 0, ?, ?)`,
        [uuid, VIEWER, cursorAt(sequence).updatedAt, sequence],
      );
    };

    it('indexes a climb that turns up after the climber’s own newer climb was mirrored and indexed', async () => {
      let climbsOnServer: ServerClimb[] = [catalogueClimb(10)];
      const server = backend(() => climbsOnServer);
      await sync(server.fetch, { holdIndex });

      // The climber saves a climb (95); the mirror writes it at once. A reader
      // builds, and the watermark is now past a climb (80) not pulled yet.
      await mirrorOwnClimb('viewer-new', 95);
      expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('complete');
      climbsOnServer = [
        catalogueClimb(10),
        catalogueClimb(80),
        { ...ownClimb, uuid: 'viewer-new', cursor: cursorAt(95) },
      ];

      await sync(server.fetch, { holdIndex });

      expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-80', 'viewer-new']);
      expect(await holdIds('catalogue-80')).toEqual([1, 2]);
    });

    it('re-derives a climb whose edit lands behind the watermark', async () => {
      let climbsOnServer: ServerClimb[] = [catalogueClimb(10), friendClimb];
      const server = backend(() => climbsOnServer);
      await sync(server.fetch, { holdIndex });
      expect(await holdIds('friend-climb')).toEqual([1, 2]);

      await mirrorOwnClimb('viewer-new', 95);
      expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('complete');
      // The other climber moved their holds (60) before the climber's save (95).
      climbsOnServer = [
        catalogueClimb(10),
        { ...friendClimb, cursor: cursorAt(60), fields: { frames: 'p7r13p8r13' } },
        { ...ownClimb, uuid: 'viewer-new', cursor: cursorAt(95) },
      ];

      await sync(server.fetch, { holdIndex });

      expect(await holdIds('friend-climb')).toEqual([7, 8]);
    });

    it('takes a climb out when a page hides it without its version moving', async () => {
      let climbsOnServer: ServerClimb[] = [catalogueClimb(10), friendClimb];
      const server = backend(() => climbsOnServer);
      await sync(server.fetch, { holdIndex });
      expect(await holdIds('friend-climb')).toEqual([1, 2]);

      // What a replay for a new column looks like: the same row version, with
      // a flag the device did not have.
      climbsOnServer = [catalogueClimb(10), { ...friendClimb, fields: { is_hidden: true } }];
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [CLIMBS_KEY]);
      await sync(server.fetch, { holdIndex });

      expect(await holdIds('friend-climb')).toBeNull();
      expect(await holdIds('catalogue-10')).toEqual([1, 2]);
    });

    it('keeps the index it has when a replay re-delivers climbs exactly as they were', async () => {
      const server = backend([catalogueClimb(10), friendClimb]);
      await sync(server.fetch, { holdIndex });
      const watermark = await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [
        `holds-index:${SCOPE_KEY}`,
      ]);
      expect(watermark).not.toBeNull();
      // Every clear or invalidation of the layout's index bumps this counter.
      const indexGeneration = () =>
        db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['holds-index-generation:kilter:1']);
      const generation = await indexGeneration();

      // The reference cursor is lost (an earlier bundle's revalidation deleted
      // it), so the whole catalogue is delivered again, unchanged.
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [CLIMBS_KEY]);
      await sync(server.fetch, { holdIndex });

      expect(await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [`holds-index:${SCOPE_KEY}`])).toEqual(
        watermark,
      );
      // Kept, not rebuilt to the same value: a rebuild re-reads every climb of
      // the layout.
      expect(await indexGeneration()).toEqual(generation);
    });

    it('leaves the index alone on a first download, which has no watermark to fall behind', async () => {
      const statements: string[] = [];
      const run = db.getAllAsync.bind(db);
      vi.spyOn(db, 'getAllAsync').mockImplementation((source, ...params) => {
        statements.push(source);
        return run(source, ...params);
      });

      await sync(backend([catalogueClimb(10), friendClimb]).fetch);

      // No per-page read of the climbs about to be written.
      expect(statements.filter((source) => source.includes('AS index_inputs'))).toEqual([]);
    });
  });

  it('reads as indexable once the scope is down, and for a wall once its protected rows are too', async () => {
    await db.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, updated_at, sync_seq)
       VALUES ('seeded', 'kilter', 1, '[12]', 'p1r13', 1, 0, '2026-01-01T00:00:00Z', 1),
              ('wall-seeded', 'spray', 7, '[7]', 'p1r13', 1, 0, '2026-01-01T00:00:00Z', 2)`,
    );
    const WALL_SCOPE = { boardType: 'spray', layoutId: 7, sizeId: 7 };
    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('not-downloaded');

    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?), (?, ?)', [
      `scope-complete:${SCOPE_KEY}`,
      '1',
      'scope-complete:spray:7:7',
      '1',
    ]);
    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('complete');
    expect((await ensureHoldIndex(db, WALL_SCOPE, indexOptions)).status).toBe('not-downloaded');

    await markScopeDownloaded(db, 'spray:7:7');
    expect((await ensureHoldIndex(db, WALL_SCOPE, indexOptions)).status).toBe('complete');
  });
});

// A climb that stops being published and listed leaves the reference stream.
// Nothing delivers a row that is no longer there, so the server writes a
// deletion marker for it, stamped a second before the row's new version.
describe('a climb that leaves the public catalogue', () => {
  const parseHoldRows = (_boardType: string, frames: string) =>
    [...frames.matchAll(/p(\d+)r\d+/g)].map((match) => ({ holdId: Number(match[1]), holdState: 'HAND' }));
  const holdIndex = { parseHoldRows };
  const localRowsOf = async (uuid: string) => ({
    climbs: (await db.getAllAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', [uuid])).length,
    stats: (await db.getAllAsync('SELECT climb_uuid FROM board_climb_stats WHERE climb_uuid = ?', [uuid])).length,
    grades: (await db.getAllAsync('SELECT climb_uuid FROM board_climb_grades WHERE climb_uuid = ?', [uuid])).length,
    holdSet: (await getHoldSet(db, uuid)) !== null,
  });

  it('is dropped from every device with its stats, its grades and its place in the holds index', async () => {
    let climbsOnServer: ServerClimb[] = [catalogueClimb(10), friendClimb];
    let deletions: ServerDeletion[] = [];
    const server = backend(() => climbsOnServer, { deletions: () => deletions });
    await sync(server.fetch, { holdIndex });
    expect(await localRowsOf('friend-climb')).toEqual({ climbs: 1, stats: 1, grades: 1, holdSet: true });

    // Its setter takes it back to a draft.
    const asDraft: ServerClimb = { ...friendClimb, cursor: cursorAt(70), fields: { is_draft: true, is_listed: false } };
    climbsOnServer = [catalogueClimb(10), asDraft];
    deletions = [leftReferenceMarker(asDraft)];
    await sync(server.fetch, { holdIndex });

    expect(await localRowsOf('friend-climb')).toEqual({ climbs: 0, stats: 0, grades: 0, holdSet: false });
    expect(await localRowsOf('catalogue-10')).toEqual({ climbs: 1, stats: 1, grades: 1, holdSet: true });
  });

  it('comes back to its owner through the protected stream, and stays', async () => {
    let climbsOnServer: ServerClimb[] = [catalogueClimb(10), ownClimb];
    let deletions: ServerDeletion[] = [];
    const server = backend(() => climbsOnServer, { deletions: () => deletions });
    await sync(server.fetch);

    const asDraft: ServerClimb = { ...ownClimb, cursor: cursorAt(70), fields: { is_draft: true, is_listed: false } };
    climbsOnServer = [catalogueClimb(10), asDraft];
    deletions = [leftReferenceMarker(asDraft)];
    await sync(server.fetch);
    // And again: the marker is behind the deletions cursor now, and the row is
    // newer than the marker either way.
    await sync(server.fetch);

    expect(await db.getAllAsync("SELECT uuid, is_draft FROM board_climbs WHERE uuid = 'viewer-own'")).toEqual([
      { uuid: 'viewer-own', is_draft: 1 },
    ]);
    expect(await localRowsOf('viewer-own')).toMatchObject({ climbs: 1, stats: 1, grades: 1 });
  });

  it('keeps the owner’s row when the marker is processed after the row has already come back', async () => {
    const asDraft: ServerClimb = { ...ownClimb, cursor: cursorAt(70), fields: { is_draft: true, is_listed: false } };
    let deletions: ServerDeletion[] = [];
    const server = backend([catalogueClimb(10), asDraft], { deletions: () => deletions });
    // The draft is on the device before the marker is seen.
    await sync(server.fetch);
    expect(await localRowsOf('viewer-own')).toMatchObject({ climbs: 1 });

    deletions = [leftReferenceMarker(asDraft)];
    await sync(server.fetch);

    // The marker is a second older than the row: it removes the published copy
    // a device holds, never the version that replaced it.
    expect(await localRowsOf('viewer-own')).toMatchObject({ climbs: 1, stats: 1, grades: 1 });
  });
});
