// The field sequence behind issue #4406, replayed against the REAL client DDL.
//
// Marco's phone, 2026-08-14 12:32-12:33Z, scope tension:11:8:
//
//   12:32:59  Offline Board Download Started (snapshot, artifact sized)
//   12:33:09  both artifacts transferred, imported, bootstrap-done stamped
//   12:33:1x  the delta crawl is visibly paging
//   12:33:39  the board is removed — beginScopePurge lands MID-CRAWL
//             → no terminal event, ever: the board-data loop's purge exits are
//               silent `continue`s and the funnel guard only covers the
//               bootstrap phase
//   12:33:41  the board is switched back ON, two seconds later
//             → the next cycle runs INSIDE the removal's purge window, skips the
//               scope for the whole cycle, and nothing re-schedules it: the board
//               sits on "waiting to download" with no download attempt at all
//
// Both halves are asserted here: exactly one classified terminal event per
// Started, and a fresh Started + bootstrap once the purge window closes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryInvalidator } from '../../database';
import { pullSync, type ScopeDownloadStartInfo } from '../pull-client';
import { removeBoardScopeData } from '../scope-teardown';
import {
  isScopeDownloadStarted,
  isScopeDownloadComplete,
  markScopeDownloadComplete,
  getCheckpoint,
  getCheckpointKey,
} from '../checkpoints';
import { isBootstrapDone, type SnapshotSource, type SnapshotBootstrapErrorReport } from '../snapshot-bootstrap';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { beginScopePurge, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { __resetDownloadTerminalRegistryForTests } from '../download-terminal-registry';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { SCHEMA_STATEMENTS } from '../../db/schema';
import type { OfflineBoardScope } from '../../offline-board-key';
import type { SnapshotManifest, SnapshotManifestEntry } from '../snapshot-manifest';

const SCOPE: OfflineBoardScope = { boardType: 'tension', layoutId: 11, sizeId: 8 };
const SCOPE_KEY = 'tension:11:8';
const NAMESPACE = 'tension:11';

const SNAPSHOT_META_DDL = `
CREATE TABLE IF NOT EXISTS snapshot_meta (
  table_name TEXT PRIMARY KEY,
  watermark_updated_at TEXT,
  watermark_sync_seq TEXT,
  row_count INTEGER,
  built_at TEXT,
  schema_version INTEGER,
  format_version INTEGER
);`;

const WATERMARK = { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' };

/** A one-climb, one-stat artifact for the tension:11 layout. */
function buildArtifact(filePath: string): void {
  const artifact = new DatabaseSync(filePath);
  try {
    for (const statement of SCHEMA_STATEMENTS) artifact.exec(statement);
    artifact.exec(SNAPSHOT_META_DDL);
    artifact
      .prepare(
        `INSERT OR REPLACE INTO board_climbs
          (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
         VALUES (?, 'tension', 11, 'Artifact climb', 0, 1, ?, ?, ?)`,
      )
      .run('artifact-climb', JSON.stringify([8]), WATERMARK.updatedAt, Number(WATERMARK.syncSeq));
    artifact
      .prepare(
        `INSERT OR REPLACE INTO board_climb_stats
          (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
         VALUES ('tension', ?, 40, 20.0, ?, ?)`,
      )
      .run('artifact-climb', WATERMARK.updatedAt, Number(WATERMARK.syncSeq));
    const meta = artifact.prepare(
      `INSERT OR REPLACE INTO snapshot_meta
        (table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version)
       VALUES (?, ?, ?, 1, '2026-06-01T00:00:00.000Z', ?, 1)`,
    );
    meta.run('board_climbs', WATERMARK.updatedAt, WATERMARK.syncSeq, LATEST_SCHEMA_VERSION);
    meta.run('board_climb_stats', WATERMARK.updatedAt, WATERMARK.syncSeq, LATEST_SCHEMA_VERSION);
  } finally {
    artifact.close();
  }
}

function makeEntry(): SnapshotManifestEntry {
  return {
    boardType: 'tension',
    layoutId: 11,
    key: 'board-snapshots/v1/tension/11/2026-06-01.db',
    url: 'https://example.test/tension-11.db',
    bytes: 4096,
    contentEncoding: 'gzip',
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: LATEST_SCHEMA_VERSION,
    tables: {
      board_climbs: { watermarkUpdatedAt: WATERMARK.updatedAt, watermarkSyncSeq: WATERMARK.syncSeq, rowCount: 1 },
      board_climb_stats: { watermarkUpdatedAt: WATERMARK.updatedAt, watermarkSyncSeq: WATERMARK.syncSeq, rowCount: 1 },
    },
  };
}

function makeManifest(): SnapshotManifest {
  return { formatVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', entries: [makeEntry()] };
}

/** The injected snapshot I/O, with a hook that runs while the transfer is "on the wire". */
function makeSnapshotSource(config: { filePath: string; onDownload?: () => void }): SnapshotSource {
  return {
    fetchManifest: vi.fn(async () => makeManifest()),
    downloadArtifact: vi.fn(async () => {
      config.onDownload?.();
      return { filePath: config.filePath };
    }),
    deleteArtifact: vi.fn(async () => {}),
  } as unknown as SnapshotSource;
}

type GraphqlFetchMock = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const EMPTY_CURSOR = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

/**
 * Empty pages for everything, with a hook fired the first time the named board
 * query is asked for — the moment the delta crawl is "visibly paging".
 */
function makeFetch(options?: { onQuery?: (queryName: string) => void }): GraphqlFetchMock {
  const fetchMock = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    const match = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
    const queryName = match ? match[1] : 'unknown';
    options?.onQuery?.(queryName);
    if (queryName === 'syncDeletions') {
      return { syncDeletions: { deletions: [], cursor: EMPTY_CURSOR, hasMore: false } };
    }
    return { [queryName]: { documents: [], cursor: variables?.cursor ?? EMPTY_CURSOR, hasMore: false } };
  });
  return fetchMock as unknown as GraphqlFetchMock;
}

function noopQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn() } as unknown as QueryInvalidator;
}

