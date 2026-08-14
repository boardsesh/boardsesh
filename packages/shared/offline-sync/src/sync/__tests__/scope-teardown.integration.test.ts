// The hazard proofs for scope teardown, driven through the REAL pullSync against the
// REAL on-device DDL.
//
// scope-teardown.test.ts asserts the teardown's own SQL. This file asserts the thing
// that actually matters to a user: that a board removed to free space comes BACK
// whole when they download it again. Those are different claims — the rows can be
// deleted perfectly and the catalog still be permanently ruined by one surviving
// sync_meta row, because the delta pull is a strict `>` keyset and never looks back.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator, SqlValue } from '../../database';
import { pullSync } from '../pull-client';
import { removeBoardScopeData } from '../scope-teardown';
import {
  getCheckpoint,
  setCheckpoint,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  isScopeDownloadStarted,
} from '../checkpoints';
import { isUserDataComplete } from '../local-user-owner';
import { getDeletionsCoverageAt } from '../deletions-coverage';
import { getBootstrapAttempts } from '../bootstrap-retry';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import {
  beginScopePurge,
  beginGlobalPurge,
  setSigningOut,
  __resetDrainerStateForTests,
} from '../../mutation-queue/drainer';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { TABLE_CONFIGS, USER_DATA_TABLES } from '../table-config';
import type { OfflineBoardScope } from '../../offline-board-key';

const SCOPE: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
const SCOPE_KEY = 'kilter:1:5';

let db: TestSqliteDb;
let queryClient: QueryInvalidator;

function createQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn() };
}

const CLIMB_DOC = {
  uuid: 'climb-1',
  board_type: 'kilter',
  layout_id: 1,
  name: 'Original catalog climb',
  is_draft: false,
  is_listed: true,
  compatible_size_ids: [5],
  updated_at: '2026-05-01T00:00:00Z',
  sync_seq: '10',
};

// Mirrors pull-client.test.ts: pullSync's GraphQLFetch is generic in its return, which
// a concrete vi.fn() can't satisfy structurally, so the mock is cast to the seam.
type GraphqlFetchMock = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/**
 * Serves one page of board_climbs and empty pages for everything else, recording the
 * cursor each syncClimbs call was made with — the cursor is the whole point: an
 * `undefined` first cursor means the scope pulls from epoch (a full re-download),
 * anything else means it resumed past rows that no longer exist.
 */
function createFetch(climbsCursors: unknown[]): GraphqlFetchMock {
  const fetchMock = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
    }
    if (query.includes('syncClimbs')) {
      climbsCursors.push(variables?.cursor);
      return {
        syncClimbs: {
          documents: [CLIMB_DOC],
          cursor: { updatedAt: CLIMB_DOC.updated_at, syncSeq: '10' },
          hasMore: false,
        },
      };
    }
    for (const config of Object.values(TABLE_CONFIGS)) {
      if (query.includes(config.queryName)) {
        return { [config.queryName]: { documents: [], cursor: null, hasMore: false } };
      }
    }
    throw new Error(`Unexpected query: ${query}`);
  });
  return fetchMock as unknown as GraphqlFetchMock;
}

async function climbCount(): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM board_climbs');
  return row?.n ?? 0;
}

beforeEach(async () => {
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await runMigrations(db);
  queryClient = createQueryClient();
});

afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
});

