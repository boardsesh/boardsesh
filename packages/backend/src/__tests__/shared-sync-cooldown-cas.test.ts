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
const DB_CLOCK_TOLERANCE_MS = 5_000;

async function claimCursor(): Promise<string> {
  const claimToken = await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS });
  expect(claimToken).not.toBeNull();
  if (claimToken === null) throw new Error('Expected the shared-sync cooldown claim to succeed');
  return claimToken;
}

async function clearFixtures(): Promise<void> {
  await db.delete(boardSharedSyncs).where(eq(boardSharedSyncs.boardType, BOARD));
}

async function readRawCursor(): Promise<string | null> {
  const rows = await db
    .select({ lastSynchronizedAt: boardSharedSyncs.lastSynchronizedAt })
    .from(boardSharedSyncs)
    .where(and(eq(boardSharedSyncs.boardType, BOARD), eq(boardSharedSyncs.tableName, SHARED_SYNC_COOLDOWN_CURSOR)));
  return rows[0]?.lastSynchronizedAt ?? null;
}

function expectMarkerNear(marker: Date | null, expectedAtMs: number): void {
  expect(marker).not.toBeNull();
  if (marker === null) return;
  expect(Math.abs(marker.getTime() - expectedAtMs)).toBeLessThanOrEqual(DB_CLOCK_TOLERANCE_MS);
}

