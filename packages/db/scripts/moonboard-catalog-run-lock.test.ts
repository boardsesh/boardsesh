import test from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import {
  acquireCatalogImportLock,
  assertCatalogImportLockHeld,
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

// Pins the actual exported value across the UTF-8-bytes-vs-UTF-16-code-units
// fix: MOONBOARD_CATALOG_IMPORT_LOCK_NAME is pure ASCII, so both hashing
// strategies happen to agree on it, but this makes that agreement an explicit,
// checked fact rather than something a future refactor could silently break.
void test('the exported lock key has its known value', () => {
  assert.equal(MOONBOARD_CATALOG_IMPORT_LOCK_KEY, 5357339231546257275n);
});

void test('the lock key fits Postgres bigint (signed 64-bit)', () => {
  assert.ok(MOONBOARD_CATALOG_IMPORT_LOCK_KEY >= 0n);
  assert.ok(MOONBOARD_CATALOG_IMPORT_LOCK_KEY < 1n << 63n);
});

void test('fnv1a64 is deterministic and sensitive to its input', () => {
  assert.equal(fnv1a64('a'), fnv1a64('a'));
  assert.notEqual(fnv1a64('a'), fnv1a64('b'));
});

// The bug this guards: hashing `input.charCodeAt(index)` directly hashes
// UTF-16 code units, not UTF-8 bytes — a non-ASCII character (anything above
// U+007F) encodes to more than one UTF-8 byte, so hashing code units silently
// diverges from the standard, cross-language FNV-1a definition for such
// input. ASCII input is single-byte in both encodings, so it cannot catch
// this: the assertion below needs a non-ASCII character to be meaningful.
void test('fnv1a64 hashes UTF-8 bytes, not UTF-16 code units', () => {
  const nonAscii = 'boardsesh:moonboard-catalog-import-é'; // trailing é (U+00E9): 2 UTF-8 bytes, 1 UTF-16 code unit
  const hashedAsUtf8Bytes = (() => {
    const OFFSET_BASIS = 0xcbf29ce484222325n;
    const PRIME = 0x100000001b3n;
    const MASK_64_BITS = (1n << 64n) - 1n;
    let hash = OFFSET_BASIS;
    for (const byte of new TextEncoder().encode(nonAscii)) {
      hash = (hash ^ BigInt(byte)) & MASK_64_BITS;
      hash = (hash * PRIME) & MASK_64_BITS;
    }
    return hash;
  })();
  const hashedAsCodeUnits = (() => {
    const OFFSET_BASIS = 0xcbf29ce484222325n;
    const PRIME = 0x100000001b3n;
    const MASK_64_BITS = (1n << 64n) - 1n;
    let hash = OFFSET_BASIS;
    for (let index = 0; index < nonAscii.length; index++) {
      hash = (hash ^ BigInt(nonAscii.charCodeAt(index))) & MASK_64_BITS;
      hash = (hash * PRIME) & MASK_64_BITS;
    }
    return hash;
  })();

  assert.notEqual(hashedAsUtf8Bytes, hashedAsCodeUnits);
  assert.equal(fnv1a64(nonAscii), hashedAsUtf8Bytes);
});

void test('acquireCatalogImportLock issues pg_try_advisory_lock with the catalog key', async () => {
  const { db, statements, paramsPerStatement } = recordingDb([[{ locked: true, backend_pid: 4242 }]]);

  const result = await acquireCatalogImportLock(db);

  assert.deepEqual(result, { acquired: true, backendPid: 4242 });
  assert.match(statements[0] ?? '', /pg_try_advisory_lock/);
  assert.match(statements[0] ?? '', /pg_backend_pid/);
  assert.deepEqual(paramsPerStatement[0], [MOONBOARD_CATALOG_IMPORT_LOCK_KEY]);
});

void test('acquireCatalogImportLock returns not-acquired when the lock is already held', async () => {
  const { db } = recordingDb([[{ locked: false, backend_pid: 4242 }]]);

  assert.deepEqual(await acquireCatalogImportLock(db), { acquired: false });
});

void test('acquireCatalogImportLock returns not-acquired on an empty result rather than throwing', async () => {
  const { db } = recordingDb([[]]);

  assert.deepEqual(await acquireCatalogImportLock(db), { acquired: false });
});

void test('assertCatalogImportLockHeld succeeds when the pid matches and pg_locks confirms the key', async () => {
  const { db, statements } = recordingDb([[{ backend_pid: 4242, held: true }]]);

  const result = await assertCatalogImportLockHeld(db, 4242);

  assert.deepEqual(result, { ok: true });
  assert.match(statements[0] ?? '', /pg_locks/);
  assert.match(statements[0] ?? '', /pg_backend_pid/);
});

void test('assertCatalogImportLockHeld fails when the backend pid changed (silent reconnect)', async () => {
  const { db } = recordingDb([[{ backend_pid: 9999, held: true }]]);

  const result = await assertCatalogImportLockHeld(db, 4242);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /4242/);
    assert.match(result.reason, /9999/);
  }
});

void test('assertCatalogImportLockHeld fails when pg_locks no longer shows the key for this pid', async () => {
  const { db } = recordingDb([[{ backend_pid: 4242, held: false }]]);

  const result = await assertCatalogImportLockHeld(db, 4242);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /4242/);
  }
});

void test('assertCatalogImportLockHeld fails rather than throwing on an empty result', async () => {
  const { db } = recordingDb([[]]);

  const result = await assertCatalogImportLockHeld(db, 4242);

  assert.equal(result.ok, false);
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
