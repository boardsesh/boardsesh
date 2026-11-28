import { beforeEach, describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getBoardCapabilities, HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES } from '@boardsesh/board-config';
import { runMigrations, ensureMutationQueueTable } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { boardHidesWithdrawnClimbs, WITHDRAWN_TOMBSTONE_BOARD_TYPES } from '@boardsesh/offline-sync/withdrawn-climb';
import { isClimbWithdrawn } from '../withdrawn-climb';

describe('the offline-sync board list', () => {
  it('mirrors the capability table exactly', () => {
    // offline-sync cannot import board-config, so it carries its own copy. A board
    // that starts hiding withdrawn climbs must be added to both.
    expect([...WITHDRAWN_TOMBSTONE_BOARD_TYPES]).toEqual([...HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES]);
    for (const boardName of SUPPORTED_BOARDS) {
      expect(boardHidesWithdrawnClimbs(boardName)).toBe(
        getBoardCapabilities(boardName).withdrawnCatalogClimbs === 'hidden',
      );
    }
  });
});

describe('isClimbWithdrawn', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    const tombstone = (uuid: string, boardType: string, frames: string | null) =>
      db.runAsync(
        `INSERT INTO board_climbs (uuid, board_type, layout_id, is_listed, is_hidden, is_boardsesh_authored, frames)
         VALUES (?, ?, 1, 0, 1, 0, ?)`,
        [uuid, boardType, frames],
      );
    await tombstone('quantum-tombstone', 'quantum', null);
    await tombstone('quantum-with-holds', 'quantum', 'p1r12');
    await tombstone('moonboard-shaped', 'moonboard', null);
  });

  it('reads the tombstone on a board that hides withdrawn climbs', async () => {
    expect(await isClimbWithdrawn('quantum-tombstone', db)).toBe(true);
  });

  it('keeps a row that still has holds, as the app always did', async () => {
    expect(await isClimbWithdrawn('quantum-with-holds', db)).toBe(false);
  });

  it('never reports a withdrawn climb on a board that keeps them readable', async () => {
    expect(await isClimbWithdrawn('moonboard-shaped', db)).toBe(false);
  });

  it('reads a climb the device has never downloaded as available', async () => {
    expect(await isClimbWithdrawn('unknown', db)).toBe(false);
  });
});
