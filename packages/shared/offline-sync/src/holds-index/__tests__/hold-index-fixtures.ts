// Shared fixtures for the holds-index suites: a file-backed database with the
// real migrations, a tiny frames parser, and an invariant check that the stored
// postings are exactly what the stored hold sets imply.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import type { HoldRowParser } from '../hold-index';
import { decodeHoldSet, decodeHoldSetIds, decodePostings } from '../query';

const ROLE_NAMES: Record<string, string> = { '12': 'STARTING', '13': 'HAND', '14': 'FINISH', '15': 'FOOT' };

/** `p<id>r<code>` → one row per hold, first occurrence wins; unknown codes read as AUX. */
export const parseHoldRows: HoldRowParser = (_boardType, frames) => {
  const rows: { holdId: number; holdState: string }[] = [];
  const seen = new Set<number>();
  for (const match of frames.matchAll(/p(\d+)r(\d+)/g)) {
    const holdId = Number(match[1]);
    if (seen.has(holdId)) continue;
    seen.add(holdId);
    rows.push({ holdId, holdState: ROLE_NAMES[match[2]] ?? 'AUX' });
  }
  return rows;
};

export type ClimbSeed = {
  uuid: string;
  seq: number;
  frames?: string | null;
  sizes?: number[] | null;
  boardType?: string;
  layoutId?: number;
  listed?: number;
  draft?: number;
  hidden?: number | null;
};

export type TestDatabaseHandle = { db: TestSqliteDb; close: () => void };

export async function openTestDatabase(): Promise<TestDatabaseHandle> {
  const directory = mkdtempSync(join(tmpdir(), 'hold-index-'));
  const db = createTestDatabase(join(directory, 'main.db'));
  await runMigrations(db);
  return {
    db,
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function insertClimb(db: TestSqliteDb, seed: ClimbSeed): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO board_climbs
       (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, is_hidden, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.uuid,
      seed.boardType ?? 'kilter',
      seed.layoutId ?? 1,
      seed.sizes === null ? null : JSON.stringify(seed.sizes ?? [12]),
      seed.frames === undefined ? 'p1r12p2r13' : seed.frames,
      seed.listed ?? 1,
      seed.draft ?? 0,
      seed.hidden === undefined ? 0 : seed.hidden,
      `2026-09-01T00:00:${String(seed.seq % 60).padStart(2, '0')}.000Z`,
      seed.seq,
    ],
  );
}

/** A climb's indexed holds as `[holdId, role]` pairs, or null when it has no hold set. */
export async function holdSetOf(db: TestSqliteDb, uuid: string): Promise<[number, number][] | null> {
  const row = await db.getFirstAsync<{ holds: Uint8Array }>(
    `SELECT hs.holds FROM holds_index_climbs hic JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id WHERE hic.uuid = ?`,
    [uuid],
  );
  return row ? decodeHoldSet(row.holds).map(({ holdId, role }) => [holdId, role]) : null;
}

/** Every posting of a layout as hold id → sorted climb uuids. */
export async function postingsOf(
  db: TestSqliteDb,
  boardType: string,
  layoutId: number,
): Promise<Map<number, string[]>> {
  const idToUuid = new Map(
    (await db.getAllAsync<{ id: number; uuid: string }>('SELECT id, uuid FROM holds_index_climbs')).map((row) => [
      row.id,
      row.uuid,
    ]),
  );
  const rows = await db.getAllAsync<{ hold_id: number; climb_ids: Uint8Array }>(
    'SELECT hold_id, climb_ids FROM board_climb_hold_postings WHERE board_type = ? AND layout_id = ? ORDER BY hold_id',
    [boardType, layoutId],
  );
  return new Map(
    rows.map((row) => [
      row.hold_id,
      [...decodePostings(row.climb_ids)].map((id) => idToUuid.get(id) ?? `#${id}`).sort(),
    ]),
  );
}

/**
 * The index invariant: a layout's stored postings are exactly the inverse of the
 * hold sets of that layout's climbs, each posting sorted and duplicate-free.
 */
export async function expectPostingsMatchHoldSets(
  db: TestSqliteDb,
  boardType: string,
  layoutId: number,
): Promise<void> {
  const rows = await db.getAllAsync<{ id: number; holds: Uint8Array }>(
    `SELECT hic.id, hs.holds FROM board_climb_hold_sets hs
     JOIN holds_index_climbs hic ON hic.id = hs.climb_id
     JOIN board_climbs c ON c.uuid = hic.uuid
     WHERE c.board_type = ? AND c.layout_id = ?`,
    [boardType, layoutId],
  );
  const expected = new Map<number, number[]>();
  for (const row of rows) {
    for (const holdId of decodeHoldSetIds(row.holds)) expected.set(holdId, [...(expected.get(holdId) ?? []), row.id]);
  }
  const stored = await db.getAllAsync<{ hold_id: number; climb_ids: Uint8Array }>(
    'SELECT hold_id, climb_ids FROM board_climb_hold_postings WHERE board_type = ? AND layout_id = ?',
    [boardType, layoutId],
  );
  const actual = new Map(stored.map((row) => [row.hold_id, [...decodePostings(row.climb_ids)]]));
  for (const ids of actual.values()) expect(ids).toEqual([...new Set(ids)].sort((left, right) => left - right));
  expect(new Map([...actual].map(([holdId, ids]) => [holdId, [...ids].sort((l, r) => l - r)]))).toEqual(
    new Map([...expected].map(([holdId, ids]) => [holdId, [...ids].sort((l, r) => l - r)])),
  );
}
