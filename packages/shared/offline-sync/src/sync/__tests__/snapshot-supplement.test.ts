import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OfflineDatabase, QueryInvalidator, SqlExecutor, SqlValue } from '../../database';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations, MIGRATIONS, LATEST_SCHEMA_VERSION } from '../../db/migrations';
import { __resetDrainerStateForTests, beginScopePurge } from '../../mutation-queue/drainer';
import type { GraphQLFetch } from '../../mutation-queue/handlers';
import { pullSync, type SyncProgress } from '../pull-client';
import {
  getCheckpoint,
  getSnapshotSupplement,
  isScopeDownloadComplete,
  setCheckpoint,
  snapshotSupplementCheckpoint,
  SNAPSHOT_SUPPLEMENT_START,
  type SyncCheckpoint,
} from '../checkpoints';
import {
  bootstrapScopeFromSnapshot,
  bootstrapScopeGradesFromSnapshot,
  markBootstrapDone,
  type SnapshotSource,
} from '../snapshot-bootstrap';
import { SNAPSHOT_MANIFEST_FORMAT_VERSION } from '../snapshot-manifest';
import { triggerSync, isSyncInFlight, __resetSyncSchedulerStateForTests } from '../sync-scheduler';
import { restoreBootstrapRetryBudget } from '../bootstrap-retry';

const SCOPE_KEY = 'kilter:1:5';
const SCOPE = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
const VIEWER = 'viewer-a';
const ARTIFACT_CURSOR = { updatedAt: '2026-05-01T00:00:00.000Z', syncSeq: '500' };
const OLD_CURSOR = { updatedAt: '2024-01-01T00:00:00.000Z', syncSeq: '20' };
const NEW_CURSOR = { updatedAt: '2026-05-02T00:00:00.000Z', syncSeq: '501' };
const BUILT_AT = '2026-06-01T00:00:00.000Z';
const CLIMBS_KEY = `checkpoint:board_climbs:${SCOPE_KEY}`;
const GRADES_KEY = `checkpoint:board_climb_grades:${SCOPE_KEY}`;
const queryClient = { invalidateQueries: vi.fn() } as unknown as QueryInvalidator;

function mockGraphqlFetch(implementation: GraphQLFetch): GraphQLFetch {
  return vi.fn(implementation) as unknown as GraphQLFetch;
}

function climb(uuid: string, cursor = OLD_CURSOR) {
  return {
    uuid,
    board_type: 'kilter',
    layout_id: 1,
    name: uuid,
    is_draft: false,
    is_listed: true,
    is_hidden: false,
    compatible_size_ids: [5],
    updated_at: cursor.updatedAt,
    sync_seq: Number(cursor.syncSeq),
  };
}

