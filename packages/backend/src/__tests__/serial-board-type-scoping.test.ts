import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { findActiveBoardsBySerial, findChosenBoardForSerial } from '../graphql/resolvers/board-presence/shared';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';

/**
 * Aurora runs a SEPARATE serial sequence per board app, so a Kilter `#12345`
 * and a Tension `#12345` are two different physical controllers. Reported from
 * Benchmark Climbing: connecting the gym's Tension board announced "this is a
 * Kilter board" on every attempt, because every serial lookup matched on the
 * serial alone and picked up a stranger's Kilter board that happened to share it.
 *
 * The BLE advertisement always carries the type (`Tension Board#12345@3`), so
 * the fix threads that advertised type into each lookup. These tests pin both
 * halves: the scoped reads, and the two unique indexes that used to treat a bare
 * serial as an identity.
 */

const OWNER = 'serial-type-scope-owner';
const SHARED_SERIAL = 'SERIALSCOPE-12345';

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function insertBoard(opts: {
  boardType: string;
  name: string;
  serial: string | null;
  ownerId?: string;
}): Promise<{ id: number; uuid: string }> {
  const uuid = uuidv4();
  const [row] = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${opts.ownerId ?? OWNER}, ${opts.boardType}, 1, 10, ${'1,2'},
            ${opts.name}, ${opts.serial}, true, now(), now())
    RETURNING id
  `);
  return { id: Number((row as { id: number }).id), uuid };
}

function insertSerialRecording(opts: { boardName: string; serial: string; boardUuid: string | null }) {
  return db.execute(sql`
    INSERT INTO user_board_serials
      (user_id, serial_number, board_name, layout_id, size_id, set_ids, board_uuid, created_at, updated_at)
    VALUES (${OWNER}, ${opts.serial}, ${opts.boardName}, 1, 10, ${'1,2'}, ${opts.boardUuid}, now(), now())
  `);
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE "user_board_serials" RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE "user_boards" RESTART IDENTITY CASCADE`);
  await insertUser(OWNER);
});

describe('findActiveBoardsBySerial — advertised board type scoping', () => {
  it('returns only boards of the advertised type', async () => {
    const kilter = await insertBoard({ boardType: 'kilter', name: 'Someone else Kilter', serial: SHARED_SERIAL });
    const tension = await insertBoard({ boardType: 'tension', name: 'Benchmark Tension', serial: SHARED_SERIAL });

    const candidates = await findActiveBoardsBySerial(SHARED_SERIAL, db, 'tension');

    expect(candidates.map((candidate) => candidate.id)).toEqual([tension.id]);
    expect(candidates.map((candidate) => candidate.id)).not.toContain(kilter.id);
  });

  it('collapses a would-be disambiguation prompt to a single candidate', async () => {
    // Both rows carry the serial, so the type-blind read returned two and the
    // client had to ask which wall the climber was at. Only one is a Tension
    // controller, so with the advertised type there is nothing to ask about.
    await insertBoard({ boardType: 'kilter', name: 'Kilter twin', serial: SHARED_SERIAL });
    await insertBoard({ boardType: 'tension', name: 'Tension twin', serial: SHARED_SERIAL });

    expect(await findActiveBoardsBySerial(SHARED_SERIAL, db)).toHaveLength(2);
    expect(await findActiveBoardsBySerial(SHARED_SERIAL, db, 'tension')).toHaveLength(1);
  });

  it('keeps the type-blind result for clients that send no advertised type', async () => {
    // Binaries shipped before this fix omit the argument; they must behave
    // exactly as they did rather than silently losing candidates.
    await insertBoard({ boardType: 'kilter', name: 'Kilter twin', serial: SHARED_SERIAL });
    await insertBoard({ boardType: 'tension', name: 'Tension twin', serial: SHARED_SERIAL });

    const candidates = await findActiveBoardsBySerial(SHARED_SERIAL, db);

    expect(candidates.map((candidate) => candidate.boardType).sort()).toEqual(['kilter', 'tension']);
  });

  it('returns nothing when no board of the advertised type carries the serial', async () => {
    // The caller then falls through to its zero-candidate path and binds/creates
    // the climber's own board, which is what an unknown serial has always done.
    await insertBoard({ boardType: 'kilter', name: 'Kilter only', serial: SHARED_SERIAL });

    expect(await findActiveBoardsBySerial(SHARED_SERIAL, db, 'tension')).toEqual([]);
  });
});

