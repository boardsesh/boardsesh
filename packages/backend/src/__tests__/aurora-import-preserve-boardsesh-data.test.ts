import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { clearAuroraBoardData, countBoardseshOwnedRows, recomputeClimbStatsBulk } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { setupWorkerDatabase } from './worker-db';

/**
 * #3540 — the direct-Aurora unified importer (import-aurora-board-unified.ts)
 * refreshes a whole board by clearing it and re-inserting the catalog dump. The
 * clear must replace the UPSTREAM catalog wholesale WITHOUT destroying
 * Boardsesh-owned rows the dump can never restore: user-created climbs (incl.
 * drafts) with their holds/stats, and Boardsesh-attached beta links.
 *
 * These tests exercise the extracted, provenance-scoped clear against a real
 * database on a synthetic board_type so they never touch other boards' data.
 */

const BOARD = 'aurora3540test';
const OWNER_ID = 'ai3540-owner';
const SENDER_A = 'ai3540-sender-a';
const SENDER_B = 'ai3540-sender-b';

// db is a postgres-js drizzle handle; clearAuroraBoardData / recomputeClimbStatsBulk
// take the shared PgDatabase surface. The casts only cross the generic boundary.
type ClearDb = Parameters<typeof clearAuroraBoardData>[0];
type RecomputeDb = Parameters<typeof recomputeClimbStatsBulk>[0];

async function seedUser(id: string, name: string) {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${name}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertClimb(uuid: string, userId: string | null, isDraft: boolean, angle: number, synced = true) {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed,
       user_id, synced, angle, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES
      (${uuid}, ${BOARD}, 1, ${'climb-' + uuid}, 'p1r1', 1, ${isDraft}, ${!isDraft},
       ${userId}, ${synced}, ${angle}, 0, 100, 0, 150, '2024-01-01')
  `);
}

async function insertHistory(uuid: string, angle: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats_history (board_type, climb_uuid, angle, ascensionist_count)
    VALUES (${BOARD}, ${uuid}, ${angle}, 1)
  `);
}

async function insertHold(uuid: string, holdId: number) {
  await db.execute(sql`
    INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
    VALUES (${BOARD}, ${uuid}, ${holdId}, 0, 'HAND')
  `);
}

async function insertStats(
  uuid: string,
  angle: number,
  upstream: number | null,
  boardsesh: number | null,
  total: number | null,
) {
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count)
    VALUES (${BOARD}, ${uuid}, ${angle}, ${total}, ${upstream}, ${boardsesh})
  `);
}

async function insertBetaLink(uuid: string, link: string, createdBy: string | null) {
  await db.execute(sql`
    INSERT INTO board_beta_links (board_type, climb_uuid, link, created_by_user_id)
    VALUES (${BOARD}, ${uuid}, ${link}, ${createdBy})
  `);
}

async function insertSendTick(uuid: string, angle: number, userId: string, tickUuid: string) {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, origin, status, attempt_count, climbed_at)
    VALUES (${tickUuid}, ${userId}, ${BOARD}, ${uuid}, ${angle}, 'native', 'send', 1, '2026-06-01 10:00:00')
  `);
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number | string }>;
  const list = Array.isArray(rows) ? rows : (((rows as { rows?: unknown[] }).rows as typeof rows) ?? []);
  return Number(list[0]?.n ?? 0);
}

async function runClear() {
  // The clear's SET LOCAL suppress_sync_tombstones needs a real transaction (the
  // deletion-tombstone triggers live in the test schema), mirroring the importer.
  await db.transaction(async (tx) => {
    await clearAuroraBoardData(tx as unknown as ClearDb, BOARD);
  });
}

beforeAll(async () => {
  await setupWorkerDatabase();
  await seedUser(OWNER_ID, 'Owner 3540');
  await seedUser(SENDER_A, 'Sender A 3540');
  await seedUser(SENDER_B, 'Sender B 3540');
});