describe('re-downloading a removed board', () => {
  it('pulls the catalog from epoch, not from a stale checkpoint', async () => {
    // Download it once.
    await pullSync(db, queryClient, createFetch([]), { enabledBoards: [SCOPE_KEY] });
    await markScopeDownloadComplete(db, SCOPE_KEY);
    expect(await climbCount()).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).not.toBeNull();

    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });
    expect(await climbCount()).toBe(0);

    // Re-enable and sync again.
    const cursors: unknown[] = [];
    await pullSync(db, queryClient, createFetch(cursors), { enabledBoards: [SCOPE_KEY] });

    // Undefined = "start from the beginning". Any other value means the pull resumed
    // past the deleted rows, which the strict `>` delta would never have revisited.
    expect(cursors[0]).toBeUndefined();
    expect(await climbCount()).toBe(1);
  });

  // The executable statement of the hazard: this is what deleting rows WITHOUT
  // clearing the checkpoint would do. If someone ever splits the teardown transaction
  // so markers can survive the rows, the test above starts failing and this one
  // explains why.
  it('would resume past the deleted rows if a checkpoint survived', async () => {
    await pullSync(db, queryClient, createFetch([]), { enabledBoards: [SCOPE_KEY] });
    const survivingCheckpoint = await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`);

    // Rows deleted, checkpoint deliberately left behind.
    await db.runAsync('DELETE FROM board_climbs');
    await setCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`, survivingCheckpoint!);

    const cursors: unknown[] = [];
    await pullSync(db, queryClient, createFetch(cursors), { enabledBoards: [SCOPE_KEY] });

    expect(cursors[0]).toEqual(survivingCheckpoint);
  });

  it('restores snapshot-bootstrap eligibility after attempts were exhausted', async () => {
    await pullSync(db, queryClient, createFetch([]), { enabledBoards: [SCOPE_KEY] });
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-attempts:${SCOPE_KEY}`,
      '2',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-done:${SCOPE_KEY}`,
      '1',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-paged-fallback:${SCOPE_KEY}`,
      '1',
    ]);
    // The one-shot attempt heal was already spent before the user removed the
    // board; re-adding it must hand back a fresh heal budget too (issue #4238).
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-attempts-healed:${SCOPE_KEY}`,
      '1',
    ]);
    // …as must the retry budgets and cooldown the scope settled into (#4313).
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-retry:${SCOPE_KEY}`,
      JSON.stringify({ transportFailures: 3, structuralFailures: 2, retryAfter: 1_800_000_000_000 }),
    ]);

    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });

    // Attempts reset and every board-data checkpoint gone — the conditions
    // runBootstrapPhase requires before it will warm a scope from a snapshot.
    expect(await getBootstrapAttempts(db, SCOPE_KEY)).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).toBeNull();
    expect(await getCheckpoint(db, `checkpoint:board_climb_stats:${SCOPE_KEY}`)).toBeNull();
    expect(await getCheckpoint(db, `checkpoint:board_climb_grades:${SCOPE_KEY}`)).toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [`bootstrap-paged-fallback:${SCOPE_KEY}`]),
    ).toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [`bootstrap-retry:${SCOPE_KEY}`]),
    ).toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [`bootstrap-attempts-healed:${SCOPE_KEY}`]),
    ).toBeNull();
  });
});

const TENSION_SCOPE_KEY = 'tension:2:8';

const TENSION_CLIMB_DOC = {
  uuid: 'tension-climb-1',
  board_type: 'tension',
  layout_id: 2,
  name: 'Tension catalog climb',
  is_draft: false,
  is_listed: true,
  compatible_size_ids: [8],
  updated_at: '2026-05-01T00:00:00Z',
  sync_seq: '10',
};

// The LAST board table in BOARD_DATA_TABLES, so its checkpoint write is the final
// await before the scope-complete block.
const GRADE_DOC = {
  board_type: 'kilter',
  climb_uuid: 'climb-1',
  angle: 40,
  local_grade: '7A',
  universal_grade: 20,
  grade_low: 19,
  grade_high: 21,
  confidence: 0.9,
  ascensionist_count: 12,
  computed_at: '2026-05-01T00:00:00Z',
  sync_seq: '10',
};

// The LAST user table in USER_DATA_TABLES, same reason for markUserDataComplete.
const PLAYLIST_FOLLOW_DOC = {
  playlist_uuid: 'playlist-1',
  follower_id: 1,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  sync_seq: '10',
};

const TICK_DOC = {
  uuid: 'tick-1',
  user_id: 1,
  board_type: 'kilter',
  climb_uuid: 'climb-1',
  angle: 40,
  is_mirror: false,
  status: 'sent',
  attempt_count: 1,
  quality: 3,
  difficulty: 20,
  is_benchmark: false,
  comment: '',
  climbed_at: '2026-05-01T00:00:00Z',
  session_id: null,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  sync_seq: '10',
};

/** One page per table+scope, so every pull reaches its checkpoint write. */
function documentsFor(tableName: string, scopeKey: string | null): Record<string, unknown>[] {
  if (tableName === 'board_climbs' && scopeKey === SCOPE_KEY) return [CLIMB_DOC];
  if (tableName === 'board_climbs' && scopeKey === TENSION_SCOPE_KEY) return [TENSION_CLIMB_DOC];
  if (tableName === 'board_climb_grades' && scopeKey === SCOPE_KEY) return [GRADE_DOC];
  if (tableName === 'boardsesh_ticks') return [TICK_DOC];
  if (tableName === 'playlist_follows') return [PLAYLIST_FOLLOW_DOC];
  return [];
}

/**
 * Fire `onWrite` right AFTER a sync_meta write for `key` commits. That is the
 * exact window the two new guards exist for: a purge landing there has already
 * cleared syncTable's post-await guard, so nothing else stands between it and
 * the marker write.
 */
function firstBoundParam(params: readonly SqlValue[]): SqlValue | undefined {
  // Both of runAsync/getFirstAsync's overloads are used across the engine: one
  // passes a params ARRAY, the other spreads them. Normalise so a spy can match
  // on the first bound value either way.
  const first: unknown = params[0];
  return Array.isArray(first) ? (first as SqlValue[])[0] : (first as SqlValue | undefined);
}

function afterSyncMetaWrite(key: string, onWrite: () => void): () => void {
  const originalRun: OfflineDatabase['runAsync'] = db.runAsync.bind(db);
  const spy = vi.spyOn(db, 'runAsync').mockImplementation(async (source: string, ...params: SqlValue[]) => {
    const result = await originalRun(source, ...params);
    if (firstBoundParam(params) === key) onWrite();
    return result;
  });
  return () => spy.mockRestore();
}

/** Which board scope a per-board query was asked for, as a scope key. */
function scopeKeyOf(variables: Record<string, unknown> | undefined): string | null {
  const boardType = variables?.boardType;
  if (typeof boardType !== 'string') return null;
  return `${boardType}:${Number(variables?.layoutId)}:${Number(variables?.sizeId)}`;
}

/**
 * A fetch that serves TWO board scopes on different layouts plus one user tick,
 * and calls `onFetch` for every table+scope pair BEFORE it resolves — so a test
 * can fire a purge from precisely the await it wants to race.
 */
function makeMultiScopeFetch(onFetch: (info: { tableName: string; scopeKey: string | null }) => void): {
  fetch: GraphqlFetchMock;
  fetched: { tableName: string; scopeKey: string | null }[];
} {
  const fetched: { tableName: string; scopeKey: string | null }[] = [];
  const fetchMock = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes('syncDeletions')) {
      const call = { tableName: 'deletions', scopeKey: null };
      fetched.push(call);
      onFetch(call);
      return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
    }
    for (const [tableName, config] of Object.entries(TABLE_CONFIGS)) {
      if (!query.includes(config.queryName)) continue;
      const scopeKey = scopeKeyOf(variables);
      const call = { tableName, scopeKey };
      fetched.push(call);
      onFetch(call);
      const documents = documentsFor(tableName, scopeKey);
      return {
        [config.queryName]: {
          documents,
          cursor: documents.length > 0 ? { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' } : null,
          hasMore: false,
        },
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  });
  return { fetch: fetchMock as unknown as GraphqlFetchMock, fetched };
}

const BOTH_SCOPES = [SCOPE_KEY, TENSION_SCOPE_KEY];

async function climbCountFor(boardType: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM board_climbs WHERE board_type = ?', [
    boardType,
  ]);
  return row?.n ?? 0;
}

describe('scope purges', () => {
  // THE HEADLINE (issue #4370). Removing one board used to bump one global epoch,
  // so every OTHER board's in-flight download died with it. Now a purge stops only
  // the namespace it can actually delete rows in.
  it("lets an unrelated scope's download finish while another board is being removed", async () => {
    const { fetch } = makeMultiScopeFetch(({ tableName, scopeKey }) => {
      // A removal of the tension board fires while kilter's climbs page is on the wire.
      if (tableName === 'board_climbs' && scopeKey === SCOPE_KEY) beginScopePurge('tension:2')();
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: BOTH_SCOPES });

    expect(await climbCountFor('kilter')).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).not.toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);

    // The removed scope pulled nothing and holds no state that could outlive its rows.
    expect(await climbCountFor('tension')).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${TENSION_SCOPE_KEY}`)).toBeNull();
    expect(await isScopeDownloadComplete(db, TENSION_SCOPE_KEY)).toBe(false);
  });

  // The resurrection window, for the scope actually being removed: a page already on
  // the wire when the delete runs must NOT land afterwards.
  it("discards the purged scope's in-flight page while the other scope completes", async () => {
    const { fetch } = makeMultiScopeFetch(({ tableName, scopeKey }) => {
      if (tableName === 'board_climbs' && scopeKey === SCOPE_KEY) beginScopePurge('kilter:1')();
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: BOTH_SCOPES });

    expect(await climbCountFor('kilter')).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
    expect(await isScopeDownloadStarted(db, SCOPE_KEY)).toBe(true);

    expect(await climbCountFor('tension')).toBe(1);
    expect(await isScopeDownloadComplete(db, TENSION_SCOPE_KEY)).toBe(true);
  });

  // The deliberate over-abort of the layout-keyed namespace: two SIZES of one layout
  // share climb rows AND one artifact, so removing one stops the sibling for a cycle.
  // Its checkpoints survive, so it resumes on the next trigger.
  it('aborts a sibling SIZE of the purged layout, without losing its checkpoints', async () => {
    const siblingKey = 'kilter:1:10';
    await setCheckpoint(db, `checkpoint:board_climbs:${siblingKey}`, {
      updatedAt: '2026-04-01T00:00:00Z',
      syncSeq: '5',
    });

    const { fetch } = makeMultiScopeFetch(({ tableName, scopeKey }) => {
      if (tableName === 'board_climbs' && scopeKey === siblingKey) beginScopePurge('kilter:1')();
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: [siblingKey, TENSION_SCOPE_KEY] });

    expect(await getCheckpoint(db, `checkpoint:board_climbs:${siblingKey}`)).toEqual({
      updatedAt: '2026-04-01T00:00:00Z',
      syncSeq: '5',
    });
    expect(await isScopeDownloadComplete(db, siblingKey)).toBe(false);
    expect(await isScopeDownloadComplete(db, TENSION_SCOPE_KEY)).toBe(true);
  });

  // FAILS BEFORE #4370: the removal's global epoch bump aborted the user-data pull
  // too, even though removeBoardScopeData never touches a user table.
  it('lets the user-data phase finish through a board purge', async () => {
    const { fetch } = makeMultiScopeFetch(({ tableName }) => {
      if (tableName === 'boardsesh_ticks') beginScopePurge('kilter:1')();
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: BOTH_SCOPES });

    const ticks = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM boardsesh_ticks');
    expect(ticks?.n).toBe(1);
    expect(await getCheckpoint(db, 'checkpoint:boardsesh_ticks')).not.toBeNull();
    expect(await isUserDataComplete(db)).toBe(true);
  });

  // Same claim for the deletions phase and its coverage marker: the tombstone stream
  // is user-wide, and a board removal cannot invalidate a single row of it.
  it('lets the deletions phase finish and stamp coverage through a board purge', async () => {
    const { fetch } = makeMultiScopeFetch(({ tableName }) => {
      if (tableName === 'deletions') beginScopePurge('kilter:1')();
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: BOTH_SCOPES });

    expect(await getDeletionsCoverageAt(db)).not.toBeNull();
  });

  // The CRITICAL race the loop-top `allTablesReachedTail = false` provably cannot
  // cover: it only runs on a loop-top break, which never executes after the FINAL
  // table. Every table reaches its tail cleanly and the purge lands from the LAST
  // one's resolution — i.e. after the final page's post-await guard has passed. A
  // `scope-complete:` marker written here would outlive its rows, which
  // scope-teardown.ts calls unrecoverable short of a reinstall.
  it('never writes scope-complete after a purge that landed during the last table', async () => {
    const completed: string[] = [];
    const { fetch } = makeMultiScopeFetch(() => {});
    // Fires once the FINAL board table's checkpoint has committed: every table
    // reached its tail cleanly, so the loop-top break never runs and
    // `allTablesReachedTail` is still true when control reaches the block.
    const restore = afterSyncMetaWrite(`checkpoint:board_climb_grades:${SCOPE_KEY}`, () =>
      beginScopePurge('kilter:1')(),
    );

    await pullSync(db, queryClient, fetch, {
      enabledBoards: [SCOPE_KEY],
      onScopeDownloadComplete: (info) => completed.push(info.scopeKey),
    });
    restore();

    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
    expect(completed).not.toContain(SCOPE_KEY);
  });

  // The second half of the same fix: the purge lands between the
  // `isScopeDownloadComplete` READ and the `markScopeDownloadComplete` WRITE.
  it('never writes scope-complete after a purge that landed on the completion read', async () => {
    const { fetch } = makeMultiScopeFetch(() => {});
    const originalGetFirst: OfflineDatabase['getFirstAsync'] = db.getFirstAsync.bind(db);
    // The completion block's own read. `emitScopeDownloadStartOnce` reads the same
    // key earlier in the cycle (its backfill guard), so only the SECOND read sits
    // in the one-statement window between the decision and the write.
    let scopeCompleteReads = 0;
    const getFirstSpy = vi
      .spyOn(db, 'getFirstAsync')
      .mockImplementation(async (source: string, ...params: SqlValue[]) => {
        const result = await originalGetFirst(source, ...params);
        if (firstBoundParam(params) === `scope-complete:${SCOPE_KEY}`) {
          scopeCompleteReads += 1;
          if (scopeCompleteReads === 2) beginScopePurge('kilter:1')();
        }
        return result;
      });

    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY] });
    getFirstSpy.mockRestore();

    expect(scopeCompleteReads).toBeGreaterThanOrEqual(2);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
  });

  // The GLOBAL analogue at markUserDataComplete: a wipe landing during the last user
  // table's final awaits must not stamp `user_data_complete` over data being cleared.
  it('never stamps user_data_complete after a global purge landed during the last user table', async () => {
    // Pins the assumption the hook below rests on: if the table order ever changes,
    // fail here rather than silently stop testing the race.
    expect(USER_DATA_TABLES[USER_DATA_TABLES.length - 1]).toBe('playlist_follows');
    const { fetch } = makeMultiScopeFetch(() => {});
    const restore = afterSyncMetaWrite('checkpoint:playlist_follows', () => beginGlobalPurge());

    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY] });
    restore();

    expect(await isUserDataComplete(db)).toBe(false);
  });
});

