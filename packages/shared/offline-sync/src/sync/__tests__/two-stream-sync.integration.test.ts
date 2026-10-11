// The two-stream board sync (issue #6306), against real SQLite and a backend
// that splits rows the way the resolvers do.
//
// Each board table is pulled twice: a REFERENCE stream of rows that are public
// for every viewer, and a PROTECTED stream of rows the server authorizes per
// viewer. A privacy event resets the protected side only. Before this, such an
// event deleted every board cursor and every completion marker, and a phone
// re-crawled a whole board (about 2,200 pages for Kilter) after each launch.
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
  setCheckpoint,
  setProtectedCheckpoint,
} from '../checkpoints';
import {
  PROTECTED_STATS_AND_GRADES_PULL_INTERVAL_MS,
  pullSync,
  type ScopeDownloadCompleteInfo,
  type SyncOptions,
} from '../pull-client';
import {
  createTwoStreamBackend,
  cursorAt,
  simulatePrivacyRevalidation,
  type ServerClimb,
  type TwoStreamBackendOptions,
} from './helpers/two-stream-fixtures';

const SCOPE_KEY = 'kilter:1:12';
const SCOPE = { boardType: 'kilter', layoutId: 1, sizeId: 12 };
const VIEWER = 'viewer';
const CLIMBS_KEY = `checkpoint:board_climbs:${SCOPE_KEY}`;
const STATS_KEY = `checkpoint:board_climb_stats:${SCOPE_KEY}`;
const GRADES_KEY = `checkpoint:board_climb_grades:${SCOPE_KEY}`;