afterEach(async () => {
  // Synthetic board — tear down every table we seed (FK-safe order).
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE board_type = ${BOARD}`);
  await db.execute(sql`DELETE FROM board_beta_links WHERE board_type = ${BOARD}`);
  await db.execute(sql`DELETE FROM board_climb_holds WHERE board_type = ${BOARD}`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE board_type = ${BOARD}`);
  await db.execute(sql`DELETE FROM board_climb_stats_history WHERE board_type = ${BOARD}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE board_type = ${BOARD}`);
});

describe('aurora import — #3540 clear preserves Boardsesh-owned data', () => {
  it('deletes upstream climbs but preserves user-created climbs, their holds, stats and history', async () => {
    // Upstream catalog climb (dump-owned) + one Boardsesh-owned draft climb.
    await insertClimb('u1', null, false, 40);
    await insertHold('u1', 10);
    await insertStats('u1', 40, 3, null, 3);
    await insertHistory('u1', 40);

    await insertClimb('o1', OWNER_ID, true, 30);
    await insertHold('o1', 20);
    await insertHold('o1', 21);
    await insertStats('o1', 30, null, null, null);
    await insertHistory('o1', 30);

    // The invariant snapshot must see every preserved row class, not just climbs.
    const before = await countBoardseshOwnedRows(db as unknown as ClearDb, BOARD);
    expect(before.ownedClimbs).toBe(1);
    expect(before.ownedHolds).toBe(2);
    expect(before.ownedStats).toBe(1);
    expect(before.ownedStatsHistory).toBe(1);

    await runClear();

    // Upstream climb + its holds + its stats + its history are all gone.
    expect(
      await scalar(sql`SELECT count(*)::int AS n FROM board_climbs WHERE board_type = ${BOARD} AND uuid = 'u1'`),
    ).toBe(0);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_holds WHERE board_type = ${BOARD} AND climb_uuid = 'u1'`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats WHERE board_type = ${BOARD} AND climb_uuid = 'u1'`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats_history WHERE board_type = ${BOARD} AND climb_uuid = 'u1'`,
      ),
    ).toBe(0);

    // The user-created draft climb, its two holds, its stats and its history survive.
    const ownedClimbs = await scalar(
      sql`SELECT count(*)::int AS n FROM board_climbs WHERE board_type = ${BOARD} AND uuid = 'o1' AND user_id = ${OWNER_ID}`,
    );
    expect(ownedClimbs).toBe(1);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_holds WHERE board_type = ${BOARD} AND climb_uuid = 'o1'`,
      ),
    ).toBe(2);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats WHERE board_type = ${BOARD} AND climb_uuid = 'o1'`,
      ),
    ).toBe(1);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats_history WHERE board_type = ${BOARD} AND climb_uuid = 'o1'`,
      ),
    ).toBe(1);
  });

  it('preserves an account-deleted user’s published climb (user_id NULL, synced=false) with its holds/stats/history', async () => {
    // deleteAccount nulls user_id on published climbs (ON DELETE SET NULL) to
    // preserve them, but leaves synced=false. A user_id-only predicate would
    // treat this as upstream and delete it; the synced=false marker must save it.
    await insertClimb('u1', null, false, 40); // genuine upstream (synced=true)
    await insertHold('u1', 10);

    await insertClimb('anon', null, false, 30, /* synced */ false); // anonymized owned
    await insertHold('anon', 20);
    await insertStats('anon', 30, null, null, null);
    await insertHistory('anon', 30);

    const before = await countBoardseshOwnedRows(db as unknown as ClearDb, BOARD);
    expect(before.ownedClimbs).toBe(1);
    expect(before.ownedHolds).toBe(1);
    expect(before.ownedStats).toBe(1);
    expect(before.ownedStatsHistory).toBe(1);

    await runClear();

    // The anonymized published climb and all its dependent rows survive.
    expect(
      await scalar(sql`SELECT count(*)::int AS n FROM board_climbs WHERE board_type = ${BOARD} AND uuid = 'anon'`),
    ).toBe(1);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_holds WHERE board_type = ${BOARD} AND climb_uuid = 'anon'`,
      ),
    ).toBe(1);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats WHERE board_type = ${BOARD} AND climb_uuid = 'anon'`,
      ),
    ).toBe(1);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats_history WHERE board_type = ${BOARD} AND climb_uuid = 'anon'`,
      ),
    ).toBe(1);

    // The genuine upstream climb is still cleared.
    expect(
      await scalar(sql`SELECT count(*)::int AS n FROM board_climbs WHERE board_type = ${BOARD} AND uuid = 'u1'`),
    ).toBe(0);
  });

  it('preserves Boardsesh-attached beta links but clears upstream beta links', async () => {
    // A boardsesh user can attach a link to an upstream climb — that link is
    // Boardsesh-owned and the dump can never restore it.
    await insertClimb('u1', null, false, 40);
    await insertBetaLink('u1', 'https://upstream.example/beta', null);
    await insertBetaLink('u1', 'https://instagram.example/boardsesh-beta', OWNER_ID);

    const before = await countBoardseshOwnedRows(db as unknown as ClearDb, BOARD);
    expect(before.boardseshBetaLinks).toBe(1);

    await runClear();

    const remaining = (await db.execute(sql`
      SELECT link, created_by_user_id AS "createdBy"
      FROM board_beta_links WHERE board_type = ${BOARD}
    `)) as unknown as Array<{ link: string; createdBy: string | null }>;
    const list = Array.isArray(remaining)
      ? remaining
      : (((remaining as { rows?: unknown[] }).rows as typeof remaining) ?? []);

    expect(list).toHaveLength(1);
    expect(list[0]?.link).toBe('https://instagram.example/boardsesh-beta');
    expect(list[0]?.createdBy).toBe(OWNER_ID);
  });

  it('self-heals boardsesh_ascensionist_count from surviving ticks after clear + upstream-only reinsert', async () => {
    // A published upstream climb with an accrued Boardsesh count, plus two native
    // sends by distinct users (the ticks that back that count).
    await insertClimb('u2', null, false, 40);
    await insertStats('u2', 40, 5, 2, 7);
    await insertSendTick('u2', 40, SENDER_A, 'tick-a');
    await insertSendTick('u2', 40, SENDER_B, 'tick-b');

    // The clear drops the upstream climb + its stats; the ticks have no FK to the
    // climb, so they survive (orphaned, exactly as in prod).
    await runClear();
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM board_climb_stats WHERE board_type = ${BOARD} AND climb_uuid = 'u2'`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        sql`SELECT count(*)::int AS n FROM boardsesh_ticks WHERE board_type = ${BOARD} AND climb_uuid = 'u2'`,
      ),
    ).toBe(2);

    // Mimic the importer: re-insert the upstream climb + upstream-only stats
    // (boardsesh term reset), then run the same recompute the importer runs.
    await insertClimb('u2', null, false, 40);
    await insertStats('u2', 40, 5, null, 5);
    await recomputeClimbStatsBulk(db as unknown as RecomputeDb, [{ boardType: BOARD, climbUuid: 'u2', angle: 40 }]);

    const stats = (await db.execute(sql`
      SELECT boardsesh_ascensionist_count AS bs, ascensionist_count AS total, upstream_ascensionist_count AS upstream
      FROM board_climb_stats WHERE board_type = ${BOARD} AND climb_uuid = 'u2' AND angle = 40
    `)) as unknown as Array<{ bs: number | string; total: number | string; upstream: number | string }>;
    const list = Array.isArray(stats) ? stats : (((stats as { rows?: unknown[] }).rows as typeof stats) ?? []);

    expect(Number(list[0]?.upstream)).toBe(5);
    expect(Number(list[0]?.bs)).toBe(2);
    expect(Number(list[0]?.total)).toBe(7);
  });
});