/**
 * The removal's latch: armed from inside a pull callback (the purge lands
 * mid-cycle) and released later, so a test can hold the window open exactly as
 * long as the real delete transaction does.
 */
function purgeLatch() {
  const latch: { release: (() => void) | null } = { release: null };
  return {
    begin: () => {
      if (!latch.release) latch.release = beginScopePurge(NAMESPACE);
    },
    release: () => latch.release?.(),
  };
}

/** The terminal the mobile reporter builds from the teardown's seam. */
function abandonedTerminal(scopeKey: string): SnapshotBootstrapErrorReport {
  return {
    scopeKey,
    stage: 'board-removed',
    attempt: 0,
    cause: null,
    reason: 'abandoned-removed',
    aborted: true,
    expected: true,
  };
}

let workDir: string;
let db: TestSqliteDb;
let artifactPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'purge-abandoned-'));
  db = createTestDatabase(join(workDir, 'client.db'));
  await runMigrations(db);
  await ensureMutationQueueTable(db);
  artifactPath = join(workDir, 'tension-11.db');
  buildArtifact(artifactPath);
  __resetDrainerStateForTests();
  __resetDownloadTerminalRegistryForTests();
});

afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
  __resetDownloadTerminalRegistryForTests();
  rmSync(workDir, { recursive: true, force: true });
});

