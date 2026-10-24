// #5851: a board removal landing while one of the bootstrap phase's metadata
// writes waits for the write lock must win. Each case runs a real
// `beginScopePurge` + `removeBoardScopeData` on another connection just before
// a chosen transaction's `BEGIN IMMEDIATE`, when that transaction holds no lock
// yet — exactly like a write that queued behind the removal. The write's guard,
// read inside the lock, must then refuse it; otherwise it puts back a row the
// removal just deleted, and a re-enabled board inherits it:
//   - `bootstrap-done:` makes it look already bootstrapped, so it crawls page by
//     page instead of taking the snapshot;
//   - `scope-download-started:` / `scope-started:` skew the re-download's
//     duration, or suppress its Started for good;
//   - `bootstrap-retry:` hands it a budget or cooldown it spent before removal.
//
// FILE-backed: each transaction runs on its own connection, as on a phone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OfflineDatabase, QueryInvalidator, SqlExecutor } from '../../database';
import { pullSync } from '../pull-client';
import { removeBoardScopeData } from '../scope-teardown';
import { isBootstrapDone, type SnapshotSource } from '../snapshot-bootstrap';
import { EMPTY_BOOTSTRAP_RETRY_STATE, writeBootstrapRetryRows } from '../bootstrap-retry';
import { runPullWrite } from '../pull-write';
import { runMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { beginScopePurge, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { __resetDownloadTerminalRegistryForTests } from '../download-terminal-registry';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import type { OfflineBoardScope } from '../../offline-board-key';
import type { SnapshotManifest, SnapshotManifestEntry } from '../snapshot-manifest';

const SCOPE: OfflineBoardScope = { boardType: 'tension', layoutId: 11, sizeId: 8 };
const SCOPE_KEY = 'tension:11:8';
const NAMESPACE = 'tension:11';
const WATERMARK = { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' };
const EMPTY_CURSOR = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
const NOW = 1_800_000_000_000;

function buildArtifact(filePath: string): void {
  const artifact = new DatabaseSync(filePath);
  try {
    for (const migration of MIGRATIONS) for (const statement of migration.statements) artifact.exec(statement);
    artifact.exec(`CREATE TABLE IF NOT EXISTS snapshot_meta (table_name TEXT PRIMARY KEY, watermark_updated_at TEXT,
      watermark_sync_seq TEXT, row_count INTEGER, built_at TEXT, schema_version INTEGER, format_version INTEGER);`);
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
       VALUES (?, ?, ?, 1, '2026-06-01T00:00:00.000Z', ?, 2)`,
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

/** One layout's artifact; `onDownloadSettled` runs once its download resolves or rejects. */
function makeSnapshotSource(config: {
  filePath: string;
  downloadError?: Error;
  onDownloadSettled?: () => void;
}): SnapshotSource {
  const manifest: SnapshotManifest = {
    formatVersion: 2,
    generatedAt: '2026-06-01T00:00:00.000Z',
    entries: [makeEntry()],
  };
  return {
    fetchManifest: vi.fn(async () => manifest),
    downloadArtifact: vi.fn(async () => {
      config.onDownloadSettled?.();
      if (config.downloadError) throw config.downloadError;
      return { filePath: config.filePath };
    }),
    deleteArtifact: vi.fn(async () => {}),
  } as unknown as SnapshotSource;
}

/** Every resolver at its tail. */
const fetchEmpty = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
  const match = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
  const queryName = match ? match[1] : 'unknown';
  if (queryName === 'syncDeletions') return { syncDeletions: { deletions: [], cursor: EMPTY_CURSOR, hasMore: false } };
  return { [queryName]: { documents: [], cursor: variables?.cursor ?? EMPTY_CURSOR, hasMore: false } };
}) as unknown as <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const noopQueryClient = (): QueryInvalidator => ({ invalidateQueries: vi.fn() }) as unknown as QueryInvalidator;

/** A driver method seen through a variadic signature, so the wrappers below forward args untouched. */
const forward = (method: unknown) => method as (sql: string, ...params: unknown[]) => Promise<never>;

/**
 * The file-backed db with a hook run just BEFORE each transaction's `BEGIN
 * IMMEDIATE`, numbered from 1, told whether a snapshot import (the transaction
 * that ATTACHes the artifact) has already committed.
 */
function interceptBeginImmediate(
  raw: TestSqliteDb,
  beforeBeginImmediate: (index: number, importDone: boolean) => Promise<void>,
): OfflineDatabase {
  let index = 0;
  let importDone = false;
  const wrapTransaction = (txn: SqlExecutor, seen: { attach: boolean }): SqlExecutor =>
    ({
      execAsync: async (sql: string) => {
        if (/^\s*BEGIN IMMEDIATE\s*$/i.test(sql)) {
          index += 1;
          await beforeBeginImmediate(index, importDone);
        }
        if (/^\s*ATTACH/i.test(sql)) seen.attach = true;
        return txn.execAsync(sql);
      },
      // Variadic, exactly as called: a statement with no binds must reach the
      // driver with none, not with one `undefined`.
      runAsync: (sql: string, ...params: unknown[]) => forward(txn.runAsync.bind(txn))(sql, ...params),
      getFirstAsync: (sql: string, ...params: unknown[]) => forward(txn.getFirstAsync.bind(txn))(sql, ...params),
      getAllAsync: (sql: string, ...params: unknown[]) => forward(txn.getAllAsync.bind(txn))(sql, ...params),
    }) as unknown as SqlExecutor;
  return {
    execAsync: (sql: string) => raw.execAsync(sql),
    runAsync: (sql: string, ...params: unknown[]) => forward(raw.runAsync.bind(raw))(sql, ...params),
    getFirstAsync: (sql: string, ...params: unknown[]) => forward(raw.getFirstAsync.bind(raw))(sql, ...params),
    getAllAsync: (sql: string, ...params: unknown[]) => forward(raw.getAllAsync.bind(raw))(sql, ...params),
    withExclusiveTransactionAsync: async (task: (txn: SqlExecutor) => Promise<void>) => {
      const seen = { attach: false };
      await raw.withExclusiveTransactionAsync((txn) => task(wrapTransaction(txn, seen)));
      if (seen.attach) importDone = true;
    },
  } as unknown as OfflineDatabase;
}

/** What remove-offline-board does: latch the namespace, delete the board's rows and markers, release. */
async function removeBoard(raw: TestSqliteDb): Promise<void> {
  const release = beginScopePurge(NAMESPACE);
  try {
    await removeBoardScopeData({ db: raw, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });
  } finally {
    release();
  }
}

async function metaKey(raw: TestSqliteDb, key: string): Promise<string | null> {
  const row = await raw.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [key]);
  return row?.key ?? null;
}

let workDir: string;
let raw: TestSqliteDb;
let artifactPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'bootstrap-teardown-race-'));
  raw = createTestDatabase(join(workDir, 'client.db'));
  await runMigrations(raw);
  await ensureMutationQueueTable(raw);
  artifactPath = join(workDir, 'tension-11.db');
  buildArtifact(artifactPath);
  __resetDrainerStateForTests();
  __resetDownloadTerminalRegistryForTests();
});

afterEach(() => {
  raw.close();
  __resetDrainerStateForTests();
  __resetDownloadTerminalRegistryForTests();
  rmSync(workDir, { recursive: true, force: true });
});

describe('bootstrap metadata writes racing a board removal for the write lock (#5851)', () => {
  it('does not write bootstrap-done back after a removal that lands once the import committed', async () => {
    let removed = false;
    const db = interceptBeginImmediate(raw, async (_index, importDone) => {
      if (!importDone || removed) return;
      removed = true;
      await removeBoard(raw);
    });

    await pullSync(db, noopQueryClient(), fetchEmpty, {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: makeSnapshotSource({ filePath: artifactPath }),
      onSnapshotBootstrapError: vi.fn(),
    });

    expect(removed).toBe(true);
    expect(await isBootstrapDone(raw, SCOPE_KEY)).toBe(false);
  });

  it('does not write the start stamp or the Started marker back after a removal that lands while they wait', async () => {
    let removed = false;
    // Transaction 1 of the cycle is the start stamp; the Started marker follows.
    const db = interceptBeginImmediate(raw, async (index) => {
      if (index !== 1 || removed) return;
      removed = true;
      await removeBoard(raw);
    });

    await pullSync(db, noopQueryClient(), fetchEmpty, {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: makeSnapshotSource({ filePath: artifactPath }),
      onSnapshotBootstrapError: vi.fn(),
    });

    expect(removed).toBe(true);
    expect({
      stamp: await metaKey(raw, `scope-download-started:${SCOPE_KEY}`),
      started: await metaKey(raw, `scope-started:${SCOPE_KEY}`),
    }).toEqual({ stamp: null, started: null });
  });

  it('does not settle a failed download into a retry budget after a removal that lands while it waits', async () => {
    let downloadSettled = false;
    let removed = false;
    // The first transaction after the download rejected is the settle.
    const db = interceptBeginImmediate(raw, async () => {
      if (!downloadSettled || removed) return;
      removed = true;
      await removeBoard(raw);
    });

    await pullSync(db, noopQueryClient(), fetchEmpty, {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: makeSnapshotSource({
        filePath: artifactPath,
        downloadError: new Error('HTTP 500'),
        onDownloadSettled: () => {
          downloadSettled = true;
        },
      }),
      onSnapshotBootstrapError: vi.fn(),
      now: () => NOW,
      random: () => 0,
    });

    expect(removed).toBe(true);
    expect(await metaKey(raw, `bootstrap-retry:${SCOPE_KEY}`)).toBeNull();
    expect(await metaKey(raw, `bootstrap-paged-fallback:${SCOPE_KEY}`)).toBeNull();
  });

  it('does not write a retry state back after a removal that lands while it waits', async () => {
    // A transport failure from an earlier cycle, its cooldown over: this cycle's
    // download lands, and the first write after it clears the transport count.
    await runPullWrite(
      raw,
      (transaction) =>
        writeBootstrapRetryRows(transaction, SCOPE_KEY, {
          ...EMPTY_BOOTSTRAP_RETRY_STATE,
          transportFailures: 1,
          lastFailureKind: 'transport',
          hasPriorSnapshotFailure: true,
          retryAfter: NOW - 60_000,
        }),
      { site: 'test-seed' },
    );
    let downloadSettled = false;
    let removed = false;
    const db = interceptBeginImmediate(raw, async () => {
      if (!downloadSettled || removed) return;
      removed = true;
      await removeBoard(raw);
    });

    await pullSync(db, noopQueryClient(), fetchEmpty, {
      enabledBoards: [SCOPE_KEY],
      snapshotSource: makeSnapshotSource({
        filePath: artifactPath,
        onDownloadSettled: () => {
          downloadSettled = true;
        },
      }),
      onSnapshotBootstrapError: vi.fn(),
      now: () => NOW,
      random: () => 0,
    });

    expect(removed).toBe(true);
    expect(await metaKey(raw, `bootstrap-retry:${SCOPE_KEY}`)).toBeNull();
    // Nothing was imported over the removed board either.
    expect(await isBootstrapDone(raw, SCOPE_KEY)).toBe(false);
  });
});
