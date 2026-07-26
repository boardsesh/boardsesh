import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { boardSharedSyncs } from '@boardsesh/db/schema';
import {
  SHARED_SYNC_COOLDOWN_CURSOR,
  claimSharedSyncSlot,
  readSharedSyncCursor,
  stampSharedSyncFinished,
} from '@boardsesh/db/queries';

// ---------------------------------------------------------------------------
// Persisted shared/catalog-sync cooldown (real DB) — #3539
//
// The cooldown used to be an in-memory Map on the SyncRunner. That failed two
// ways: a restart emptied it, so the first cycle after every deploy re-fired a
// full shared sync per board; and two overlapping containers each had their
// own, so both ran the same board-wide sync at once. Because new-climb
// detection is a pre-read of which climb uuids already exist, two simultaneous
// runs both classify the same climbs as new and both insert a full set of "new
// climbs from <setter>" notifications.
//
// claimSharedSyncSlot is a single-statement compare-and-set on a synthetic
// board_shared_syncs cursor, so the read and the write cannot be split. THIS is
// the correctness guarantee — the daemon lease is best-effort and can be held
// by two instances at once during a stall.
// ---------------------------------------------------------------------------

const BOARD = 'cooldown-cas-test-board';
const COOLDOWN_MS = 60 * 60 * 1000;
const CURSOR = { boardType: BOARD, cursorName: SHARED_SYNC_COOLDOWN_CURSOR };

async function clearFixtures(): Promise<void> {
  await db.delete(boardSharedSyncs).where(eq(boardSharedSyncs.boardType, BOARD));
}

/** Backdate the cursor so the cooldown reads as elapsed, without waiting an hour. */
async function backdateCursor(interval: string): Promise<void> {
  await db
    .update(boardSharedSyncs)
    .set({
      lastSynchronizedAt: sql`to_char((now() at time zone 'utc') - ${sql.raw(interval)}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .where(and(eq(boardSharedSyncs.boardType, BOARD), eq(boardSharedSyncs.tableName, SHARED_SYNC_COOLDOWN_CURSOR)));
}

describe('shared-sync cooldown compare-and-set (real DB)', () => {
  beforeEach(clearFixtures);
  afterEach(clearFixtures);

  it('claims a cursor that has never run, then refuses the immediate second claim', async () => {
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(false);
  });

  it('survives a restart: a fresh process claims nothing while the cursor is warm', async () => {
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);

    // Nothing is carried in memory — a brand-new SyncRunner in a brand-new
    // container asks the same question of the same row and is turned away. This
    // is the "every deploy re-fires a full shared sync" half of the bug.
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(false);
  });

  it('re-claims once the cooldown has elapsed', async () => {
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);
    await backdateCursor(`interval '90 minutes'`);
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);
  });

  it('exactly one of five parallel claims wins on a cold cursor', async () => {
    // A genuine race across five pool connections. Nothing here is serialised
    // by the test: if the claim were a read-then-write (as the weekly-gate
    // helper is) several of these would win.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('exactly one of five parallel claims wins on a cursor whose cooldown just elapsed', async () => {
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);
    await backdateCursor(`interval '90 minutes'`);

    // The UPDATE path of the CAS, not the INSERT path — the case two
    // overlapping daemons actually hit an hour after the last run.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('re-stamps on completion so the cooldown runs from the end of the work', async () => {
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);
    const atClaim = await readSharedSyncCursor(db, CURSOR);
    expect(atClaim).not.toBeNull();

    // A long shared sync: pretend it ran for 20 minutes, then finish.
    await backdateCursor(`interval '20 minutes'`);
    await stampSharedSyncFinished(db, CURSOR);

    const atFinish = await readSharedSyncCursor(db, CURSOR);
    expect(atFinish).not.toBeNull();
    expect(atFinish!.getTime()).toBeGreaterThan(atClaim!.getTime() - 60_000);
    // And the full cooldown still applies from the finish, not the start.
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(false);
  });

  it('keeps different boards independent', async () => {
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBe(true);
    // A second board's cursor is a different row and must not be throttled by
    // the first — the runners key the cursor per board.
    const otherBoard = { boardType: `${BOARD}-2`, cursorName: SHARED_SYNC_COOLDOWN_CURSOR };
    try {
      expect(await claimSharedSyncSlot(db, { ...otherBoard, cooldownMs: COOLDOWN_MS })).toBe(true);
    } finally {
      await db.delete(boardSharedSyncs).where(eq(boardSharedSyncs.boardType, otherBoard.boardType));
    }
  });
});