describe('a board removed mid-crawl (issue #4406)', () => {
  it('closes its Started with exactly one classified terminal event', async () => {
    const started: ScopeDownloadStartInfo[] = [];
    const terminals: SnapshotBootstrapErrorReport[] = [];
    const completed = vi.fn();

    // The removal lands while the delta crawl is paging board_climb_grades —
    // after the artifacts imported and `bootstrap-done:` was stamped.
    const removal = purgeLatch();
    const fetch = makeFetch({
      onQuery: (queryName) => {
        if (queryName === 'syncClimbGrades') removal.begin();
      },
    });

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: makeSnapshotSource({ filePath: artifactPath }),
      onScopeDownloadStart: (info) => started.push(info),
      onScopeDownloadComplete: completed,
      onSnapshotBootstrapError: (report) => terminals.push(report),
    });

    // The Started the funnel is missing a terminal for.
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ scopeKey: SCOPE_KEY, pathIntent: 'snapshot' });
    expect(await isBootstrapDone(db, SCOPE_KEY)).toBe(true);
    // The crawl never reached the tail, so no Completed — that is the abandonment.
    expect(completed).not.toHaveBeenCalled();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(false);
    expect(await isScopeDownloadStarted(db, SCOPE_KEY)).toBe(true);

    // The teardown the purge belongs to. It is the last thing that can still see
    // the durable `scope-started:` marker, which is why the terminal is emitted
    // from here.
    await removeBoardScopeData({
      db,
      scope: SCOPE,
      scopeKey: SCOPE_KEY,
      retainedScopes: [],
      onDownloadAbandoned: ({ scopeKey }) => terminals.push(abandonedTerminal(scopeKey)),
    });
    removal.release();

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      scopeKey: SCOPE_KEY,
      reason: 'abandoned-removed',
      aborted: true,
      expected: true,
      attempt: 0,
    });
  });

  it('emits ONE terminal, not two, when the removal lands mid-bootstrap', async () => {
    const terminals: SnapshotBootstrapErrorReport[] = [];
    const removal = purgeLatch();

    await pullSync(db, noopQueryClient(), makeFetch(), {
      enabledBoards: [SCOPE_KEY],
      // Purged while the artifact is on the wire: the bootstrap phase reports its
      // own `aborted-wipe` terminal for this attempt.
      snapshotSource: makeSnapshotSource({ filePath: artifactPath, onDownload: removal.begin }),
      onSnapshotBootstrapError: (report) => terminals.push(report),
    });

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ reason: 'aborted-wipe', aborted: true });

    await removeBoardScopeData({
      db,
      scope: SCOPE,
      scopeKey: SCOPE_KEY,
      retainedScopes: [],
      onDownloadAbandoned: ({ scopeKey }) => terminals.push(abandonedTerminal(scopeKey)),
    });
    removal.release();

    // Still one: the phase already closed this Started's funnel.
    expect(terminals).toHaveLength(1);
  });

  it('stays silent for a board that was never downloaded', async () => {
    const onDownloadAbandoned = vi.fn();
    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [], onDownloadAbandoned });
    expect(onDownloadAbandoned).not.toHaveBeenCalled();
  });

  it('stays silent for a board whose download had already completed', async () => {
    await pullSync(db, noopQueryClient(), makeFetch(), { enabledBoards: [SCOPE_KEY] });
    await markScopeDownloadComplete(db, SCOPE_KEY);

    const onDownloadAbandoned = vi.fn();
    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [], onDownloadAbandoned });
    expect(onDownloadAbandoned).not.toHaveBeenCalled();
  });
});

describe('re-enabling a board while its removal is still running (issue #4406)', () => {
  it('runs a fresh bootstrap once the purge window closes', async () => {
    const started: ScopeDownloadStartInfo[] = [];
    const source = makeSnapshotSource({ filePath: artifactPath });

    // Cycle 1: download, import, crawl — until the removal lands mid-crawl.
    const removal = purgeLatch();
    await pullSync(
      db,
      noopQueryClient(),
      makeFetch({
        onQuery: (queryName) => {
          if (queryName === 'syncClimbGrades') removal.begin();
        },
      }),
      {
        enabledBoards: [SCOPE_KEY],
        snapshotSource: source,
        onScopeDownloadStart: (info) => started.push(info),
        onSnapshotBootstrapError: vi.fn(),
      },
    );
    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });

    // Cycle 2 is the one the re-enable kicks two seconds later: the removal's
    // exclusive transaction is still latched, so every guard reads "purged" and
    // the scope is skipped for the WHOLE cycle. Nothing is written and nothing
    // is reported — this cycle is a no-op for the board, which is correct.
    await pullSync(db, noopQueryClient(), makeFetch(), {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: source,
      onScopeDownloadStart: (info) => started.push(info),
      onSnapshotBootstrapError: vi.fn(),
    });
    expect(started).toHaveLength(1);
    expect(await isScopeDownloadStarted(db, SCOPE_KEY)).toBe(false);

    // The purge window closes. THIS is the cycle the wedge swallowed: without a
    // re-trigger the board never downloads again, in this session or any later
    // one, because the scheduler has no interval.
    removal.release();

    await pullSync(db, noopQueryClient(), makeFetch(), {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: source,
      onScopeDownloadStart: (info) => started.push(info),
      onSnapshotBootstrapError: vi.fn(),
    });

    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({ scopeKey: SCOPE_KEY, pathIntent: 'snapshot' });
    expect(await isBootstrapDone(db, SCOPE_KEY)).toBe(true);
    // From epoch, not from the crawl the removal interrupted.
    expect(await getCheckpoint(db, getCheckpointKey('board_climbs', SCOPE_KEY))).not.toBeNull();
  });
});
