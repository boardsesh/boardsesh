// Exercises the connection PRAGMA helpers against the REAL node:sqlite adapter,
// file-backed so WAL (which persists on the file header) actually applies —
// PRAGMA journal_mode = WAL returns "memory" on an in-memory database.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OFFLINE_DB_BUSY_TIMEOUT_MS, applyBusyTimeout, configureMainConnection } from '../pragmas';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let workDir: string;
let dbPath: string;
let db: TestSqliteDb;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bs-pragmas-'));
  dbPath = join(workDir, 'boardsesh.db');
  db = createTestDatabase(dbPath);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('applyBusyTimeout', () => {
  it('sets busy_timeout to the shared constant on the connection', async () => {
    const before = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(before?.timeout).toBe(0);

    await applyBusyTimeout(db);

    const after = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(after?.timeout).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });
});

describe('configureMainConnection', () => {
  it('switches the file to WAL and sets busy_timeout', async () => {
    await configureMainConnection(db);

    const journal = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });

  it('persists WAL on the file header for later connections, but not busy_timeout', async () => {
    await configureMainConnection(db);

    // A second connection to the same file — the shape withExclusiveTransactionAsync
    // opens per task (useNewConnection: true). WAL comes from the file header;
    // busy_timeout is per-connection and resets to 0, which is exactly why every
    // ephemeral task must call applyBusyTimeout itself.
    const other = createTestDatabase(dbPath);
    const journal = await other.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await other.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(0);
  });
});

describe('ephemeral transaction connection', () => {
  it('has its own busy_timeout of 0 until applyBusyTimeout runs inside the task', async () => {
    await configureMainConnection(db);

    let insideDefault: number | undefined;
    let insideAfterApply: number | undefined;
    await db.withExclusiveTransactionAsync(async (txn) => {
      // The task runs on a separate connection: it inherits WAL from the file but
      // starts at busy_timeout = 0, regardless of the main connection's setting.
      insideDefault = (await txn.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout'))?.timeout;
      await applyBusyTimeout(txn);
      insideAfterApply = (await txn.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout'))?.timeout;
    });

    expect(insideDefault).toBe(0);
    expect(insideAfterApply).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });
});
