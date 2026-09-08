import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { pullSync } from '../pull-client';
import { TABLE_CONFIGS } from '../table-config';
import {
  compareCheckpoints,
  getCheckpoint,
  setCheckpoint,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
} from '../checkpoints';
import {
  getSchemaRefreshState,
  schemaRefreshKey,
  writeSchemaRefreshState,
  REFRESH_START_CURSOR,
} from '../schema-refresh';
import {
  __resetDrainerStateForTests,
  beginScopePurge,
  setBackgrounded,
  setSigningOut,
} from '../../mutation-queue/drainer';
import { removeBoardScopeData } from '../scope-teardown';
import type { SyncCheckpoint } from '../checkpoints';
import type { GraphQLFetch } from '../../mutation-queue/handlers';

const SCOPE = 'tension:10:8';
const HEAD = { updatedAt: '2026-09-07T22:00:00.000Z', syncSeq: '200' };
const OLD = { updatedAt: '2026-09-06T00:00:00.000Z', syncSeq: '10' };
let directory: string;
let db: TestSqliteDb;
let unmetered: boolean;
const queryClient = { invalidateQueries: vi.fn() };

function climb(uuid: string, sequence = 10) {
  return {
    uuid,
    board_type: 'tension',
    layout_id: 10,
    compatible_size_ids: [8],
    name: uuid,
    is_hidden: true,
    is_draft: false,
    is_listed: true,
    updated_at: OLD.updatedAt,
    sync_seq: sequence,
  };
}

function source(documents = [climb('hidden')], onPage?: (cursor: SyncCheckpoint | undefined) => void) {
  const fetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    if (query.includes('syncDeletions')) return { syncDeletions: { deletions: [], cursor: HEAD, hasMore: false } } as T;
    if (query.includes('syncClimbs(')) {
      const cursor = variables?.cursor as SyncCheckpoint | undefined;
      onPage?.(cursor);
      const remaining = documents.filter(
        (document) =>
          !cursor ||
          compareCheckpoints({ updatedAt: document.updated_at, syncSeq: String(document.sync_seq) }, cursor) > 0,
      );
      const page = remaining.slice(0, 1);
      const last = page[0];
      return {
        syncClimbs: {
          documents: page,
          hasMore: remaining.length > 1,
          cursor: last
            ? { updatedAt: last.updated_at, syncSeq: String(last.sync_seq) }
            : (cursor ?? REFRESH_START_CURSOR),
        },
      } as T;
    }
    const config = Object.values(TABLE_CONFIGS).find((entry) => query.includes(`${entry.queryName}(`));
    if (!config) throw new Error('Unexpected query');
    return { [config.queryName]: { documents: [], cursor: HEAD, hasMore: false } } as T;
  });
  return fetch as typeof fetch & GraphQLFetch;
}

async function sync(fetch: GraphQLFetch = source()) {
  await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE], isOnUnmeteredNetwork: () => unmetered });
}

async function seedLegacy() {
  await db.runAsync(
    `INSERT INTO board_climbs
    (uuid, board_type, layout_id, compatible_size_ids, is_hidden, updated_at, sync_seq)
    VALUES ('hidden', 'tension', 10, '[8]', NULL, ?, 10)`,
    [OLD.updatedAt],
  );
  await setCheckpoint(db, `checkpoint:board_climbs:${SCOPE}`, HEAD);
  await markScopeDownloadComplete(db, SCOPE);
}

async function hiddenFlag() {
  return (
    await db.getFirstAsync<{ is_hidden: number | null }>("SELECT is_hidden FROM board_climbs WHERE uuid = 'hidden'")
  )?.is_hidden;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'schema-refresh-'));
  db = createTestDatabase(join(directory, 'main.db'));
  await runMigrations(db);
  __resetDrainerStateForTests();
  unmetered = true;
  queryClient.invalidateQueries.mockClear();
});

