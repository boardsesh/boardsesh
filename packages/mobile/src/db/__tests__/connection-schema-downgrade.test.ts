// The downgrade guard, end to end through `initializeDatabase`: an older bundle
// launching on a database a newer bundle migrated (a reverted canary OTA, or a
// climber leaving the early-updates track). Runs against real SQLite (node:sqlite)
// with the real engine, so "left untouched" is a statement about the file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn() }));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

import type { SQLiteDatabase } from 'expo-sqlite';
import {
  runMigrations,
  enqueue,
  getPendingCount,
  LATEST_SCHEMA_VERSION,
  SchemaNewerThanAppError,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getDatabaseHandle, initializeDatabase, setDatabaseHandle } from '../connection';
import { isSchemaReady } from '../schema-ready';
import { getSchemaDowngrade, resetSchemaDowngradeForTests, subscribeSchemaDowngrade } from '../schema-downgrade';
import { resetDatabaseInitializationForTests } from '../testing';

type TestDatabase = TestSqliteDb & SQLiteDatabase;

const NEWER_VERSION = LATEST_SCHEMA_VERSION + 1;

let dbDir: string;
let dbPath: string;

function openDatabase(): TestDatabase {
  return createTestDatabase(dbPath) as unknown as TestDatabase;
}

/** The file as a newer bundle left it: its own migration on top, and a send still queued. */
async function createDatabaseFromNewerBundle(): Promise<TestDatabase> {
  const db = openDatabase();
  await runMigrations(db);
  await db.execAsync('CREATE TABLE future_table (id INTEGER PRIMARY KEY, note TEXT);');
  await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
  await db.runAsync('UPDATE schema_version SET version = ? WHERE id = 1', [NEWER_VERSION]);
  return db;
}

async function fileFingerprint(db: TestDatabase): Promise<unknown> {
  return {
    schema: await db.getAllAsync('SELECT type, name, sql FROM sqlite_master ORDER BY type, name'),
    version: await db.getAllAsync('SELECT id, version FROM schema_version'),
    outbox: await db.getAllAsync('SELECT * FROM pending_mutations ORDER BY id'),
    journalMode: await db.getFirstAsync('PRAGMA journal_mode'),
  };
}

beforeEach(() => {
  resetDatabaseInitializationForTests();
  resetSchemaDowngradeForTests();
  setDatabaseHandle(null);
  reportErrorMock.mockClear();
  trackMock.mockClear();
  dbDir = mkdtempSync(join(tmpdir(), 'bs-downgrade-'));
  dbPath = join(dbDir, 'boardsesh.db');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('initializeDatabase on a database from a newer bundle', () => {
  it('releases the launch gate without publishing a handle or schema readiness', async () => {
    const db = await createDatabaseFromNewerBundle();

    await expect(initializeDatabase(db)).resolves.toBeUndefined();

    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
  });

  it('records both versions in the downgrade store and tells subscribers', async () => {
    const db = await createDatabaseFromNewerBundle();
    const listener = vi.fn();
    const unsubscribe = subscribeSchemaDowngrade(listener);

    await initializeDatabase(db);

    expect(getSchemaDowngrade()).toEqual({ storedVersion: NEWER_VERSION, supportedVersion: LATEST_SCHEMA_VERSION });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('leaves the file exactly as the newer bundle left it, queued send included', async () => {
    const db = await createDatabaseFromNewerBundle();
    const before = await fileFingerprint(db);

    await initializeDatabase(db);

    expect(await fileFingerprint(db)).toEqual(before);
    expect(await getPendingCount(db)).toBe(1);
  });

  it('changes nothing in the file: its only statement is the connection-local busy timeout', async () => {
    const db = await createDatabaseFromNewerBundle();
    const execAsync = vi.spyOn(db, 'execAsync');
    const runAsync = vi.spyOn(db, 'runAsync');
    const withExclusiveTransactionAsync = vi.spyOn(db, 'withExclusiveTransactionAsync');

    await initializeDatabase(db);

    // No WAL switch, no queue-table DDL, no migration.
    expect(execAsync.mock.calls.map(([source]) => source)).toEqual([
      expect.stringMatching(/^PRAGMA busy_timeout = \d+$/),
    ]);
    expect(runAsync).not.toHaveBeenCalled();
    expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });

  it('reports the state once under its own kind, not as a failed init', async () => {
    const db = await createDatabaseFromNewerBundle();

    await initializeDatabase(db);

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [error, context] = reportErrorMock.mock.calls[0];
    expect(error).toBeInstanceOf(SchemaNewerThanAppError);
    expect(context).toMatchObject({
      level: 'warning',
      tags: {
        source: 'offline-sync',
        kind: 'sqlite-schema-newer',
        stored_schema_version: NEWER_VERSION,
        supported_schema_version: LATEST_SCHEMA_VERSION,
      },
    });
    expect(context.tags.kind).not.toBe('sqlite-init');
    // No recovery event either: nothing was contended and nothing recovered.
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not retry: the answer cannot change until the JS does', async () => {
    vi.useFakeTimers();
    const db = await createDatabaseFromNewerBundle();
    const getFirstAsync = vi.spyOn(db, 'getFirstAsync');

    await initializeDatabase(db);
    const readsAfterFirstAttempt = getFirstAsync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(getFirstAsync.mock.calls.length).toBe(readsAfterFirstAttempt);
    expect(getDatabaseHandle()).toBeNull();
  });

  it('refuses again on a remount, without a second report', async () => {
    const first = await createDatabaseFromNewerBundle();
    await initializeDatabase(first);

    const second = openDatabase();
    await initializeDatabase(second);

    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('initializeDatabase on a database this bundle can open', () => {
  it('still migrates a fresh file and publishes it, with no downgrade recorded', async () => {
    const db = openDatabase();

    await initializeDatabase(db);

    expect(getDatabaseHandle()).toBe(db);
    expect(isSchemaReady()).toBe(true);
    expect(getSchemaDowngrade()).toBeNull();
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('still upgrades a file an OLDER bundle left behind', async () => {
    const db = openDatabase();
    await runMigrations(db);
    await db.runAsync('UPDATE schema_version SET version = ? WHERE id = 1', [LATEST_SCHEMA_VERSION]);

    await initializeDatabase(db);

    expect(getDatabaseHandle()).toBe(db);
    expect(getSchemaDowngrade()).toBeNull();
  });
});