/** Backdate the cursor so the cooldown reads as elapsed, without waiting an hour. */
async function backdateCursor(interval: string): Promise<void> {
  await db
    .update(boardSharedSyncs)
    .set({
      lastSynchronizedAt: sql`to_char((clock_timestamp() at time zone 'utc') - ${sql.raw(interval)}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .where(and(eq(boardSharedSyncs.boardType, BOARD), eq(boardSharedSyncs.tableName, SHARED_SYNC_COOLDOWN_CURSOR)));
}

describe('shared-sync cooldown compare-and-set (real DB)', () => {
  beforeEach(clearFixtures);
  afterEach(clearFixtures);

  it('claims a cursor that has never run, then refuses the immediate second claim', async () => {
    await claimCursor();
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBeNull();
  });

  it('survives a restart: a fresh process claims nothing while the cursor is warm', async () => {
    await claimCursor();

    // Nothing is carried in memory — a brand-new SyncRunner in a brand-new
    // container asks the same question of the same row and is turned away. This
    // is the "every deploy re-fires a full shared sync" half of the bug.
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBeNull();
  });

  it('re-claims once the cooldown has elapsed', async () => {
    await claimCursor();
    await backdateCursor(`interval '90 minutes'`);
    await claimCursor();
  });

  it('exactly one of five parallel claims wins on a cold cursor', async () => {
    // A genuine race across five pool connections. Nothing here is serialised
    // by the test: if the claim were a read-then-write (as the weekly-gate
    // helper is) several of these would win.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })),
    );

    expect(outcomes.filter((claimToken) => claimToken !== null)).toHaveLength(1);
  });

  it('exactly one of five parallel claims wins on a cursor whose cooldown just elapsed', async () => {
    await claimCursor();
    await backdateCursor(`interval '90 minutes'`);

    // The UPDATE path of the CAS, not the INSERT path — the case two
    // overlapping daemons actually hit an hour after the last run.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })),
    );

    expect(outcomes.filter((claimToken) => claimToken !== null)).toHaveLength(1);
  });

  it('re-stamps on completion so the cooldown runs from the end of the work', async () => {
    const claimToken = await claimCursor();
    const completionStartedAtMs = Date.now();
    expect(
      await stampSharedSyncFinished(db, {
        ...CURSOR,
        claimToken,
        fullCooldownMs: COOLDOWN_MS,
      }),
    ).toBe(true);

    const atFinish = await readSharedSyncCursor(db, CURSOR);
    expectMarkerNear(atFinish, completionStartedAtMs);
    expect(await readRawCursor()).toContain('#finished:');
    // And the full cooldown still applies from the finish, not the start.
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBeNull();
  });

  it('allows exactly one parallel finisher to consume a claim token', async () => {
    const claimToken = await claimCursor();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        stampSharedSyncFinished(db, {
          ...CURSOR,
          claimToken,
          fullCooldownMs: COOLDOWN_MS,
        }),
      ),
    );

    expect(outcomes.filter((finalized) => finalized)).toHaveLength(1);
  });

  it('rejects a stale finisher when duplicate skewed client timestamps are reused', async () => {
    // This is the adversarial case the old client-clock token could not fence:
    // both claims were minted from the same millisecond in 2099, so the stale
    // token equalled the replacement token. The `now` compatibility input is
    // deliberately ignored; Postgres supplies both time and a fresh UUID.
    const duplicateSkewedClientNow = new Date('2099-01-01T00:00:00.123Z');
    const staleClaimToken = await claimSharedSyncSlot(db, {
      ...CURSOR,
      cooldownMs: COOLDOWN_MS,
      now: duplicateSkewedClientNow,
    });
    if (staleClaimToken === null) throw new Error('Expected the stale claim to succeed');
    await backdateCursor(`interval '90 minutes'`);
    const currentClaimToken = await claimSharedSyncSlot(db, {
      ...CURSOR,
      cooldownMs: COOLDOWN_MS,
      now: duplicateSkewedClientNow,
    });
    if (currentClaimToken === null) throw new Error('Expected the replacement claim to succeed');

    expect(currentClaimToken).not.toBe(staleClaimToken);
    expect(currentClaimToken).toContain('#claim:');
    expectMarkerNear(await readSharedSyncCursor(db, CURSOR), Date.now());

    expect(
      await stampSharedSyncFinished(db, {
        ...CURSOR,
        claimToken: currentClaimToken,
        fullCooldownMs: COOLDOWN_MS,
        nextCooldownMs: COOLDOWN_MS,
        now: duplicateSkewedClientNow,
      }),
    ).toBe(true);
    const currentFullMarker = await readRawCursor();
    expect(currentFullMarker).toContain('#finished:');

    expect(
      await stampSharedSyncFinished(db, {
        ...CURSOR,
        claimToken: staleClaimToken,
        fullCooldownMs: COOLDOWN_MS,
        nextCooldownMs: 5 * 60 * 1000,
        now: duplicateSkewedClientNow,
      }),
    ).toBe(false);
    expect(await readRawCursor()).toBe(currentFullMarker);
    expect(await claimSharedSyncSlot(db, { ...CURSOR, cooldownMs: COOLDOWN_MS })).toBeNull();
  });

  it('encodes a shorter completion cooldown and clamps it to the configured full cooldown', async () => {
    const claimToken = await claimCursor();
    const transientCompletionStartedAtMs = Date.now();

    expect(
      await stampSharedSyncFinished(db, {
        ...CURSOR,
        claimToken,
        fullCooldownMs: COOLDOWN_MS,
        nextCooldownMs: 5 * 60 * 1000,
      }),
    ).toBe(true);
    expectMarkerNear(
      await readSharedSyncCursor(db, CURSOR),
      transientCompletionStartedAtMs - (COOLDOWN_MS - 5 * 60 * 1000),
    );

    await clearFixtures();
    const shortFullCooldownMs = 60_000;
    const shortClaimToken = await claimSharedSyncSlot(db, {
      ...CURSOR,
      cooldownMs: shortFullCooldownMs,
    });
    if (shortClaimToken === null) throw new Error('Expected the short cooldown claim to succeed');
    const clampedCompletionStartedAtMs = Date.now();

    expect(
      await stampSharedSyncFinished(db, {
        ...CURSOR,
        claimToken: shortClaimToken,
        fullCooldownMs: shortFullCooldownMs,
        nextCooldownMs: 5 * 60 * 1000,
      }),
    ).toBe(true);
    expectMarkerNear(await readSharedSyncCursor(db, CURSOR), clampedCompletionStartedAtMs);
  });

  it('keeps different boards independent', async () => {
    await claimCursor();
    // A second board's cursor is a different row and must not be throttled by
    // the first — the runners key the cursor per board.
    const otherBoard = { boardType: `${BOARD}-2`, cursorName: SHARED_SYNC_COOLDOWN_CURSOR };
    try {
      expect(await claimSharedSyncSlot(db, { ...otherBoard, cooldownMs: COOLDOWN_MS })).not.toBeNull();
    } finally {
      await db.delete(boardSharedSyncs).where(eq(boardSharedSyncs.boardType, otherBoard.boardType));
    }
  });
});
