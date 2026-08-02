import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { findOwnActiveBoardByConfig } from '../graphql/resolvers/board-presence/shared';

/**
 * #4166 dropped the per-owner config unique index, so one owner can now hold
 * several boards of the same configuration — the same MoonBoard 2024 at home and
 * at a gym. `findOwnActiveBoardByConfig` backs the BLE serial-bind path, and it
 * was `.limit(1)` with no ordering, so with two such boards the pick was
 * arbitrary. Two user-visible failures followed:
 *
 *  - picking the board bound to the OTHER controller made `bindOrCreateOwnBoardForSerial`
 *    throw "already linked to another wall serial" — the climber simply could not
 *    connect to their own board;
 *  - picking the wrong unbound board stamped this wall's serial onto it, silently
 *    misattributing every later presence event and tick.
 *
 * The lookup now takes the serial and prefers: bound-to-it → unbound → bound
 * elsewhere, with `id` breaking ties so repeat calls agree.
 */

const OWNER = 'serial-pref-owner';

const CONFIG = { boardType: 'kilter', layoutId: 1, sizeId: 42, setIds: '1,2' };

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function insertBoard(opts: { name: string; serial: string | null }): Promise<number> {
  const uuid = uuidv4();
  const [row] = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${OWNER}, ${CONFIG.boardType}, ${CONFIG.layoutId}, ${CONFIG.sizeId}, ${CONFIG.setIds},
            ${opts.name}, ${opts.serial}, true, now(), now())
    RETURNING id
  `);
  return Number((row as { id: number }).id);
}

const lookup = (preferredSerial?: string) =>
  findOwnActiveBoardByConfig(OWNER, CONFIG.boardType, CONFIG.layoutId, CONFIG.sizeId, CONFIG.setIds, preferredSerial);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE "user_boards" RESTART IDENTITY CASCADE`);
  await insertUser(OWNER);
});

describe('findOwnActiveBoardByConfig — serial preference across same-config boards', () => {
  it('returns the board already bound to this serial, not an arbitrary sibling', async () => {
    // Insert the bound board SECOND so an unordered `.limit(1)` would tend to
    // return the other one.
    const homeId = await insertBoard({ name: 'Home wall', serial: null });
    const gymId = await insertBoard({ name: 'Gym wall', serial: 'GYM-SERIAL' });

    const found = await lookup('GYM-SERIAL');
    expect(found?.id).toBe(gymId);
    expect(found?.id).not.toBe(homeId);
  });

  it('prefers an UNBOUND board over one bound to a different serial', async () => {
    // The reported break: connecting a second wall used to hit the board bound to
    // the first controller and throw "already linked to another wall serial",
    // locking the climber out of a board they own and could legitimately bind.
    const boundElsewhereId = await insertBoard({ name: 'Home wall', serial: 'HOME-SERIAL' });
    const freeId = await insertBoard({ name: 'Gym wall', serial: null });

    const found = await lookup('GYM-SERIAL');
    expect(found?.id).toBe(freeId);
    expect(found?.serialNumber).toBeNull();
    expect(found?.id).not.toBe(boundElsewhereId);
  });

  it('falls back to a board bound elsewhere only when nothing better exists', async () => {
    // This is the genuine "already linked to another wall" case, and the caller
    // still needs to see it so it can refuse.
    const boundElsewhereId = await insertBoard({ name: 'Home wall', serial: 'HOME-SERIAL' });

    const found = await lookup('GYM-SERIAL');
    expect(found?.id).toBe(boundElsewhereId);
    expect(found?.serialNumber).toBe('HOME-SERIAL');
  });

  it('is deterministic across repeat calls when several boards are unbound', async () => {
    // Nondeterminism here meant the serial could land on a different board each
    // attempt. Lowest id wins, consistently.
    const firstId = await insertBoard({ name: 'Wall A', serial: null });
    await insertBoard({ name: 'Wall B', serial: null });

    expect((await lookup('NEW-SERIAL'))?.id).toBe(firstId);
    expect((await lookup('NEW-SERIAL'))?.id).toBe(firstId);
  });

  it('still finds the single board when the owner has only one', async () => {
    const onlyId = await insertBoard({ name: 'Only wall', serial: null });
    expect((await lookup('ANY-SERIAL'))?.id).toBe(onlyId);
    // And without a preferred serial at all (the pre-existing call shape).
    expect((await lookup())?.id).toBe(onlyId);
  });

  it('ignores soft-deleted boards', async () => {
    const liveId = await insertBoard({ name: 'Live wall', serial: null });
    const deletedId = await insertBoard({ name: 'Deleted wall', serial: 'GYM-SERIAL' });
    await db.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE id = ${deletedId}`);

    // Even though the deleted one carries the exact serial.
    expect((await lookup('GYM-SERIAL'))?.id).toBe(liveId);
  });
});
