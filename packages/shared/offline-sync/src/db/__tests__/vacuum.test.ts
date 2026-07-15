// VACUUM coverage. File-backed on purpose: an in-memory database has no file to
// shrink, so the central claim of this module — that the bytes actually come back —
// is only testable against a real file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vacuumDatabase, measureReclaimableBytes } from '../vacuum';
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

    await vacuumDatabase(db);

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
