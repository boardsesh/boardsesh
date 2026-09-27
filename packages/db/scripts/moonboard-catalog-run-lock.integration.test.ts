import assert from 'node:assert/strict';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  acquireCatalogImportLock,
  assertCatalogImportLockHeld,
  releaseCatalogImportLock,
} from './moonboard-catalog-run-lock.js';

/**
 * Runs against a real Postgres server (CI's db-migrations job sets
 * MIGRATION_REPLAY_DB_URL) because the claims this module makes cannot be
 * exercised against the hermetic recording-DB double in
 * moonboard-catalog-run-lock.test.ts:
 *  - `pg_try_advisory_lock` genuinely blocks a second SESSION, not just a
 *    second call on the same connection.
 *  - The bigint lock key round-trips through postgres.js's real wire protocol
 *    (a JS `bigint` parameter serialised as OID 20/int8) without truncation —
 *    see the comment above MOONBOARD_CATALOG_IMPORT_LOCK_KEY.
 *  - A connection recycled mid-run (postgres.js's `max_lifetime`) really does
 *    drop the session-scoped lock, and assertCatalogImportLockHeld really
 *    does catch it.
 *
 *   MIGRATION_REPLAY_DB_URL=postgres://postgres:password@localhost:5432/postgres \
 *     vp exec tsx --test scripts/moonboard-catalog-run-lock.integration.test.ts
 */
const adminUrl = process.env.MIGRATION_REPLAY_DB_URL;

void test(
  'a second session is refused while the first holds the lock, and can acquire once released',
  { skip: !adminUrl },
  async () => {
    const first = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    const second = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    try {
      const firstDb = drizzle(first);
      const secondDb = drizzle(second);

      const firstAcquire = await acquireCatalogImportLock(firstDb);
      assert.equal(firstAcquire.acquired, true);

      const secondAcquireWhileHeld = await acquireCatalogImportLock(secondDb);
      assert.deepEqual(secondAcquireWhileHeld, { acquired: false });

      await releaseCatalogImportLock(firstDb);

      const secondAcquireAfterRelease = await acquireCatalogImportLock(secondDb);
      assert.equal(secondAcquireAfterRelease.acquired, true);

      await releaseCatalogImportLock(secondDb);
    } finally {
      await first.end();
      await second.end();
    }
  },
);

void test(
  'assertCatalogImportLockHeld catches a silent reconnect after max_lifetime elapses',
  { skip: !adminUrl },
  async () => {
    // A short max_lifetime forces postgres.js to close and reopen the
    // connection mid-test, reproducing the real failure mode this guard
    // exists for: a lock taken on one backend silently vanishing when that
    // backend disconnects, which is exactly what the importer's own
    // `max_lifetime: null` is meant to prevent from happening for real.
    const client = postgres(adminUrl!, { max: 1, max_lifetime: 2, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const acquireResult = await acquireCatalogImportLock(db);
      assert.equal(acquireResult.acquired, true);
      if (!acquireResult.acquired) return; // narrows the type for TS below; unreachable given the assertion above

      const originalBackendPid = acquireResult.backendPid;

      // Immediately after acquiring, the lock is still held by the same backend.
      assert.deepEqual(await assertCatalogImportLockHeld(db, originalBackendPid), { ok: true });

      // Wait past max_lifetime so postgres.js recycles the underlying socket.
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const afterReconnect = await assertCatalogImportLockHeld(db, originalBackendPid);
      assert.equal(afterReconnect.ok, false);
    } finally {
      await client.end();
    }
  },
);