function fieldName(query: string): string {
  const match = query.match(/\{\s*(sync\w+)\(/);
  if (!match) throw new Error(`Unexpected sync document: ${query}`);
  return match[1];
}

function response<T>(
  query: string,
  documents: Record<string, unknown>[] = [],
  cursor = SNAPSHOT_SUPPLEMENT_START,
  hasMore = false,
): T {
  const field = fieldName(query);
  return { [field]: { ...(field === 'syncDeletions' ? { deletions: [] } : { documents }), cursor, hasMore } } as T;
}

function afterCursor(documents: ReturnType<typeof climb>[], cursor: SyncCheckpoint | undefined) {
  return documents.filter((document) => !cursor || Date.parse(document.updated_at) > Date.parse(cursor.updatedAt));
}

function buildArtifact(filePath: string, grades = false, builtAt = BUILT_AT): void {
  const artifact = new DatabaseSync(filePath);
  try {
    for (const migration of MIGRATIONS) for (const statement of migration.statements) artifact.exec(statement);
    artifact.exec(`CREATE TABLE snapshot_meta (
      table_name TEXT PRIMARY KEY, watermark_updated_at TEXT, watermark_sync_seq TEXT,
      row_count INTEGER, built_at TEXT, schema_version INTEGER, format_version INTEGER
    )`);
    const tables = grades ? ['board_climb_grades'] : ['board_climbs', 'board_climb_stats'];
    if (grades) {
      artifact
        .prepare(`INSERT INTO board_climb_grades (board_type, climb_uuid, angle, computed_at, sync_seq)
        VALUES ('kilter', 'manufacturer', 40, ?, 500)`)
        .run(ARTIFACT_CURSOR.updatedAt);
    } else {
      artifact
        .prepare(`INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_draft, is_listed, is_hidden, compatible_size_ids, updated_at, sync_seq)
        VALUES ('manufacturer', 'kilter', 1, 'manufacturer', 0, 1, 0, '[5]', ?, 500)`)
        .run(ARTIFACT_CURSOR.updatedAt);
      artifact
        .prepare(`INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, updated_at, sync_seq) VALUES ('kilter', 'manufacturer', 40, ?, 500)`)
        .run(ARTIFACT_CURSOR.updatedAt);
    }
    for (const table of tables) {
      artifact
        .prepare('INSERT INTO snapshot_meta VALUES (?, ?, ?, 1, ?, ?, ?)')
        .run(
          table,
          ARTIFACT_CURSOR.updatedAt,
          ARTIFACT_CURSOR.syncSeq,
          builtAt,
          LATEST_SCHEMA_VERSION,
          SNAPSHOT_MANIFEST_FORMAT_VERSION,
        );
    }
  } finally {
    artifact.close();
  }
}

function sourceWithArtifact(filePath: string, beforeDownload?: () => Promise<void>): SnapshotSource {
  const tableStats = {
    watermarkUpdatedAt: ARTIFACT_CURSOR.updatedAt,
    watermarkSyncSeq: ARTIFACT_CURSOR.syncSeq,
    rowCount: 1,
  };
  return {
    fetchManifest: async () => ({
      formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
      generatedAt: BUILT_AT,
      entries: [
        {
          boardType: 'kilter',
          layoutId: 1,
          key: 'retry-layout',
          url: 'https://example.test/retry-layout.db',
          bytes: 1024,
          contentEncoding: 'identity',
          builtAt: BUILT_AT,
          schemaVersion: LATEST_SCHEMA_VERSION,
          privacyVersion: 1,
          tables: { board_climbs: tableStats, board_climb_stats: tableStats },
        },
      ],
    }),
    downloadArtifact: async () => {
      await beforeDownload?.();
      return { filePath };
    },
    deleteArtifact: async () => {},
  };
}

describe('one-time snapshot supplementation', () => {
  let db: TestSqliteDb;
  let scratchDirectory: string;

  beforeEach(async () => {
    __resetDrainerStateForTests();
    __resetSyncSchedulerStateForTests();
    scratchDirectory = mkdtempSync(join(tmpdir(), 'snapshot-supplement-'));
    db = createTestDatabase(join(scratchDirectory, 'client.db'));
    await runMigrations(db);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(scratchDirectory, { recursive: true, force: true });
    __resetDrainerStateForTests();
    __resetSyncSchedulerStateForTests();
  });

  async function importLayout() {
    const artifactPath = join(scratchDirectory, 'layout.db');
    buildArtifact(artifactPath);
    return bootstrapScopeFromSnapshot({
      db,
      scope: SCOPE,
      scopeKey: SCOPE_KEY,
      filePath: artifactPath,
      replayFromEpoch: true,
      snapshotSupplementViewerId: VIEWER,
    });
  }

  it.each([true, false])('yields an active legacy page (hasMore=%s) to the queued faster retry', async (hasMore) => {
    await setCheckpoint(db, CLIMBS_KEY, OLD_CURSOR);
    await markBootstrapDone(db, SCOPE_KEY);
    const pageCursor = { updatedAt: '2024-01-02T00:00:00.000Z', syncSeq: '21' };
    const committedAuthored = { ...climb('committed-authored', pageCursor), user_id: VIEWER };
    const artifactPath = join(scratchDirectory, 'retry-layout.db');
    buildArtifact(artifactPath);
    let snapshotDownloads = 0;
    const snapshotSource = sourceWithArtifact(artifactPath, async () => {
      snapshotDownloads += 1;
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(pageCursor);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
      expect(
        await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['committed-authored']),
      ).not.toBeNull();
    });
    let firstPageStarted!: () => void;
    let releaseFirstPage!: () => void;
    const firstPage = new Promise<void>((resolve) => {
      firstPageStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    const legacyCursors: unknown[] = [];
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) !== 'syncClimbs') return response<T>(query);
      if (variables?.audience) return response<T>(query, [committedAuthored], pageCursor);
      const cursor = variables?.cursor as SyncCheckpoint | undefined;
      if (cursor?.updatedAt !== ARTIFACT_CURSOR.updatedAt) {
        legacyCursors.push(cursor);
        if (legacyCursors.length === 1) {
          firstPageStarted();
          await release;
          return response<T>(query, [committedAuthored], pageCursor, hasMore);
        }
      }
      return response<T>(query);
    });
    const options = { viewerUserId: VIEWER, snapshotSource };
    triggerSync(
      db,
      queryClient,
      fetch,
      () => [SCOPE_KEY],
      async () => {},
      options,
    );
    await firstPage;
    await restoreBootstrapRetryBudget(db, SCOPE_KEY);
    triggerSync(
      db,
      queryClient,
      fetch,
      () => [SCOPE_KEY],
      async () => {},
      options,
    );
    releaseFirstPage();
    await vi.waitFor(() => expect(isSyncInFlight()).toBe(false));
    expect(legacyCursors).toEqual([OLD_CURSOR]);
    expect(snapshotDownloads).toBe(1);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(ARTIFACT_CURSOR);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(
      await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['committed-authored']),
    ).not.toBeNull();
  });

  it('keeps ordinary paging when the already-requested faster retry has no available artifact', async () => {
    await setCheckpoint(db, CLIMBS_KEY, OLD_CURSOR);
    await markBootstrapDone(db, SCOPE_KEY);
    await restoreBootstrapRetryBudget(db, SCOPE_KEY);
    const pageCursor = { updatedAt: '2024-01-02T00:00:00.000Z', syncSeq: '21' };
    const requestedCursors: unknown[] = [];
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) !== 'syncClimbs') return response<T>(query);
      requestedCursors.push(variables?.cursor);
      return requestedCursors.length === 1
        ? response<T>(query, [climb('ordinary-fallback', pageCursor)], pageCursor, true)
        : response<T>(query);
    });
    const snapshotSource: SnapshotSource = {
      fetchManifest: async () => null,
      downloadArtifact: async () => {
        throw new Error('No artifact should download');
      },
      deleteArtifact: async () => {},
    };
    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER, snapshotSource });
    expect(requestedCursors).toEqual([OLD_CURSOR, pageCursor]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(pageCursor);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('uses the fast supplement through the real scheduler and fresh artifact import path', async () => {
    const artifactPath = join(scratchDirectory, 'scheduled-layout.db');
    buildArtifact(artifactPath);
    const tableStats = {
      watermarkUpdatedAt: ARTIFACT_CURSOR.updatedAt,
      watermarkSyncSeq: ARTIFACT_CURSOR.syncSeq,
      rowCount: 1,
    };
    const snapshotSource: SnapshotSource = {
      fetchManifest: async () => ({
        formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
        generatedAt: BUILT_AT,
        entries: [
          {
            boardType: 'kilter',
            layoutId: 1,
            key: 'scheduled-layout',
            url: 'https://example.test/scheduled-layout.db',
            bytes: 1024,
            contentEncoding: 'identity',
            builtAt: BUILT_AT,
            schemaVersion: LATEST_SCHEMA_VERSION,
            privacyVersion: 1,
            tables: { board_climbs: tableStats, board_climb_stats: tableStats },
          },
        ],
      }),
      downloadArtifact: async () => ({ filePath: artifactPath }),
      deleteArtifact: async () => {},
    };
    const requests: Record<string, unknown>[] = [];
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs') {
        requests.push(variables ?? {});
        if (variables?.audience) {
          expect((await getCheckpoint(db, CLIMBS_KEY))?.snapshotSupplement?.viewerUserId).toBe(VIEWER);
          return response<T>(query, [climb('scheduled-authored')], OLD_CURSOR);
        }
      }
      return response<T>(query);
    });
    const getViewerUserId = vi.fn(async () => VIEWER);
    triggerSync(
      db,
      queryClient,
      fetch,
      () => [SCOPE_KEY],
      async () => {},
      {
        viewerUserId: 'stale-viewer',
        getViewerUserId,
        snapshotSource,
      },
    );
    await vi.waitFor(() => expect(isSyncInFlight()).toBe(false));
    expect(getViewerUserId).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => ({ audience: request.audience, cursor: request.cursor }))).toEqual([
      { audience: 'SNAPSHOT_SUPPLEMENTAL', cursor: SNAPSHOT_SUPPLEMENT_START },
      { audience: undefined, cursor: ARTIFACT_CURSOR },
    ]);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(
      await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['scheduled-authored']),
    ).not.toBeNull();
  });

  function failCheckpointWrite(shouldFail: (checkpoint: SyncCheckpoint) => boolean) {
    const database: OfflineDatabase = db;
    const transact = database.withExclusiveTransactionAsync.bind(database);
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      transact(async (transaction) => {
        const runAsync: SqlExecutor['runAsync'] = async (source: string, ...parameters: (SqlValue | SqlValue[])[]) => {
          const bindings =
            parameters.length === 1 && Array.isArray(parameters[0]) ? parameters[0] : (parameters as SqlValue[]);
          if (
            source.includes('INSERT OR REPLACE INTO sync_meta') &&
            bindings[0] === CLIMBS_KEY &&
            typeof bindings[1] === 'string' &&
            shouldFail(JSON.parse(bindings[1]) as SyncCheckpoint)
          )
            throw new Error('checkpoint commit failed');
          return transaction.runAsync(source, bindings);
        };
        await task({
          execAsync: transaction.execAsync.bind(transaction),
          runAsync,
          getFirstAsync: transaction.getFirstAsync.bind(transaction),
          getAllAsync: transaction.getAllAsync.bind(transaction),
        });
      }),
    );
  }

  it('does not publish imported coverage when the final import checkpoint transaction fails', async () => {
    failCheckpointWrite((checkpoint) => !!checkpoint.snapshotSupplement);
    await expect(importLayout()).rejects.toThrow('checkpoint commit failed');
    expect(await getCheckpoint(db, CLIMBS_KEY)).toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
  });

  it('rolls back a terminal supplemental row when its watermark promotion cannot commit', async () => {
    const pending = snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER);
    await setCheckpoint(db, CLIMBS_KEY, pending);
    failCheckpointWrite(
      (checkpoint) => checkpoint.updatedAt === ARTIFACT_CURSOR.updatedAt && !checkpoint.snapshotSupplement,
    );
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs' && variables?.audience)
        return response<T>(query, [climb('uncommitted-authored')], OLD_CURSOR);
      return response<T>(query);
    });
    await expect(
      pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER }),
    ).rejects.toThrow('checkpoint commit failed');
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(pending);
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['uncommitted-authored'])).toBeNull();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
  });

  it.each([
    ['artifactWatermark', { ...ARTIFACT_CURSOR, syncSeq: '999999999999999999999999' }],
    ['climbWatermark', { ...ARTIFACT_CURSOR, syncSeq: '9223372036854775808' }],
    ['cursor', { ...OLD_CURSOR, updatedAt: '2024-01-01T00:00:00+05:30' }],
  ] as const)(
    'falls back from corrupt %s metadata without promoting its artifact watermark',
    async (cursorField, corruptCursor) => {
      const pending = snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER);
      pending.snapshotSupplement![cursorField] = corruptCursor;
      await setCheckpoint(db, CLIMBS_KEY, pending);
      const requests: Record<string, unknown>[] = [];
      const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (fieldName(query) === 'syncClimbs') requests.push(variables ?? {});
        return response<T>(query);
      });
      await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ cursor: SNAPSHOT_SUPPLEMENT_START });
      expect(requests[0].audience).toBeUndefined();
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(SNAPSHOT_SUPPLEMENT_START);
    },
  );

  it('imports manufacturer rows once, supplements older authored rows, then pulls ordinary deltas', async () => {
    await importLayout();
    const importedCheckpoint = await getCheckpoint(db, CLIMBS_KEY);
    expect(importedCheckpoint).toEqual(snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER));
    const requests: Array<{ audience: unknown; cursor: unknown; watermark: unknown }> = [];
    const authored = climb('authored-before-snapshot');
    const recent = climb('changed-after-snapshot', NEW_CURSOR);
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) !== 'syncClimbs') return response<T>(query);
      requests.push({
        audience: variables?.audience,
        cursor: variables?.cursor,
        watermark: variables?.snapshotClimbWatermark,
      });
      const documents =
        variables?.audience === 'SNAPSHOT_SUPPLEMENTAL'
          ? [authored]
          : afterCursor(
              [climb('manufacturer', ARTIFACT_CURSOR), authored, recent],
              variables?.cursor as SyncCheckpoint | undefined,
            );
      return response<T>(query, documents, variables?.audience ? OLD_CURSOR : NEW_CURSOR);
    });

    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER });

    expect(requests).toEqual([
      { audience: 'SNAPSHOT_SUPPLEMENTAL', cursor: SNAPSHOT_SUPPLEMENT_START, watermark: ARTIFACT_CURSOR },
      { audience: undefined, cursor: ARTIFACT_CURSOR, watermark: undefined },
    ]);
    expect(await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'authored-before-snapshot' },
      { uuid: 'changed-after-snapshot' },
      { uuid: 'manufacturer' },
    ]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(NEW_CURSOR);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('resumes an interrupted supplemental page without publishing artifact coverage early', async () => {
    await setCheckpoint(db, CLIMBS_KEY, snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER));
    let supplementalPages = 0;
    const failedProgress: SyncProgress[] = [];
    const interruptedFetch = mockGraphqlFetch(
      async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (fieldName(query) !== 'syncClimbs') return response<T>(query);
        if (variables?.audience === 'SNAPSHOT_SUPPLEMENTAL' && supplementalPages++ === 0)
          return response<T>(query, [climb('first-authored')], OLD_CURSOR, true);
        throw new Error('link interrupted');
      },
    );
    await expect(
      pullSync(db, queryClient, interruptedFetch, {
        enabledBoards: [SCOPE_KEY],
        viewerUserId: VIEWER,
        onProgress: (progress) => failedProgress.push(progress),
      }),
    ).rejects.toThrow('link interrupted');
    const partial = await getCheckpoint(db, CLIMBS_KEY);
    expect(partial).toMatchObject({ ...SNAPSHOT_SUPPLEMENT_START, snapshotSupplement: { cursor: OLD_CURSOR } });
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
    expect(failedProgress.some((progress) => progress.download?.fraction === 1)).toBe(false);

    const resumedRequests: unknown[] = [];
    const resumedFetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs') resumedRequests.push(variables?.cursor);
      return response<T>(query);
    });
    await pullSync(db, queryClient, resumedFetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER });
    expect(resumedRequests).toEqual([OLD_CURSOR, ARTIFACT_CURSOR]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(ARTIFACT_CURSOR);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
  });

  it('falls back to the unchanged legacy cursor when the backend rejects supplemental arguments', async () => {
    await setCheckpoint(db, CLIMBS_KEY, snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER));
    const requests: Record<string, unknown>[] = [];
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) !== 'syncClimbs') return response<T>(query);
      requests.push(variables ?? {});
      if (variables?.audience)
        throw { response: { errors: [{ message: 'Unknown argument "audience" on field "Query.syncClimbs".' }] } };
      return response<T>(query, [climb('manufacturer', ARTIFACT_CURSOR), climb('own-old-draft')], ARTIFACT_CURSOR);
    });
    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER });
    expect(requests.map((request) => request.cursor)).toEqual([SNAPSHOT_SUPPLEMENT_START, SNAPSHOT_SUPPLEMENT_START]);
    expect(requests[1].audience).toBeUndefined();
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(ARTIFACT_CURSOR);
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['own-old-draft'])).not.toBeNull();
  });

  it.each(['viewer-b', undefined])('does not reuse a supplemental cursor for viewer %s', async (viewerUserId) => {
    const checkpoint = snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER);
    checkpoint.snapshotSupplement!.cursor = OLD_CURSOR;
    await setCheckpoint(db, CLIMBS_KEY, checkpoint);
    const requests: Record<string, unknown>[] = [];
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs') requests.push(variables ?? {});
      return response<T>(query);
    });
    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ cursor: SNAPSHOT_SUPPLEMENT_START });
    expect(requests[0].audience).toBeUndefined();
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(SNAPSHOT_SUPPLEMENT_START);
  });

  it('retains a legacy partial download cursor instead of guessing snapshot coverage', async () => {
    await setCheckpoint(db, CLIMBS_KEY, OLD_CURSOR);
    const cursors: unknown[] = [];
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs') {
        cursors.push(variables?.cursor);
        expect(variables?.audience).toBeUndefined();
      }
      return response<T>(query);
    });
    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER });
    expect(cursors).toEqual([OLD_CURSOR]);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(OLD_CURSOR);
  });

  it('lets an older writer replace coverage metadata without leaving a supplemental cursor behind', async () => {
    await setCheckpoint(db, CLIMBS_KEY, snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER));
    await setCheckpoint(db, CLIMBS_KEY, OLD_CURSOR);
    expect(getSnapshotSupplement(await getCheckpoint(db, CLIMBS_KEY), VIEWER)).toBeNull();
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(OLD_CURSOR);
  });

  it('discards a terminal supplemental response after its board is removed', async () => {
    await setCheckpoint(db, CLIMBS_KEY, snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER));
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs' && variables?.audience) beginScopePurge('kilter:1');
      return response<T>(query);
    });
    await pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], viewerUserId: VIEWER });
    expect(await getCheckpoint(db, CLIMBS_KEY)).toMatchObject({
      ...SNAPSHOT_SUPPLEMENT_START,
      snapshotSupplement: { version: 1 },
    });
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
  });

  it.each([BUILT_AT, '2026-05-31T00:00:00.000Z'])(
    'optimizes grades only for a verified matching layout export (%s)',
    async (builtAt) => {
      const layout = await importLayout();
      const gradesPath = join(scratchDirectory, 'grades.db');
      buildArtifact(gradesPath, true, builtAt);
      await bootstrapScopeGradesFromSnapshot({
        db,
        scope: SCOPE,
        scopeKey: SCOPE_KEY,
        filePath: gradesPath,
        replayFromEpoch: true,
        snapshotSupplement: {
          viewerUserId: VIEWER,
          climbWatermark: layout.climbsWatermark,
          artifactBuiltAt: layout.artifactBuiltAt!,
        },
      });
      const checkpoint = await getCheckpoint(db, GRADES_KEY);
      expect(checkpoint).toEqual(
        builtAt === BUILT_AT
          ? snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER)
          : SNAPSHOT_SUPPLEMENT_START,
      );
    },
  );

  it('keeps paging progress indeterminate and reports growing row counts', async () => {
    await setCheckpoint(db, CLIMBS_KEY, snapshotSupplementCheckpoint(ARTIFACT_CURSOR, ARTIFACT_CURSOR, VIEWER));
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
    const progressFrames: SyncProgress[] = [];
    let clockMs = 0;
    const fetch = mockGraphqlFetch(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (fieldName(query) === 'syncClimbs' && variables?.audience)
        return response<T>(query, [climb('authored')], OLD_CURSOR);
      return response<T>(query);
    });
    await pullSync(db, queryClient, fetch, {
      enabledBoards: [SCOPE_KEY],
      viewerUserId: VIEWER,
      onProgress: (progress) => progressFrames.push(progress),
      now: () => (clockMs += 500),
    });
    const paging = progressFrames.filter(
      (progress) => progress.download?.phase === 'finishing' && progress.download.fraction !== 1,
    );
    expect(paging.length).toBeGreaterThan(0);
    expect(paging.every((progress) => progress.download?.fraction === null)).toBe(true);
    expect(paging.some((progress) => (progress.download?.rowsProcessed ?? 0) > 0)).toBe(true);
    expect(progressFrames.filter((progress) => progress.download).at(-1)?.download?.fraction).toBe(1);
  });
});
