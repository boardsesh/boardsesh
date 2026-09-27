import test from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import {
  acquireCatalogImportLock,
  releaseCatalogImportLock,
  fnv1a64,
  MOONBOARD_CATALOG_IMPORT_LOCK_NAME,
  MOONBOARD_CATALOG_IMPORT_LOCK_KEY,
  type CatalogRunLockDb,
} from './moonboard-catalog-run-lock.js';

const dialect = new PgDialect();

/**
 * Records the statements + params a call issues and lets the test script the
 * row each one returns, so assertions read the predicate/params the database
 * would actually see rather than a marker string someone remembered to keep
 * in sync. Mirrors the recordingDb pattern in
 * packages/db/src/queries/gyms/__tests__/activity-stats.test.ts.
 */
function recordingDb(rowsPerStatement: Record<string, unknown>[][] = []) {
  const statements: string[] = [];
  const paramsPerStatement: unknown[][] = [];
  let call = 0;
  const db: CatalogRunLockDb = {
    execute(query: SQLWrapper | string) {
      const rendered = dialect.sqlToQuery(query as SQL);
      statements.push(rendered.sql);
      paramsPerStatement.push(rendered.params);
      return Promise.resolve(rowsPerStatement[call++] ?? []);
    },
  };
  return { db, statements, paramsPerStatement };
}

void test('the lock key is a deterministic hash of the lock name', () => {
  const expected = fnv1a64(MOONBOARD_CATALOG_IMPORT_LOCK_NAME) & ((1n << 63n) - 1n);
  assert.equal(MOONBOARD_CATALOG_IMPORT_LOCK_KEY, expected);
});

void test('the lock key fits Postgres bigint (signed 64-bit)', () => {
  assert.ok(MOONBOARD_CATALOG_IMPORT_LOCK_KEY >= 0n);
  assert.ok(MOONBOARD_CATALOG_IMPORT_LOCK_KEY < 1n << 63n);
});

void test('fnv1a64 is deterministic and sensitive to its input', () => {
  assert.equal(fnv1a64('a'), fnv1a64('a'));
  assert.notEqual(fnv1a64('a'), fnv1a64('b'));
});

void test('acquireCatalogImportLock issues pg_try_advisory_lock with the catalog key', async () => {
  const { db, statements, paramsPerStatement } = recordingDb([[{ locked: true }]]);

  const acquired = await acquireCatalogImportLock(db);

  assert.equal(acquired, true);
  assert.match(statements[0] ?? '', /pg_try_advisory_lock/);
  assert.deepEqual(paramsPerStatement[0], [MOONBOARD_CATALOG_IMPORT_LOCK_KEY]);
});

void test('acquireCatalogImportLock returns false when the lock is already held', async () => {
  const { db } = recordingDb([[{ locked: false }]]);

  assert.equal(await acquireCatalogImportLock(db), false);
});

void test('acquireCatalogImportLock returns false on an empty result rather than throwing', async () => {
  const { db } = recordingDb([[]]);

  assert.equal(await acquireCatalogImportLock(db), false);
});

void test('releaseCatalogImportLock issues pg_advisory_unlock with the same key', async () => {
  const { db, statements, paramsPerStatement } = recordingDb([[{ unlocked: true }]]);

  await releaseCatalogImportLock(db);

  assert.match(statements[0] ?? '', /pg_advisory_unlock/);
  assert.deepEqual(paramsPerStatement[0], [MOONBOARD_CATALOG_IMPORT_LOCK_KEY]);
});

void test('releaseCatalogImportLock does not throw when the lock was never held', async () => {
  const { db } = recordingDb([[{ unlocked: false }]]);

  await assert.doesNotReject(() => releaseCatalogImportLock(db));
});