// A manufacturer climb, the viewer's own climb, and another climber's climb.
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
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);

    await sync(server.fetch);

    expect(server.requestsFor().map((request) => [request.queryName, request.audience])).toEqual([
      ['syncClimbs', 'REFERENCE'],
      ['syncClimbs', 'PROTECTED'],
      ['syncClimbStats', 'REFERENCE'],
      ['syncClimbStats', 'PROTECTED'],
      ['syncClimbGrades', 'REFERENCE'],
      ['syncClimbGrades', 'PROTECTED'],
    ]);
    expect(await localClimbs()).toEqual(['catalogue-10', 'friend-climb', 'viewer-own']);
    expect(await localGrades()).toEqual(['catalogue-10', 'friend-climb', 'viewer-own']);
  });

  it('keeps one cursor per stream in the table’s checkpoint row', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);

    await sync(server.fetch);

    // The reference cursor is where the last manufacturer row was; the protected
    // one is where the last authored row was. Neither moved the other.
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(10));
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(41), complete: true });
    expect(await getCheckpoint(db, STATS_KEY)).toEqual(cursorAt(10));
    expect(await getProtectedCheckpoint(db, GRADES_KEY)).toMatchObject({ ...cursorAt(41), complete: true });
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('resumes each stream from its own cursor on the next cycle', async () => {
    let climbs = [catalogueClimb(10), ownClimb];
    const server = backend(() => climbs);
    await sync(server.fetch);
    server.requests.length = 0;

    climbs = [...climbs, catalogueClimb(50), { ...friendClimb, cursor: cursorAt(60) }];
    await sync(server.fetch);

    expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(10)]);
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([cursorAt(40)]);
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-50', 'friend-climb', 'viewer-own']);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(50));
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject(cursorAt(60));
  });

  it('pages the protected stream and stamps a cursor per page', async () => {
    const authored = Array.from({ length: 5 }, (_unused, index): ServerClimb => ({
      uuid: `authored-${index}`,
      ownerId: 'friend',
      cursor: cursorAt(100 + index),
    }));
    const stampedAfterPage: unknown[] = [];
    const server = backend(authored, {
      pageSize: 2,
      onRequest: async (request) => {
        if (request.queryName === 'syncClimbs' && request.audience === 'PROTECTED') {
          stampedAfterPage.push(await getProtectedCheckpoint(db, CLIMBS_KEY));
        }
      },
    });

    await sync(server.fetch);

    expect(await localClimbs()).toEqual(authored.map((climb) => climb.uuid));
    // Before each request: nothing, then a cursor per committed page. Complete
    // only once the tail is reached, so a cycle cut short mid-stream is not.
    expect(stampedAfterPage).toEqual([
      null,
      expect.objectContaining({ ...cursorAt(101), complete: false }),
      expect.objectContaining({ ...cursorAt(103), complete: false }),
    ]);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(104), complete: true });
  });

  it('marks a board with no authored climb at all as protected-complete, and writes nothing on later cycles', async () => {
    const server = backend([catalogueClimb(10)]);
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

  describe('scope completion', () => {
    it('needs both tails: a board whose protected rows may not be pulled yet is not complete', async () => {
      const server = backend([catalogueClimb(10), friendClimb]);
      const onScopeDownloadComplete = vi.fn();
      let protectedSyncAllowed = false;
      const options = { isProtectedSyncAllowed: () => protectedSyncAllowed, onScopeDownloadComplete };

      await sync(server.fetch, options);

      // The reference catalogue is down, and that is not the board.
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(10));
      expect(server.requestsFor(undefined, 'PROTECTED')).toHaveLength(0);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();

      protectedSyncAllowed = true;
      await sync(server.fetch, options);

      expect(await localClimbs()).toEqual(['catalogue-10', 'friend-climb']);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    });

    it('reports the protected time and row count, and that the pull was split', async () => {
      const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, { onScopeDownloadComplete: (info) => completions.push(info) });

      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ scopeKey: SCOPE_KEY, method: 'paged', audienceMode: 'split' });
      // Two authored climbs, each with a stats and a grade row.
      expect(completions[0].phases.protectedRows).toBe(6);
      expect(completions[0].phases.protectedPullMs).toBeGreaterThanOrEqual(0);
    });

    it('leaves protectedRows out when a protected stream resumed from an earlier cycle’s cursor', async () => {
      const authored = Array.from({ length: 4 }, (_unused, index): ServerClimb => ({
        uuid: `authored-${index}`,
        ownerId: 'friend',
        cursor: cursorAt(100 + index),
      }));
      // The first cycle dies on its second protected climbs page.
      let protectedClimbPages = 0;
      const server = backend(authored, {
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

  describe('first-ascent names', () => {
    it('stores the manufacturer credit a reference row carries', async () => {
      await sync(backend([catalogueClimb(10)]).fetch);

      expect(await localStats()).toEqual([{ climb_uuid: 'catalogue-10', fa_username: 'Manufacturer Setter' }]);
    });

    it('stores no name from the protected stream, whatever the page carries', async () => {
      // The real resolver ships NULL here. This backend is made to ship the name
      // anyway, and the row must still hold none.
      const server = backend([friendClimb], { leakProtectedFirstAscent: true });

      await sync(server.fetch);

      expect(await localStats()).toEqual([{ climb_uuid: 'friend-climb', fa_username: null }]);
    });

    it('clears a name an earlier bundle stored when the protected replay rewrites the row', async () => {
      // The single stream of an earlier bundle delivered this row with a name the
      // server had filled in for this viewer. Same row version as the server's.
      await db.runAsync(
        `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, fa_username, fa_at, updated_at, sync_seq)
         VALUES ('kilter', 'friend-climb', 40, 'A Private Climber', '2020-01-01T00:00:00Z', ?, ?)`,
        [friendClimb.cursor.updatedAt, Number(friendClimb.cursor.syncSeq)],
      );

      await sync(backend([friendClimb]).fetch);

      expect(
        await db.getAllAsync('SELECT climb_uuid, fa_username, fa_at, display_difficulty FROM board_climb_stats'),
      ).toEqual([{ climb_uuid: 'friend-climb', fa_username: null, fa_at: null, display_difficulty: 20 }]);
    });
  });

  // A reference row is public for every viewer, and the first thing that means
  // is "it has no owner". If the reference stream ever carried an owned climb,
  // the device would keep it under a cursor no privacy event resets.
  it('refuses a reference page that carries an owned climb, writing none of it', async () => {
    const misfiled = { ...friendClimb, uuid: 'misfiled' };
    const server = createTwoStreamBackend({ climbs: () => [catalogueClimb(10)] });
    const fetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      const response = await server.fetch<Record<string, { documents: Record<string, unknown>[] }>>(query, variables);
      if (query.includes('syncClimbs(') && variables?.audience === 'REFERENCE') {
        response.syncClimbs.documents.push({
          uuid: misfiled.uuid,
          board_type: 'kilter',
          layout_id: 1,
          user_id: 'friend',
        });
      }
      return response as T;
    }) as typeof server.fetch;

    await expect(sync(fetch)).rejects.toThrow('owned climb in the reference stream');

    expect(await localClimbs()).toEqual([]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
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
});

describe('a privacy event', () => {
  // After the event the server no longer shows the viewer the friend's climb.
  let friendIsVisible: boolean;
  const serverClimbs = [catalogueClimb(10), catalogueClimb(11), ownClimb, friendClimb];
  const privacyAwareBackend = (extra: Partial<TwoStreamBackendOptions> = {}) =>
    backend(serverClimbs, { canSee: (climb) => climb.ownerId === VIEWER || friendIsVisible, ...extra });

  beforeEach(() => {
    friendIsVisible = true;
  });

  it('removes another climber’s rows and brings back only what the server still allows', async () => {
    const server = privacyAwareBackend();
    await sync(server.fetch);
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11', 'friend-climb', 'viewer-own']);

    friendIsVisible = false;
    await simulatePrivacyRevalidation(db, VIEWER);
    // Gone before the server is asked again, with its stats and grade row.
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11', 'viewer-own']);
    expect((await localStats()).map((row) => row.climb_uuid)).toEqual(['catalogue-10', 'catalogue-11', 'viewer-own']);
    expect(await localGrades()).toEqual(['catalogue-10', 'catalogue-11', 'viewer-own']);

    await sync(server.fetch);

    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11', 'viewer-own']);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('replays the protected streams from the epoch and leaves the reference cursors where they were', async () => {
    const server = privacyAwareBackend();
    await sync(server.fetch);
    const referenceBefore = {
      climbs: await getCheckpoint(db, CLIMBS_KEY),
      stats: await getCheckpoint(db, STATS_KEY),
      grades: await getCheckpoint(db, GRADES_KEY),
    };

    await simulatePrivacyRevalidation(db, VIEWER);
    server.requests.length = 0;
    await sync(server.fetch);

    expect({
      climbs: await getCheckpoint(db, CLIMBS_KEY),
      stats: await getCheckpoint(db, STATS_KEY),
      grades: await getCheckpoint(db, GRADES_KEY),
    }).toEqual(referenceBefore);
    // One request per stream: the reference ones from their tail, the protected
    // ones from the start.
    for (const queryName of ['syncClimbs', 'syncClimbStats', 'syncClimbGrades']) {
      expect(server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(11)]);
      expect(server.requestsFor(queryName, 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
    }
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11', 'friend-climb', 'viewer-own']);
  });

  // The Completed event's contract is once per download (docs/board-snapshots.md).
  // It used to fire again after every privacy event, because the event deleted
  // the marker that guards it.
  it('does not re-fire the download-completed event, however many follow', async () => {
    const server = privacyAwareBackend();
    const onScopeDownloadComplete = vi.fn();
    const options = { onScopeDownloadComplete };
    await sync(server.fetch, options);
    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);

    for (let event = 0; event < 4; event += 1) {
      await simulatePrivacyRevalidation(db, VIEWER);
      // Still downloaded while the replay is pending.
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      await sync(server.fetch, options);
      expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    }

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    // Four events cost four small replays. The reference streams never started
    // over: each was asked from the epoch once, on the first download.
    for (const queryName of ['syncClimbs', 'syncClimbStats', 'syncClimbGrades']) {
      const fromTheStart = server.requestsFor(queryName, 'REFERENCE').filter((request) => request.cursor === undefined);
      expect(fromTheStart).toHaveLength(1);
      expect(server.requestsFor(queryName, 'PROTECTED').filter((request) => request.cursor === undefined)).toHaveLength(
        5,
      );
    }
  });

  describe('landing while a download is in progress', () => {
    // 12 manufacturer climbs at 5 a page: three reference pages for the climbs.
    const bigCatalogue = Array.from({ length: 12 }, (_unused, index) => catalogueClimb(10 + index));
    const boardClimbs = [...bigCatalogue, ownClimb, friendClimb];

    it('keeps the reference rows and cursor, finishes the reference crawl, and resumes instead of restarting', async () => {
      let eventFired = false;
      const server = backend(boardClimbs, {
        pageSize: 5,
        onRequest: async (request) => {
          // Mid-crawl: the second reference climbs page is about to be served.
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

      // The crawl carried on through the event: every reference page of every
      // table, each from where the one before it ended.
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
        undefined,
        cursorAt(14),
        cursorAt(19),
      ]);
      expect(await localClimbs()).toEqual(bigCatalogue.map((climb) => climb.uuid).sort());
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(21));
      expect(server.requestsFor('syncClimbStats', 'REFERENCE').length).toBeGreaterThan(0);
      // Nothing protected was pulled in the cycle the event landed in, so the
      // board is not complete yet.
      expect(server.requestsFor(undefined, 'PROTECTED')).toHaveLength(0);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();

      server.requests.length = 0;
      await sync(server.fetch, { onScopeDownloadComplete });

      // The next cycle picks the reference streams up at their tails. Not one
      // request starts over.
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(21)]);
      expect(server.requestsFor(undefined, 'REFERENCE').every((request) => request.cursor !== undefined)).toBe(true);
      expect(await localClimbs()).toEqual(boardClimbs.map((climb) => climb.uuid).sort());
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    });

    it('does not mark the board complete on protected tails an event has just voided', async () => {
      // The event lands after the LAST stream committed its tail and before the
      // completion marker is written: every stream reported its tail, and the
      // purge that is about to run takes the protected ones back.
      let lastStreamFetched = false;
      const server = backend(boardClimbs, {
        onRequest: (request) => {
          if (request.queryName === 'syncClimbGrades' && request.audience === 'PROTECTED') lastStreamFetched = true;
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

      await sync(server.fetch, { onScopeDownloadComplete });

      // The page itself was written: it was authorized when it landed.
      expect(await getProtectedCheckpoint(db, GRADES_KEY)).toMatchObject({ complete: true });
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();
    });
  });

  // THE FENCE. A protected page is the server's answer as of when it was built.
  // One built before a privacy event must not be written after the event's
  // purge: it would put a withdrawn row back, under a cursor past it.
  describe('the fence on protected pages', () => {
    it('drops a page that was on the wire when the event landed', async () => {
      let eventFired = false;
      const server = privacyAwareBackend({
        onRequest: async (request) => {
          if (request.queryName !== 'syncClimbs' || request.audience !== 'PROTECTED' || eventFired) return;
          eventFired = true;
          // The server built this page while the friend's climb was visible. The
          // event, and the purge, happen before the response arrives; the
          // response itself still carries the row.
          await simulatePrivacyRevalidation(db, VIEWER);
        },
      });

      await sync(server.fetch);
      friendIsVisible = false;

      expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11']);
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
      // The rest of the cycle's protected streams were not even asked.
      expect(server.requestsFor('syncClimbStats', 'PROTECTED')).toHaveLength(0);
      expect(server.requestsFor('syncClimbGrades', 'PROTECTED')).toHaveLength(0);

      await sync(server.fetch);
      expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11', 'viewer-own']);
    });

    it('drops a page whose write was waiting for the lock when the event landed', async () => {
      const server = privacyAwareBackend();
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
        if (query.includes('syncClimbs(') && variables?.audience === 'PROTECTED') armed = true;
        return response;
      }) as typeof server.fetch;

      await sync(fetch);

      // Its rows were rolled back with its cursor.
      expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11']);
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
    });

    it('does not let a cycle queued before the event write protected rows after it', async () => {
      const server = privacyAwareBackend();
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
      const queuedCycle = sync(server.fetch);

      await simulatePrivacyRevalidation(db, VIEWER);
      releaseFirst();
      await firstCycle;
      await queuedCycle;

      expect(server.requestsFor(undefined, 'PROTECTED')).toHaveLength(0);
      expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11']);
      // The reference rows it was also queued for did land.
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(11));
    });

    it('pulls no protected row while the platform says a revalidation is pending', async () => {
      const server = privacyAwareBackend();

      await sync(server.fetch, { isProtectedSyncAllowed: () => false });

      expect(server.requestsFor(undefined, 'PROTECTED')).toHaveLength(0);
      expect(server.requestsFor(undefined, 'REFERENCE').length).toBeGreaterThan(0);
      expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-11']);
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

// What a request for the protected stats or grades stream costs the server does
// not depend on whether anything changed (about 30,000 buffer hits each on
// Kilter's largest layout), so they are pulled only when there is a reason to.
describe('rationing the protected stats and grades streams', () => {
  const START = Date.UTC(2026, 9, 11, 12, 0, 0);
  const rationedRequests = (server: ReturnType<typeof backend>) =>
    ['syncClimbStats', 'syncClimbGrades'].flatMap((queryName) => server.requestsFor(queryName, 'PROTECTED'));
  let clock: number;
  const options = (): SyncOptions => ({ now: () => clock });

  beforeEach(() => {
    clock = START;
  });

  it('makes no protected stats or grades request on an ordinary cycle', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
    await sync(server.fetch, options());
    expect(rationedRequests(server)).toHaveLength(2);
    server.requests.length = 0;

    clock += 60_000;
    await sync(server.fetch, options());

    expect(rationedRequests(server)).toHaveLength(0);
    // The reference streams and the protected climbs stream still ran.
    expect(server.requestsFor().map((request) => [request.queryName, request.audience])).toEqual([
      ['syncClimbs', 'REFERENCE'],
      ['syncClimbs', 'PROTECTED'],
      ['syncClimbStats', 'REFERENCE'],
      ['syncClimbGrades', 'REFERENCE'],
    ]);
    // And a board left alone like this is still a complete download.
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('pulls them when the protected state was reset', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
    await sync(server.fetch, options());
    server.requests.length = 0;

    clock += 60_000;
    await simulatePrivacyRevalidation(db, VIEWER);
    await sync(server.fetch, options());

    expect(rationedRequests(server).map((request) => [request.queryName, request.cursor])).toEqual([
      ['syncClimbStats', undefined],
      ['syncClimbGrades', undefined],
    ]);
  });

  it('pulls them when their own stream never reached its tail', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
    await sync(server.fetch, options());
    // A stats stream cut short mid-replay by a cycle that died.
    await setProtectedCheckpoint(db, STATS_KEY, { ...cursorAt(40), complete: false, revision: 0, pulledAt: clock });
    server.requests.length = 0;

    clock += 60_000;
    await sync(server.fetch, options());

    expect(rationedRequests(server).map((request) => request.queryName)).toEqual(['syncClimbStats']);
  });

  it('pulls them when the protected climbs stream delivered a row this cycle', async () => {
    let climbs = [catalogueClimb(10), ownClimb];
    const server = backend(() => climbs);
    await sync(server.fetch, options());
    server.requests.length = 0;

    clock += 60_000;
    climbs = [...climbs, { ...friendClimb, cursor: cursorAt(60) }];
    await sync(server.fetch, options());

    // From where each left off, not from the start.
    expect(rationedRequests(server).map((request) => [request.queryName, request.cursor])).toEqual([
      ['syncClimbStats', cursorAt(40)],
      ['syncClimbGrades', cursorAt(40)],
    ]);
    expect((await localStats()).map((row) => row.climb_uuid)).toEqual(['catalogue-10', 'friend-climb', 'viewer-own']);
  });

  it('does not pull them for a new reference row alone', async () => {
    let climbs = [catalogueClimb(10), ownClimb];
    const server = backend(() => climbs);
    await sync(server.fetch, options());
    server.requests.length = 0;

    clock += 60_000;
    climbs = [...climbs, catalogueClimb(50)];
    await sync(server.fetch, options());

    expect(rationedRequests(server)).toHaveLength(0);
    expect(await localClimbs()).toEqual(['catalogue-10', 'catalogue-50', 'viewer-own']);
  });

  it('pulls them once the interval has passed, and then not again until it passes once more', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
    await sync(server.fetch, options());
    server.requests.length = 0;

    clock = START + PROTECTED_STATS_AND_GRADES_PULL_INTERVAL_MS - 1;
    await sync(server.fetch, options());
    expect(rationedRequests(server)).toHaveLength(0);

    clock = START + PROTECTED_STATS_AND_GRADES_PULL_INTERVAL_MS;
    await sync(server.fetch, options());
    expect(rationedRequests(server).map((request) => request.queryName)).toEqual(['syncClimbStats', 'syncClimbGrades']);
    server.requests.length = 0;

    // The pull that found nothing still recorded when it ran.
    clock += 60_000;
    await sync(server.fetch, options());
    expect(rationedRequests(server)).toHaveLength(0);
  });

  it('is fifteen minutes', () => {
    expect(PROTECTED_STATS_AND_GRADES_PULL_INTERVAL_MS).toBe(15 * 60_000);
  });

  it('treats a pull time in the future as due, so a clock set back cannot park the streams', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
    await sync(server.fetch, options());
    server.requests.length = 0;

    clock = START - 24 * 60 * 60_000;
    await sync(server.fetch, options());

    expect(rationedRequests(server)).toHaveLength(2);
  });

  it('pulls a stream a bundle before the rationing left with no pull time', async () => {
    const server = backend([catalogueClimb(10), ownClimb, friendClimb]);
    await sync(server.fetch, options());
    await setProtectedCheckpoint(db, STATS_KEY, { ...cursorAt(41), complete: true, revision: 0 });
    server.requests.length = 0;

    clock += 60_000;
    await sync(server.fetch, options());

    expect(rationedRequests(server).map((request) => request.queryName)).toEqual(['syncClimbStats']);
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
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(10));

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

// The holds index is derived from climb rows and stamped with a `sync_seq`
// watermark. A privacy event removes other climbers' climbs and the replay
// brings the permitted ones back with the `sync_seq` they always had.
describe('the holds index across a protected replay', () => {
  const parseHoldRows = (_boardType: string, frames: string) =>
    [...frames.matchAll(/p(\d+)r\d+/g)].map((match) => ({ holdId: Number(match[1]), holdState: 'HAND' }));
  const indexOptions = { parseHoldRows, yieldToHost: async () => {} };
  const holdIndex = { parseHoldRows };

  it('is not built while the protected rows are still out', async () => {
    const server = backend([catalogueClimb(10), friendClimb]);
    await sync(server.fetch, { holdIndex });
    expect(await getHoldSet(db, 'friend-climb')).not.toBeNull();

    await simulatePrivacyRevalidation(db, VIEWER);
    // What the real revalidation also does for a layout that lost a climb.
    await db.runAsync("DELETE FROM sync_meta WHERE key LIKE 'holds-index:%'");

    // A reader asking now must not stamp a watermark over the gap.
    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('not-downloaded');
    expect(await db.getFirstAsync("SELECT key FROM sync_meta WHERE key LIKE 'holds-index:kilter%'")).toBeNull();

    await sync(server.fetch, { holdIndex });

    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('complete');
    expect(await getHoldSet(db, 'friend-climb')).not.toBeNull();
    expect(await getHoldSet(db, 'catalogue-10')).not.toBeNull();
  });

  it('indexes a climb the viewer has only just been allowed to see, though it is older than the watermark', async () => {
    let friendIsVisible = false;
    const newerCatalogueClimb = catalogueClimb(90);
    const server = backend([newerCatalogueClimb, friendClimb], { canSee: () => friendIsVisible });
    await sync(server.fetch, { holdIndex });
    // Indexed up to sequence 90; the friend's climb (41) is not on the device.
    expect(await getHoldSet(db, 'friend-climb')).toBeNull();

    // A follow is approved. No row was lost, so no layout was cleared.
    friendIsVisible = true;
    await simulatePrivacyRevalidation(db, VIEWER);
    await sync(server.fetch, { holdIndex });

    expect(await localClimbs()).toEqual(['catalogue-90', 'friend-climb']);
    expect(await getHoldSet(db, 'friend-climb')).not.toBeNull();
  });

  it('keeps the index it has when a replay only re-delivers climbs that are already in it', async () => {
    const server = backend([catalogueClimb(10), ownClimb]);
    await sync(server.fetch, { holdIndex });
    const watermark = await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [`holds-index:${SCOPE_KEY}`]);
    expect(watermark).not.toBeNull();

    // The viewer's own climb survives the purge and comes back unchanged.
    await simulatePrivacyRevalidation(db, VIEWER);
    await sync(server.fetch, { holdIndex });

    expect(await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [`holds-index:${SCOPE_KEY}`])).toEqual(
      watermark,
    );
  });

  it('reads as indexable only with both halves of the scope down', async () => {
    await db.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, updated_at, sync_seq)
       VALUES ('seeded', 'kilter', 1, '[12]', 'p1r13', 1, 0, '2026-01-01T00:00:00Z', 1)`,
    );
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`scope-complete:${SCOPE_KEY}`, '1']);
    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('not-downloaded');

    await markScopeDownloaded(db, SCOPE_KEY);
    expect((await ensureHoldIndex(db, SCOPE, indexOptions)).status).toBe('complete');
  });
});
