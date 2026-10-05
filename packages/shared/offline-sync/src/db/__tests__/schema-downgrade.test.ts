// The downgrade guard: an older bundle meeting a database a newer bundle already
// migrated. Runs against real SQLite (node:sqlite) so "touched nothing" is a
// statement about the file, not about a mock.

import { describe, it, expect, vi } from 'vitest';

import {
  runMigrations,
  readSchemaCompatibility,
  classifySchemaVersion,
  SchemaNewerThanAppError,
  LATEST_SCHEMA_VERSION,
} from '../migrations';
import { enqueue } from '../../mutation-queue/queue';
import { createTestDatabase } from '../../testing/sqlite-test-db';

const NEWER_VERSION = LATEST_SCHEMA_VERSION + 1;

type TestDatabase = ReturnType<typeof createTestDatabase>;

/**
 * A database as a newer bundle would leave it: every migration this bundle knows,
 * one more it does not (a column on an existing table and a table of its own), a
 * queued send, and the version stamped past LATEST.
 */
async function createDatabaseFromNewerBundle(): Promise<TestDatabase> {
  const db = createTestDatabase();
  await runMigrations(db);
  await db.execAsync('ALTER TABLE boardsesh_ticks ADD COLUMN from_the_future TEXT;');
  await db.execAsync('CREATE TABLE future_table (id INTEGER PRIMARY KEY, note TEXT);');
  await db.runAsync("INSERT INTO future_table (id, note) VALUES (1, 'written by newer JS')");
  await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
  await db.runAsync('UPDATE schema_version SET version = ? WHERE id = 1', [NEWER_VERSION]);
  return db;
}

/** Everything a rewrite, a re-stamp or a delete would change. */
async function fingerprint(db: TestDatabase): Promise<unknown> {
  return {
    schema: await db.getAllAsync('SELECT type, name, sql FROM sqlite_master ORDER BY type, name'),
    version: await db.getAllAsync('SELECT id, version FROM schema_version'),
    outbox: await db.getAllAsync('SELECT * FROM pending_mutations ORDER BY id'),
    future: await db.getAllAsync('SELECT * FROM future_table ORDER BY id'),
  };
}

describe('classifySchemaVersion', () => {
  it('calls a stored version above the supported one newer', () => {
    expect(classifySchemaVersion(11, 10)).toEqual({ status: 'newer', storedVersion: 11, supportedVersion: 10 });
  });

  it.each([
    [0, 10],
    [9, 10],
    [10, 10],
  ])('calls stored v%i compatible with a bundle that knows v%i', (storedVersion, supportedVersion) => {
    expect(classifySchemaVersion(storedVersion, supportedVersion).status).toBe('compatible');
  });

  it('defaults to this bundle’s latest migration', () => {
    expect(classifySchemaVersion(LATEST_SCHEMA_VERSION).status).toBe('compatible');
    expect(classifySchemaVersion(NEWER_VERSION)).toEqual({
      status: 'newer',
      storedVersion: NEWER_VERSION,
      supportedVersion: LATEST_SCHEMA_VERSION,
    });
  });
});

describe('readSchemaCompatibility', () => {
  it('reads a fresh database as version 0 without creating the version table', async () => {
    const db = createTestDatabase();

    await expect(readSchemaCompatibility(db)).resolves.toEqual({
      status: 'compatible',
      storedVersion: 0,
      supportedVersion: LATEST_SCHEMA_VERSION,
    });

    expect(await db.getAllAsync('SELECT name FROM sqlite_master')).toEqual([]);
  });

  it('reads an empty version table as version 0', async () => {
    const db = createTestDatabase();
    await db.execAsync('CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');

    expect((await readSchemaCompatibility(db)).storedVersion).toBe(0);
  });

  it('reads a database this bundle migrated as compatible', async () => {
    const db = createTestDatabase();
    await runMigrations(db);

    await expect(readSchemaCompatibility(db)).resolves.toEqual({
      status: 'compatible',
      storedVersion: LATEST_SCHEMA_VERSION,
      supportedVersion: LATEST_SCHEMA_VERSION,
    });
  });

  it('reads a database a newer bundle migrated as newer', async () => {
    const db = await createDatabaseFromNewerBundle();

    await expect(readSchemaCompatibility(db)).resolves.toEqual({
      status: 'newer',
      storedVersion: NEWER_VERSION,
      supportedVersion: LATEST_SCHEMA_VERSION,
    });
  });

  it('issues no write of any kind', async () => {
    const db = await createDatabaseFromNewerBundle();
    const execAsync = vi.spyOn(db, 'execAsync');
    const runAsync = vi.spyOn(db, 'runAsync');
    const withExclusiveTransactionAsync = vi.spyOn(db, 'withExclusiveTransactionAsync');

    await readSchemaCompatibility(db);

    expect(execAsync).not.toHaveBeenCalled();
    expect(runAsync).not.toHaveBeenCalled();
    expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });
});

describe('runMigrations against a database from a newer bundle', () => {
  it('returns the newer outcome instead of throwing', async () => {
    const db = await createDatabaseFromNewerBundle();

    await expect(runMigrations(db)).resolves.toEqual({
      status: 'newer',
      storedVersion: NEWER_VERSION,
      supportedVersion: LATEST_SCHEMA_VERSION,
    });
  });

  it('leaves the schema, the version stamp, the outbox and the newer rows exactly as they were', async () => {
    const db = await createDatabaseFromNewerBundle();
    const before = await fingerprint(db);

    await runMigrations(db);

    expect(await fingerprint(db)).toEqual(before);
  });

  it('opens no transaction and runs no statement', async () => {
    const db = await createDatabaseFromNewerBundle();
    const execAsync = vi.spyOn(db, 'execAsync');
    const runAsync = vi.spyOn(db, 'runAsync');
    const withExclusiveTransactionAsync = vi.spyOn(db, 'withExclusiveTransactionAsync');

    await runMigrations(db);

    expect(execAsync).not.toHaveBeenCalled();
    expect(runAsync).not.toHaveBeenCalled();
    expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });

  it('stays refused on every later launch, and opens again once a bundle that knows the schema runs', async () => {
    const db = await createDatabaseFromNewerBundle();

    expect((await runMigrations(db)).status).toBe('newer');
    expect((await runMigrations(db)).status).toBe('newer');

    // The bundle that wrote the file comes back (the update the guard asks for).
    expect((await readSchemaCompatibility(db, NEWER_VERSION)).status).toBe('compatible');
  });
});

describe('SchemaNewerThanAppError', () => {
  it('carries both versions and names itself, so a caller can tell it from a SQLite failure', () => {
    const error = new SchemaNewerThanAppError(11, 10);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SchemaNewerThanAppError');
    expect(error.storedVersion).toBe(11);
    expect(error.supportedVersion).toBe(10);
    expect(error.message).toContain('v11');
    expect(error.message).toContain('v10');
  });
});
