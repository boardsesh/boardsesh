// Deletions-coverage guard (issue #3474) — the staleness oracle and the reset
// it authorises, against the REAL on-device DDL via node:sqlite.
//
// The failure this guards is rare (a device away from sync for 80+ days). The
// REGRESSION it could cause — an unintended mass wipe of everyone's ticks,
// playlists and favourites — is not. Most of the assertions below therefore pin
// what must NOT happen.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  DELETIONS_COVERAGE_KEY,
  evaluateDeletionsCoverage,
  getDeletionsCoverageAt,
  resetUserDataForLostCoverage,
  setDeletionsCoverageAt,
} from '../deletions-coverage';
import {
  DELETIONS_COVERAGE_EPOCH_FLOOR_MS,
  DELETIONS_COVERAGE_MARGIN_DAYS,
  SYNC_DELETIONS_RETENTION_DAYS,
} from '../retention';
import { USER_DATA_TABLES, BOARD_DATA_TABLES } from '../table-config';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { enqueue, type PendingMutation } from '../../mutation-queue/queue';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-01T12:00:00.000Z');

describe('evaluateDeletionsCoverage', () => {
  it('reads an absent marker as unknown, never as stale', () => {
    // Rollout safety: the key is new, so every existing install hits this branch
    // once. If absence ever meant "stale", the OTA that ships this feature would
    // wipe the whole fleet's user data on its first sync.
    expect(evaluateDeletionsCoverage(null, NOW)).toBe('unknown');
  });

  it('is fresh just inside the window and stale just outside it', () => {
    const thresholdDays = SYNC_DELETIONS_RETENTION_DAYS - DELETIONS_COVERAGE_MARGIN_DAYS;
    expect(thresholdDays).toBe(80);
    expect(evaluateDeletionsCoverage(NOW - (thresholdDays - 1) * DAY_MS, NOW)).toBe('fresh');
    expect(evaluateDeletionsCoverage(NOW - thresholdDays * DAY_MS, NOW)).toBe('fresh');
    expect(evaluateDeletionsCoverage(NOW - (thresholdDays + 1) * DAY_MS, NOW)).toBe('stale');
  });

  it('reports a future-dated marker so the caller can re-stamp it', () => {
    // A clock corrected backwards leaves a marker ahead of `now`. Without this
    // branch `now - marker` stays negative forever and the marker can never go
    // stale again — the guard would be permanently disarmed on that device.
    expect(evaluateDeletionsCoverage(NOW + 10 * DAY_MS, NOW)).toBe('future');
  });

  it('treats an implausibly old marker as unknown, so a broken clock re-seeds instead of wiping', () => {
    // The bad-clock loop this closes: a phone cold-boots with a dead RTC (1970 /
    // 2001) before NTP lands, reads the real marker as 'future', re-stamps it
    // with its bogus now — and once the clock corrects, that stamp is decades
    // old and would authorise a wipe on a device that syncs every day.
    expect(evaluateDeletionsCoverage(0, NOW)).toBe('unknown');
    expect(evaluateDeletionsCoverage(Date.parse('2001-01-01T00:00:00Z'), NOW)).toBe('unknown');
    expect(evaluateDeletionsCoverage(DELETIONS_COVERAGE_EPOCH_FLOOR_MS, NOW)).toBe('stale');
  });
});

describe('deletions-coverage marker round-trip', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('stores and reads back the epoch-ms marker', async () => {
    expect(await getDeletionsCoverageAt(db)).toBeNull();
    await setDeletionsCoverageAt(db, NOW);
    expect(await getDeletionsCoverageAt(db)).toBe(NOW);
  });

  it('reads a garbled marker as absent rather than infinitely old', async () => {
    // 'not-a-number' is the easy case. The ISO string is the dangerous one:
    // Number.parseInt tolerates trailing garbage and would return 2026 — epoch-ms
    // 1970, i.e. "decades stale" — so a future refactor that starts writing ISO
    // timestamps here would silently arm a fleet-wide wipe.
    for (const garbledValue of ['not-a-number', '2026-07-01T00:00:00Z', '', '  ', '17e14', '-1']) {
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
        DELETIONS_COVERAGE_KEY,
        garbledValue,
      ]);
      expect(await getDeletionsCoverageAt(db)).toBeNull();
    }
  });
});