describe('global purges', () => {
  // The bug the original global epoch existed for, unchanged: pullSync iterates
  // `enabledBoards` as captured BEFORE the cycle began, so a wipe must abort the
  // WHOLE cycle rather than let later tables re-baseline and sail through.
  it('stops the whole cycle, not just the table that was mid-flight', async () => {
    const purgeAfter = 'boardsesh_ticks';
    const queriedTables: string[] = [];

    const graphqlFetch = vi.fn(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
      }
      for (const [tableName, config] of Object.entries(TABLE_CONFIGS)) {
        if (!query.includes(config.queryName)) continue;
        queriedTables.push(tableName);
        // The owner-stamp wipe fires while this early user table is on the wire.
        if (tableName === purgeAfter) beginGlobalPurge();
        if (tableName === 'board_climbs') {
          return {
            syncClimbs: {
              documents: [CLIMB_DOC],
              cursor: { updatedAt: CLIMB_DOC.updated_at, syncSeq: '10' },
              hasMore: false,
            },
          };
        }
        return { [config.queryName]: { documents: [], cursor: null, hasMore: false } };
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch as unknown as GraphqlFetchMock, { enabledBoards: [SCOPE_KEY] });

    // Nothing may be pulled after the wipe — above all not the board tables, which
    // is where a removed scope's catalog would come back from.
    expect(queriedTables).toEqual([purgeAfter]);
    expect(await climbCount()).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).toBeNull();
  });

  // The resurrection window: a page already on the wire when the wipe runs would
  // otherwise land afterwards, restoring rows AND stamping a checkpoint past them.
  it('makes an in-flight pull discard the page it was fetching', async () => {
    const graphqlFetch = vi.fn(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
      }
      if (query.includes('syncClimbs')) {
        // A wipe starts while this page is in flight.
        beginGlobalPurge();
        return {
          syncClimbs: {
            documents: [CLIMB_DOC],
            cursor: { updatedAt: CLIMB_DOC.updated_at, syncSeq: '10' },
            hasMore: false,
          },
        };
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return { [config.queryName]: { documents: [], cursor: null, hasMore: false } };
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch as unknown as GraphqlFetchMock, { enabledBoards: [SCOPE_KEY] });

    expect(await climbCount()).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).toBeNull();
  });

  it('stops every scope on sign-out, not just the one mid-flight', async () => {
    const { fetch } = makeMultiScopeFetch(({ tableName, scopeKey }) => {
      if (tableName === 'board_climbs' && scopeKey === SCOPE_KEY) setSigningOut(true);
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: BOTH_SCOPES });
    setSigningOut(false);

    expect(await climbCountFor('kilter')).toBe(0);
    expect(await climbCountFor('tension')).toBe(0);
    expect(await isScopeDownloadComplete(db, TENSION_SCOPE_KEY)).toBe(false);
  });

  it('stops every scope on a global wipe, not just the one mid-flight', async () => {
    const { fetch } = makeMultiScopeFetch(({ tableName, scopeKey }) => {
      if (tableName === 'board_climbs' && scopeKey === SCOPE_KEY) beginGlobalPurge();
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: BOTH_SCOPES });

    expect(await climbCountFor('kilter')).toBe(0);
    expect(await climbCountFor('tension')).toBe(0);
    expect(await isScopeDownloadComplete(db, TENSION_SCOPE_KEY)).toBe(false);
  });
});
