// VACUUM coverage. File-backed on purpose: an in-memory database has no file to
// shrink, so the central claim of this module — that the bytes actually come back —
// is only testable against a real file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vacuumDatabase, measureReclaimableBytes } from '../vacuum';
import { classifySqliteLockError } from '../lock-errors';
import type { OfflineDatabase } from '../../database';
import { runMigrations } from '../migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let workDir: string;
let dbPath: string;
let db: TestSqliteDb;

/** Seeded inside one transaction — a file-backed database fsyncs per statement otherwise. */
async function insertClimbs(count: number): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (let index = 0; index < count; index += 1) {
      await txn.runAsync(
        `INSERT INTO board_climbs
          (uuid, board_type, layout_id, name, description, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
         VALUES (?, 'kilter', 1, ?, ?, 0, 1, '[5]', '2026-06-01T00:00:00Z', ?)`,
        [`climb-${index}`, `climb-${index}`, 'x'.repeat(2000), index],
      );
    }
  });
}

function fileSize(): number {
  return statSync(dbPath).size;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'bs-vacuum-'));
  dbPath = join(workDir, 'test.db');
  db = createTestDatabase(dbPath);
  await ensureMutationQueueTable(db);
  await runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('vacuumDatabase', () => {
  // The reason this module exists: DELETE alone moves pages to the freelist and the
  // file stays exactly as big, so a "freed 180 MB" message without a VACUUM is a lie.
  it('shrinks a file that deletes alone left untouched', async () => {
    await insertClimbs(400);
    const sizeWhenFull = fileSize();

    await db.runAsync('DELETE FROM board_climbs');
    expect(fileSize(), 'deleting rows must not shrink the file on its own').toBe(sizeWhenFull);
    expect(await measureReclaimableBytes(db)).toBeGreaterThan(0);

    await expect(vacuumDatabase(db)).resolves.toBe(true);

    expect(fileSize()).toBeLessThan(sizeWhenFull);
    expect(await measureReclaimableBytes(db)).toBe(0);
  });

  it('reports nothing reclaimable when no rows were deleted', async () => {
    await insertClimbs(50);

    expect(await measureReclaimableBytes(db)).toBe(0);
  });

  // Pins the constraint so nobody "tidies" the VACUUM into the teardown transaction
  // later. SQLite rejects it outright, and the failure would otherwise only surface
  // on-device.
  it('cannot run inside a transaction', async () => {
    await expect(
      db.withExclusiveTransactionAsync(async (txn) => {
        await txn.execAsync('VACUUM');
      }),
    ).rejects.toThrow();
  });
});

// --- Contended WAL truncation (Sentry BOARDSESH-D7) ------------------------------
//
// The offline database is ONE connection shared by the sync engine and every
// `useSQLiteContext()` screen, so a compaction routinely runs while another
// statement on that same handle is mid-flight. SQLite refuses the truncation
// outright in that case — `sqlite3BtreeCheckpoint()` returns SQLITE_LOCKED when the
// connection's b-tree already has an open transaction — and it arrives as a THROW,
// not as the `busy = 1` row the original implementation was written against.
describe('vacuumDatabase under lock contention', () => {
  // The regression pin, against REAL SQLite rather than a hand-written message: if a
  // future SQLite or driver stops reporting this as a lock, the shared classifier
  // stops recognising it and the throw escapes to the user again.
  it('is what SQLite really does when the same connection holds a read transaction', async () => {
    await insertClimbs(20);

    await db.execAsync('BEGIN');
    await db.getFirstAsync('SELECT COUNT(*) AS n FROM board_climbs');
    let thrown: unknown = null;
    try {
      await db.getFirstAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      thrown = error;
    }
    await db.execAsync('ROLLBACK');

    expect(thrown, 'a checkpoint under an open read transaction must fail').not.toBeNull();
    expect((thrown as Error).message).toContain('database table is locked');
    // Code 6 (SQLITE_LOCKED), not 5 (SQLITE_BUSY): a conflict INSIDE one connection,
    // which no busy_timeout can wait out. node:sqlite exposes it as a field and
    // leaves the message bare; expo-sqlite prints it into the message instead
    // ("Error code 6: database table is locked"), which is the shape the classifier
    // test covers. Both must read as contention.
    expect((thrown as { errcode?: number }).errcode).toBe(6);
    expect(classifySqliteLockError(thrown).locked).toBe(true);
  });

  it('resolves false instead of throwing when the truncation stays locked', async () => {
    const locked = lockedCheckpointDatabase({ failures: Number.POSITIVE_INFINITY });

    await expect(vacuumDatabase(locked.db, { checkpointAttempts: 2, sleep: locked.sleep })).resolves.toBe(false);
    expect(locked.checkpointCalls(), 'every attempt should have been spent').toBe(2);
  });

  // The retry is the whole reason the user's storage figure moves: the blocker is a
  // list row or a search query that finishes in milliseconds.
  it('retries and succeeds once the reader lets go', async () => {
    const locked = lockedCheckpointDatabase({ failures: 1 });

    await expect(vacuumDatabase(locked.db, { checkpointAttempts: 3, sleep: locked.sleep })).resolves.toBe(true);
    expect(locked.checkpointCalls()).toBe(2);
  });

  // A broken database must never be laundered into "the file just didn't shrink".
  it('still throws when the failure is not lock contention', async () => {
    const broken = lockedCheckpointDatabase({
      failures: Number.POSITIVE_INFINITY,
      error: new Error('Error code 11: database disk image is malformed'),
    });

    await expect(vacuumDatabase(broken.db, { checkpointAttempts: 3, sleep: broken.sleep })).rejects.toThrow(
      'malformed',
    );
  });
});

/**
 * A database double whose VACUUM always succeeds and whose `wal_checkpoint` fails
 * the first `failures` times. Only the checkpoint behaviour is under test, and a
 * real file cannot be made to hold a contending cursor and run a VACUUM in the same
 * call — the test above pins the error SHAPE against real SQLite, this one pins what
 * the retry loop does with it.
 */
function lockedCheckpointDatabase(config: { failures: number; error?: Error }): {
  db: OfflineDatabase;
  sleep: (ms: number) => Promise<void>;
  checkpointCalls: () => number;
} {
  const failure = config.error ?? new Error('Error code 6: database table is locked');
  let checkpointCalls = 0;
  const db = {
    execAsync: async (): Promise<void> => {},
    getFirstAsync: async <Row>(source: string): Promise<Row | null> => {
      if (!source.includes('wal_checkpoint')) return null;
      checkpointCalls += 1;
      if (checkpointCalls <= config.failures) throw failure;
      return { busy: 0 } as Row;
    },
  } as unknown as OfflineDatabase;
  return { db, sleep: async (): Promise<void> => {}, checkpointCalls: () => checkpointCalls };
}