describe('findChosenBoardForSerial — advertised board type scoping', () => {
  it('ignores a remembered pointer that names another board type', async () => {
    // This is the sticky half of the bug: the remembered choice short-circuits
    // candidate resolution entirely, so a Kilter pointer kept winning on every
    // Tension connect no matter how the candidates were filtered.
    const kilter = await insertBoard({ boardType: 'kilter', name: 'Remembered Kilter', serial: SHARED_SERIAL });
    await insertSerialRecording({ boardName: 'kilter', serial: SHARED_SERIAL, boardUuid: kilter.uuid });

    expect(await findChosenBoardForSerial(OWNER, SHARED_SERIAL, 'tension')).toBeUndefined();
  });

  it('returns the pointer recorded for the advertised type', async () => {
    const kilter = await insertBoard({ boardType: 'kilter', name: 'Remembered Kilter', serial: SHARED_SERIAL });
    const tension = await insertBoard({ boardType: 'tension', name: 'Remembered Tension', serial: SHARED_SERIAL });
    await insertSerialRecording({ boardName: 'kilter', serial: SHARED_SERIAL, boardUuid: kilter.uuid });
    await insertSerialRecording({ boardName: 'tension', serial: SHARED_SERIAL, boardUuid: tension.uuid });

    const chosen = await findChosenBoardForSerial(OWNER, SHARED_SERIAL, 'tension');

    expect(chosen?.id).toBe(tension.id);
    expect(chosen?.boardType).toBe('tension');
  });

  it('rejects a legacy row whose board_name disagrees with the board it points at', async () => {
    // `board_name` is what the client reported at connect time and the pointer
    // was written separately, so rows predating the fix can disagree. The
    // board's own type is authoritative.
    const kilter = await insertBoard({ boardType: 'kilter', name: 'Mislabelled', serial: SHARED_SERIAL });
    await insertSerialRecording({ boardName: 'tension', serial: SHARED_SERIAL, boardUuid: kilter.uuid });

    expect(await findChosenBoardForSerial(OWNER, SHARED_SERIAL, 'tension')).toBeUndefined();
  });

  it('still returns the pointer for clients that send no advertised type', async () => {
    const kilter = await insertBoard({ boardType: 'kilter', name: 'Remembered Kilter', serial: SHARED_SERIAL });
    await insertSerialRecording({ boardName: 'kilter', serial: SHARED_SERIAL, boardUuid: kilter.uuid });

    expect((await findChosenBoardForSerial(OWNER, SHARED_SERIAL))?.id).toBe(kilter.id);
  });
});

describe('serial uniqueness is scoped to a board type', () => {
  it('lets one owner hold a Kilter and a Tension board on the same serial', async () => {
    // user_boards_unique_owner_serial used to key on (owner, serial), so the
    // second board was rejected as a duplicate and the board create/edit form
    // reported "already registered to another board".
    await insertBoard({ boardType: 'kilter', name: 'Home Kilter', serial: SHARED_SERIAL });
    await insertBoard({ boardType: 'tension', name: 'Gym Tension', serial: SHARED_SERIAL });

    const [row] = await db.execute(sql`
      SELECT count(*)::int AS count FROM user_boards
       WHERE owner_id = ${OWNER} AND serial_number = ${SHARED_SERIAL}
    `);
    expect(Number((row as { count: number }).count)).toBe(2);
  });

  it('still blocks one owner binding a serial twice within a board type', async () => {
    await insertBoard({ boardType: 'kilter', name: 'Home Kilter', serial: SHARED_SERIAL });

    await expect(
      insertBoard({ boardType: 'kilter', name: 'Duplicate Kilter', serial: SHARED_SERIAL }),
    ).rejects.toThrow();
  });

  it('keeps a recording per board type for one serial', async () => {
    // user_board_serials_unique_user_serial used to key on (user, serial), so
    // connecting the Tension controller silently overwrote the Kilter recording.
    await insertSerialRecording({ boardName: 'kilter', serial: SHARED_SERIAL, boardUuid: null });
    await insertSerialRecording({ boardName: 'tension', serial: SHARED_SERIAL, boardUuid: null });

    const [row] = await db.execute(sql`
      SELECT count(*)::int AS count FROM user_board_serials
       WHERE user_id = ${OWNER} AND serial_number = ${SHARED_SERIAL}
    `);
    expect(Number((row as { count: number }).count)).toBe(2);
  });

  it('still blocks two recordings for one serial on the same board type', async () => {
    await insertSerialRecording({ boardName: 'kilter', serial: SHARED_SERIAL, boardUuid: null });

    await expect(
      insertSerialRecording({ boardName: 'kilter', serial: SHARED_SERIAL, boardUuid: null }),
    ).rejects.toThrow();
  });
});

describe('boardsBySerialNumbers — advertised board type scoping', () => {
  // Anonymous: the resolver answers straight from the board rows, so the test
  // exercises the lookup itself without dragging in owner/stats enrichment.
  const anonCtx = () => ({ connectionId: 'serial-scope-conn', isAuthenticated: false }) as ConnectionContext;

  it('returns only boards of the requested type', async () => {
    await insertBoard({ boardType: 'kilter', name: 'Kilter twin', serial: SHARED_SERIAL });
    await insertBoard({ boardType: 'tension', name: 'Tension twin', serial: SHARED_SERIAL });

    const boards = await socialBoardQueries.boardsBySerialNumbers(
      null,
      { serialNumbers: [SHARED_SERIAL], boardType: 'tension' },
      anonCtx(),
    );

    expect(boards.map((board) => board.boardType)).toEqual(['tension']);
  });

  it('returns every type when the caller sends no board type', async () => {
    await insertBoard({ boardType: 'kilter', name: 'Kilter twin', serial: SHARED_SERIAL });
    await insertBoard({ boardType: 'tension', name: 'Tension twin', serial: SHARED_SERIAL });

    const boards = await socialBoardQueries.boardsBySerialNumbers(null, { serialNumbers: [SHARED_SERIAL] }, anonCtx());

    expect(boards.map((board) => board.boardType).sort()).toEqual(['kilter', 'tension']);
  });
});