describe('resetUserDataForLostCoverage', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
    await ensureMutationQueueTable(db);
    await seedEverything(db);
  });

  it('clears every user-data table and its checkpoint, plus the deletions cursor', async () => {
    // The rows are unreachable-but-present stale data: the tombstones that would
    // have removed them were pruned server-side, and the delta resolver never
    // re-emits a deleted row, so nothing short of deleting them locally works.
    // Counted from the DB rather than hardcoded: `rowsCleared` feeds the
    // telemetry payload, so it has to be the real row total, not the table count
    // it happens to equal while every table holds exactly one seeded row.
    let seededRows = 0;
    for (const tableName of USER_DATA_TABLES) {
      seededRows += await countRows(db, tableName);
    }
    expect(seededRows).toBeGreaterThan(0);

    const { rowsCleared } = await resetUserDataForLostCoverage(db, NOW);

    expect(rowsCleared).toBe(seededRows);
    for (const tableName of USER_DATA_TABLES) {
      expect(await countRows(db, tableName)).toBe(0);
      expect(await readMeta(db, `checkpoint:${tableName}`)).toBeNull();
    }
    expect(await readMeta(db, 'checkpoint:deletions')).toBeNull();
  });

  it('runs cleanly on already-empty tables and reports rowsCleared: 0', async () => {
    // Reachable whenever a stale marker meets tables that hold nothing — a user
    // who deleted everything server-side, or a sign-out teardown that raced the
    // guard. It must be a no-op that still stamps the marker, not a throw and
    // not a half-applied reset.
    await resetUserDataForLostCoverage(db, NOW);

    const { rowsCleared } = await resetUserDataForLostCoverage(db, NOW + 1000);

    expect(rowsCleared).toBe(0);
    expect(await readMeta(db, DELETIONS_COVERAGE_KEY)).toBe(String(NOW + 1000));
    for (const tableName of USER_DATA_TABLES) {
      expect(await countRows(db, tableName)).toBe(0);
    }
  });

  it('leaves the downloaded board catalog and its markers completely alone', async () => {
    // No production path emits a board tombstone (clear-aurora-board.ts sets
    // `boardsesh.suppress_sync_tombstones` around the only DELETEs, and
    // board_climb_grades has no delete trigger at all), so a lost deletions
    // window costs the catalog nothing. Clearing it would re-download tens to
    // hundreds of MB unprompted, possibly on cellular.
    await resetUserDataForLostCoverage(db, NOW);

    for (const tableName of BOARD_DATA_TABLES) {
      expect(await countRows(db, tableName)).toBe(1);
      expect(await readMeta(db, `checkpoint:${tableName}:kilter:1:5`)).not.toBeNull();
    }
    expect(await readMeta(db, 'scope-complete:kilter:1:5')).not.toBeNull();
    expect(await readMeta(db, 'bootstrap-done:kilter:1:5')).not.toBeNull();
    expect(await readMeta(db, 'bootstrap-attempts:kilter:1:5')).not.toBeNull();
  });

  it('preserves pending_mutations byte-for-byte', async () => {
    // Unsynced local writes exist ONLY on the device. Draining first is not a
    // substitute for never touching them: the drainer legitimately leaves rows
    // behind (attempt budget, dead letters, offline).
    const before = await readMutations(db);
    expect(before).toHaveLength(2);

    await resetUserDataForLostCoverage(db, NOW);

    expect(await readMutations(db)).toEqual(before);
  });

  it('does not disturb the on-device schema version', async () => {
    // A wipe that reset this would make the migration runner re-run every
    // migration on the next launch.
    const before = await readSchemaVersion(db);
    expect(before).toBeGreaterThan(0);
    await resetUserDataForLostCoverage(db, NOW);
    expect(await readSchemaVersion(db)).toBe(before);
  });

  it('stamps the coverage marker inside the same transaction as the deletes', async () => {
    // Otherwise a device whose rebuild pull then fails re-detects staleness and
    // wipes again on every trigger. After a full wipe the invariant is trivially
    // true — no surviving local user row predates this moment — so the stamp is
    // honest, not optimistic.
    await resetUserDataForLostCoverage(db, NOW);
    expect(await getDeletionsCoverageAt(db)).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One row in every synced table, every marker family, and two queued mutations. */
async function seedEverything(db: TestSqliteDb): Promise<void> {
  await db.runAsync("INSERT INTO boardsesh_ticks (uuid, status) VALUES ('tick-1', 'send')", []);
  await db.runAsync("INSERT INTO playlists (uuid, name) VALUES ('playlist-1', 'Projects')", []);
  await db.runAsync("INSERT INTO playlist_climbs (playlist_uuid, climb_uuid) VALUES ('playlist-1', 'climb-1')", []);
  await db.runAsync("INSERT INTO user_favorites (board_name, climb_uuid, angle) VALUES ('kilter', 'climb-1', 40)", []);
  await db.runAsync("INSERT INTO user_follows (following_id) VALUES ('user-2')", []);
  await db.runAsync("INSERT INTO setter_follows (setter_username) VALUES ('setter-1')", []);
  await db.runAsync("INSERT INTO playlist_follows (playlist_uuid) VALUES ('playlist-9')", []);

  await db.runAsync("INSERT INTO board_climbs (uuid, board_type, layout_id) VALUES ('climb-1', 'kilter', 1)", []);
  await db.runAsync(
    "INSERT INTO board_climb_stats (board_type, climb_uuid, angle) VALUES ('kilter', 'climb-1', 40)",
    [],
  );
  await db.runAsync(
    "INSERT INTO board_climb_grades (board_type, climb_uuid, angle) VALUES ('kilter', 'climb-1', 40)",
    [],
  );

  const cursor = JSON.stringify({ updatedAt: '2026-01-01T00:00:00Z', syncSeq: '7' });
  for (const tableName of USER_DATA_TABLES) {
    await putMeta(db, `checkpoint:${tableName}`, cursor);
  }
  for (const tableName of BOARD_DATA_TABLES) {
    await putMeta(db, `checkpoint:${tableName}:kilter:1:5`, cursor);
  }
  await putMeta(db, 'checkpoint:deletions', cursor);
  await putMeta(db, 'scope-complete:kilter:1:5', '1');
  await putMeta(db, 'bootstrap-done:kilter:1:5', '1');
  await putMeta(db, 'bootstrap-attempts:kilter:1:5', '2');

  await enqueue(db, 'boardsesh_ticks', 'create', { uuid: 'offline-tick-1' }, 'idem-1');
  await enqueue(db, 'user_favorites', 'create', { climb_uuid: 'climb-9' }, 'idem-2');
}

async function putMeta(db: TestSqliteDb, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, value]);
}

async function readMeta(db: TestSqliteDb, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

async function countRows(db: TestSqliteDb, tableName: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tableName}`, []);
  return row?.n ?? 0;
}

async function readSchemaVersion(db: TestSqliteDb): Promise<number> {
  const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1', []);
  return row?.version ?? 0;
}

async function readMutations(db: TestSqliteDb): Promise<PendingMutation[]> {
  return db.getAllAsync<PendingMutation>('SELECT * FROM pending_mutations ORDER BY id ASC', []);
}