afterEach(() => {
  __resetDrainerStateForTests();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('reference schema refresh', () => {
  it('accepts increasing microseconds even when the sequence decreases', async () => {
    const first = { ...climb('hidden', 200), updated_at: '2026-09-06T00:00:00.000100Z' };
    const second = { ...climb('second', 10), updated_at: '2026-09-06T00:00:00.000900Z' };
    await sync(source([first, second]));
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE}`)).toEqual({
      updatedAt: second.updated_at,
      syncSeq: '10',
    });
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true });
  });

  it.each([
    ['2026-09-06T00:00:00.5Z', '2026-09-06T00:00:00Z', 0],
    ['2026-09-06T00:00:00Z', '2026-09-06T00:00:00.5Z', 1],
    ['2026-09-06T00:00:00.500000Z', '2026-09-06T00:00:00.5Z', 1],
    ['2026-09-06T00:00:00.000900Z', '2026-09-06T00:00:00.000100Z', 0],
  ])('orders refresh timestamps %s versus %s precisely', async (localTimestamp, sourceTimestamp, expectedFlag) => {
    await seedLegacy();
    await db.runAsync("UPDATE board_climbs SET is_hidden = 0, updated_at = ? WHERE uuid = 'hidden'", [localTimestamp]);
    await sync(source([{ ...climb('hidden'), updated_at: sourceTimestamp }]));
    expect(await hiddenFlag()).toBe(expectedFlag);
  });

  it.each([false, true])('refuses missing refresh fields, including mixed pages (%s)', async (mixed) => {
    await seedLegacy();
    const normal = source();
    const malformed = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('syncClimbs(') && (variables?.cursor as SyncCheckpoint)?.syncSeq === '0') {
        const incomplete: Record<string, unknown> = { ...climb('hidden') };
        delete incomplete.is_hidden;
        return {
          syncClimbs: {
            documents: mixed ? [climb('second', 11), incomplete] : [incomplete],
            hasMore: false,
            cursor: { ...OLD, syncSeq: mixed ? '11' : '10' },
          },
        } as T;
      }
      return normal(query, variables) as Promise<T>;
    };
    await expect(sync(malformed)).rejects.toThrow('missing columns: is_hidden');
    expect(await hiddenFlag()).toBeNull();
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE}`)).toEqual(HEAD);
    await sync();
    expect(await hiddenFlag()).toBe(1);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true });
  });

  it('does not stamp full-download coverage after a page omits a refresh field', async () => {
    unmetered = false;
    const normal = source([climb('hidden'), climb('second', 11)]);
    const incomplete = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      const result = await normal<Record<string, { documents: Record<string, unknown>[] }>>(query, variables);
      for (const document of result.syncClimbs?.documents ?? []) {
        if (document.uuid === 'second') delete document.is_hidden;
      }
      return result as T;
    };
    await sync(incomplete);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE)).toBe(true);
    unmetered = true;
    await sync(source([climb('hidden'), climb('second', 11)]));
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true });
  });

  it('invalidates committed pages when a later fetch fails, even with an empty-tail retry', async () => {
    await seedLegacy();
    const normal = source([climb('hidden'), climb('second', 11)]);
    const fails = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('syncClimbs(') && (variables?.cursor as SyncCheckpoint)?.syncSeq === '10') {
        throw new Error('second page unavailable');
      }
      return normal(query, variables) as Promise<T>;
    };
    await expect(sync(fails)).rejects.toThrow('second page unavailable');
    expect(await hiddenFlag()).toBe(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: false, syncSeq: '10' });
    await sync(source());
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true });
  });

  it('reopens completed coverage when a later ordinary delta omits the field', async () => {
    await seedLegacy();
    await sync();
    const newer = { ...climb('hidden', 201), updated_at: '2026-09-08T00:00:00Z' };
    const normal = source([{ ...newer }]);
    const incomplete = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      const result = await normal<Record<string, { documents: Record<string, unknown>[] }>>(query, variables);
      for (const document of result.syncClimbs?.documents ?? []) delete document.is_hidden;
      return result as T;
    };
    unmetered = false;
    await sync(incomplete);
    expect(await hiddenFlag()).toBeNull();
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    unmetered = true;
    await sync(source([newer]));
    expect(await hiddenFlag()).toBe(1);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true });
  });

  it('fills skipped flags behind an existing checkpoint exactly once, without regressing ordinary sync', async () => {
    await seedLegacy();
    const fetch = source();
    await sync(fetch);
    expect(await hiddenFlag()).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE}`)).toEqual(HEAD);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ revision: 1, complete: true });
    expect(await isScopeDownloadComplete(db, SCOPE)).toBe(true);
    await sync(fetch);
    const climbCalls = fetch.mock.calls.filter(([query]) => query.includes('syncClimbs('));
    expect(climbCalls).toHaveLength(3); // delta + refresh, then delta only
  });

  it('keeps ordinary deltas and cached climbs usable on metered connections', async () => {
    await seedLegacy();
    unmetered = false;
    const fetch = source();
    await sync(fetch);
    expect(fetch.mock.calls.filter(([query]) => query.includes('syncClimbs('))).toHaveLength(1);
    expect(await hiddenFlag()).toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE)).toBe(true);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    unmetered = true;
    await sync();
    expect(await hiddenFlag()).toBe(1);
  });

  it('resumes a committed refresh page after restart and network deferral', async () => {
    await seedLegacy();
    const documents = [climb('hidden'), climb('second', 11)];
    await sync(
      source(documents, (cursor) => {
        if (cursor?.syncSeq === '0') unmetered = false;
      }),
    );
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: false, syncSeq: '10' });
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
    db.close();
    db = createTestDatabase(join(directory, 'main.db'));
    await sync(source(documents));
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: false, syncSeq: '10' });
    unmetered = true;
    const fetch = source(documents);
    await sync(fetch);
    const cursors = fetch.mock.calls
      .filter(([query]) => query.includes('syncClimbs('))
      .map(([, variables]) => variables?.cursor);
    expect(cursors).toEqual([HEAD, expect.objectContaining(OLD)]);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true, syncSeq: '11' });
  });

  it('does not replay a fresh full paged download', async () => {
    const fetch = source();
    await sync(fetch);
    expect(fetch.mock.calls.filter(([query]) => query.includes('syncClimbs('))).toHaveLength(1);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true, mode: 'download' });
  });

  it('finishes an interrupted fresh download without replaying its prefix', async () => {
    const documents = [climb('hidden'), climb('second', 11)];
    const original = db.withExclusiveTransactionAsync.bind(db);
    let interrupt = true;
    vi.spyOn(db, 'withExclusiveTransactionAsync').mockImplementation(async (task) => {
      await original(task);
      if (interrupt && (await getSchemaRefreshState(db, 'board_climbs', SCOPE))?.syncSeq === '10') {
        interrupt = false;
        setBackgrounded(true);
      }
    });
    await sync(source(documents));
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ mode: 'download', complete: false });
    setBackgrounded(false);
    const fetch = source(documents);
    await sync(fetch);
    expect(fetch.mock.calls.filter(([query]) => query.includes('syncClimbs('))).toHaveLength(1);
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toMatchObject({ complete: true });
  });

  it.each(['background', 'signout', 'purge'] as const)(
    'discards a refresh page interrupted by %s',
    async (interruption) => {
      await seedLegacy();
      let release: (() => void) | undefined;
      await sync(
        source(undefined, (cursor) => {
          if (cursor?.syncSeq !== '0') return;
          if (interruption === 'background') setBackgrounded(true);
          if (interruption === 'signout') setSigningOut(true);
          if (interruption === 'purge') release = beginScopePurge('tension:10');
        }),
      );
      release?.();
      expect(await hiddenFlag()).toBeNull();
      expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    },
  );

  it('preserves a newer local row when the refresh sees an older server page', async () => {
    await seedLegacy();
    await db.runAsync("UPDATE board_climbs SET is_hidden = 0, updated_at = ?, sync_seq = 200 WHERE uuid = 'hidden'", [
      HEAD.updatedAt,
    ]);
    await sync();
    expect(await hiddenFlag()).toBe(0);
  });

  it('removes refresh state with a scope and leaves sibling state alone', async () => {
    await seedLegacy();
    await sync();
    await writeSchemaRefreshState(db, 'board_climbs', 'tension:11:8', {
      ...OLD,
      revision: 1,
      complete: false,
      mode: 'refresh',
    });
    await removeBoardScopeData({
      db,
      scope: { boardType: 'tension', layoutId: 10, sizeId: 8 },
      scopeKey: SCOPE,
      retainedScopes: [],
    });
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    expect(await getSchemaRefreshState(db, 'board_climbs', 'tension:11:8')).not.toBeNull();
  });

  it.each(['empty', 'stalled', 'invalid'] as const)('never completes or advances a malformed %s page', async (kind) => {
    await seedLegacy();
    const normal = source();
    const fetch = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('syncClimbs(') && (variables?.cursor as SyncCheckpoint)?.syncSeq === '0') {
        return {
          syncClimbs: {
            documents: kind === 'empty' ? [] : [climb('hidden')],
            hasMore: true,
            cursor: kind === 'invalid' ? { updatedAt: 'bad', syncSeq: 'bad' } : REFRESH_START_CURSOR,
          },
        } as T;
      }
      return normal(query, variables) as Promise<T>;
    };
    await expect(sync(fetch)).rejects.toThrow(/Sync returned/);
    expect(await hiddenFlag()).toBeNull();
    expect(await getSchemaRefreshState(db, 'board_climbs', SCOPE)).toBeNull();
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE}`)).toEqual(HEAD);
  });

  it('recovers a corrupt persisted refresh marker', async () => {
    await seedLegacy();
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
      schemaRefreshKey('board_climbs', SCOPE),
      '{bad',
    ]);
    await sync();
    expect(await hiddenFlag()).toBe(1);
  });
});
