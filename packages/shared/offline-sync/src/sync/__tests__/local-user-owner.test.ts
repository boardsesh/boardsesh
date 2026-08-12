// The auth-scoping contract for local user data (docs/offline-reads.md), against
// the REAL on-device DDL via node:sqlite.
//
// What this protects is a cross-user leak on a shared phone. Sign-out's wipe is
// best-effort — the call swallows failures with a dev-only warning, and a
// logged-out cold start skips it — so "the tables are empty because we deleted
// them" is not something a reader may assume. These assertions pin the three
// answers that matter: an unstamped device does not serve, somebody else's
// stamp does not serve, and a stamp survives nothing that sign-out touches.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  LOCAL_USER_ID_KEY,
  USER_DATA_COMPLETE_KEY,
  assertLocalUserDataOwner,
  canServeLocalUserData,
  clearLocalUserId,
  getLocalUserId,
  isUserDataComplete,
  markUserDataComplete,
  stampLocalUserId,
} from '../local-user-owner';
import { deleteUserCheckpoints } from '../checkpoints';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

const CLIMBER_A = 'user-aaa';
const CLIMBER_B = 'user-bbb';

let db: TestSqliteDb;

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
});

describe('local user-data ownership', () => {
  it('reads a never-synced device as unstamped, not as a match', () => {
    expect(getLocalUserId(db)).resolves.toBeNull();
    return expect(assertLocalUserDataOwner(db, CLIMBER_A)).resolves.toBe('unstamped');
  });

  it('serves once the stamp names the signed-in climber', async () => {
    await stampLocalUserId(db, CLIMBER_A);
    await expect(assertLocalUserDataOwner(db, CLIMBER_A)).resolves.toBe('ok');
  });

  it('refuses when the stamp names somebody else — the failed-wipe case', async () => {
    await stampLocalUserId(db, CLIMBER_A);
    await expect(assertLocalUserDataOwner(db, CLIMBER_B)).resolves.toBe('mismatch');
  });

  it('never treats "nobody is signed in" as a match', async () => {
    // Signed out with rows still on disk is precisely when a permissive answer
    // would hand the previous account's logbook to whoever opens the app next.
    await stampLocalUserId(db, CLIMBER_A);
    await expect(assertLocalUserDataOwner(db, undefined)).resolves.toBe('mismatch');
    await expect(assertLocalUserDataOwner(db, null)).resolves.toBe('mismatch');
    await expect(assertLocalUserDataOwner(db, '')).resolves.toBe('mismatch');
  });

  it('re-stamps in place rather than accumulating owners', async () => {
    await stampLocalUserId(db, CLIMBER_A);
    await stampLocalUserId(db, CLIMBER_B);
    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      LOCAL_USER_ID_KEY,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(CLIMBER_B);
  });

  it('is cleared by the sign-out checkpoint wipe', async () => {
    await stampLocalUserId(db, CLIMBER_A);
    await deleteUserCheckpoints(db);
    await expect(getLocalUserId(db)).resolves.toBeNull();
  });

  it('can be cleared on its own', async () => {
    await stampLocalUserId(db, CLIMBER_A);
    await clearLocalUserId(db);
    await expect(getLocalUserId(db)).resolves.toBeNull();
  });
});

describe('user-data completeness marker', () => {
  it('is absent until a cycle pulls every user table to its tail', async () => {
    await expect(isUserDataComplete(db)).resolves.toBe(false);
  });

  it('is set by markUserDataComplete and is idempotent', async () => {
    await markUserDataComplete(db);
    await markUserDataComplete(db);
    await expect(isUserDataComplete(db)).resolves.toBe(true);
    const rows = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
      USER_DATA_COMPLETE_KEY,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('is cleared by the sign-out checkpoint wipe, for free via the checkpoint: prefix', async () => {
    await markUserDataComplete(db);
    await deleteUserCheckpoints(db);
    await expect(isUserDataComplete(db)).resolves.toBe(false);
  });
});

describe('canServeLocalUserData', () => {
  it('needs both the owner match and the completeness marker', async () => {
    await expect(canServeLocalUserData(db, CLIMBER_A)).resolves.toBe(false);

    await stampLocalUserId(db, CLIMBER_A);
    // Stamped but mid-crawl: a logbook built from the first page reads as
    // "you never climbed that", which is worse than not answering.
    await expect(canServeLocalUserData(db, CLIMBER_A)).resolves.toBe(false);

    await markUserDataComplete(db);
    await expect(canServeLocalUserData(db, CLIMBER_A)).resolves.toBe(true);

    // Complete, but for the wrong account.
    await expect(canServeLocalUserData(db, CLIMBER_B)).resolves.toBe(false);
  });
});
