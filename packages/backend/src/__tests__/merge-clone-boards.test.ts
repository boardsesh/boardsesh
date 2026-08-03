import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { findClonePairs, findSerialBackfills, mergeClonePair, type ClonePair } from '../scripts/merge-clone-boards';

// One physical wall, split across a gym's synced listing and the private
// duplicate an earlier climber's BLE connect minted. The script's job is to put
// the history back on the gym listing without breaking `boardHistory`'s
// seq ordering or the Redis seq counter's durable floor.

const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';
const CLONE_OWNER_ID = 'merge-clone-owner';
const OTHER_USER_ID = 'merge-other-user';
const SLUG_PREFIX = 'merge-clone-test-';

type Board = { id: number; uuid: string };

async function insertBoard(opts: {
  ownerId: string;
  serial: string | null;
  gymId: number | null;
  name: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
}): Promise<Board> {
  const uuid = uuidv4();
  const [row] = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number, gym_id, is_public)
    VALUES (${uuid}, ${`${SLUG_PREFIX}${Math.random().toString(36).slice(2)}`}, ${opts.ownerId}, 'kilter',
            ${opts.layoutId ?? 1}, ${opts.sizeId ?? 10}, ${opts.setIds ?? '1,20'}, ${opts.name},
            ${opts.serial}, ${opts.gymId}, true)
    RETURNING id, uuid
  `);
  return { id: Number((row as { id: number }).id), uuid: (row as { uuid: string }).uuid };
}

async function insertGym(name: string): Promise<number> {
  const [row] = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public)
    VALUES (${uuidv4()}, ${name}, ${`${SLUG_PREFIX}${Math.random().toString(36).slice(2)}`}, ${SYSTEM_OWNER_ID}, true)
    RETURNING id
  `);
  return Number((row as { id: number }).id);
}

async function insertEvent(boardId: number, seq: number, confirmedAt: string, name: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, user_id, seq, name, confirmed_at)
    VALUES (${boardId}, 'kilter', ${`climb-${seq}-${boardId}`}, 40, ${CLONE_OWNER_ID}, ${seq}, ${name}, ${confirmedAt})
  `);
}

async function linkSerial(userId: string, serial: string, boardUuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_board_serials (user_id, serial_number, board_name, layout_id, size_id, set_ids, board_uuid)
    VALUES (${userId}, ${serial}, 'kilter', 1, 10, '1,20', ${boardUuid})
    ON CONFLICT (user_id, serial_number) DO UPDATE SET board_uuid = EXCLUDED.board_uuid
  `);
}

async function eventsOnBoard(boardId: number): Promise<{ seq: number; name: string }[]> {
  const rows = await db.execute(sql`
    SELECT seq, name FROM board_climb_events WHERE board_id = ${boardId} ORDER BY seq
  `);
  return (rows as unknown as { seq: string; name: string }[]).map((row) => ({
    seq: Number(row.seq),
    name: row.name,
  }));
}

async function seedUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${SYSTEM_OWNER_ID}, 'system@boardsesh.com', 'Boardsesh', now(), now()),
           (${CLONE_OWNER_ID}, 'clone-owner@merge.test', 'Clone Owner', now(), now()),
           (${OTHER_USER_ID}, 'other@merge.test', 'Other Climber', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM board_climb_events
     WHERE board_id IN (SELECT id FROM user_boards WHERE slug LIKE ${`${SLUG_PREFIX}%`})
  `);
  await db.execute(sql`DELETE FROM user_boards WHERE slug LIKE ${`${SLUG_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM gyms WHERE slug LIKE ${`${SLUG_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${CLONE_OWNER_ID}, ${OTHER_USER_ID})`);
}

describe('merge-clone-boards', () => {
  beforeEach(async () => {
    await cleanup();
    await seedUsers();
  });

  afterEach(cleanup);

  describe('findClonePairs', () => {
    it('pairs a private duplicate with the gym listing a climber linked the serial to', async () => {
      const serial = `MERGE-${Date.now()}`;
      const gymId = await insertGym('Merge Test Gym');
      const gymBoard = await insertBoard({ ownerId: SYSTEM_OWNER_ID, serial: null, gymId, name: 'Gym - Kilter' });
      const clone = await insertBoard({ ownerId: CLONE_OWNER_ID, serial, gymId: null, name: 'Kilter Board' });
      await linkSerial(OTHER_USER_ID, serial, gymBoard.uuid);

      const pairs = (await findClonePairs()).filter((pair) => pair.serialNumber === serial);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].cloneId).toBe(clone.id);
      expect(pairs[0].targetId).toBe(gymBoard.id);
    });

    it('does not pair boards describing different walls even when the serial matches', async () => {
      const serial = `MERGEDIFF-${Date.now()}`;
      const gymId = await insertGym('Different Config Gym');
      // Same serial (the supplier reuses them) but a different size — not the
      // same wall, so merging would fold two real gyms' history together.
      const gymBoard = await insertBoard({
        ownerId: SYSTEM_OWNER_ID,
        serial: null,
        gymId,
        name: 'Gym - Kilter',
        sizeId: 17,
      });
      await insertBoard({ ownerId: CLONE_OWNER_ID, serial, gymId: null, name: 'Kilter Board', sizeId: 10 });
      await linkSerial(OTHER_USER_ID, serial, gymBoard.uuid);

      const pairs = (await findClonePairs()).filter((pair) => pair.serialNumber === serial);
      expect(pairs).toEqual([]);
    });

    it('does not pair a board with a gym listing owned by a real user', async () => {
      const serial = `MERGEOWNED-${Date.now()}`;
      const gymId = await insertGym('User Owned Gym');
      const userOwned = await insertBoard({ ownerId: OTHER_USER_ID, serial: null, gymId, name: 'Their Wall' });
      await insertBoard({ ownerId: CLONE_OWNER_ID, serial, gymId: null, name: 'Kilter Board' });
      await linkSerial(OTHER_USER_ID, serial, userOwned.uuid);

      const pairs = (await findClonePairs()).filter((pair) => pair.serialNumber === serial);
      expect(pairs).toEqual([]);
    });
  });

  describe('findSerialBackfills', () => {
    it('offers a serial-less gym board the serial climbers recorded against it', async () => {
      const serial = `BACKFILL-${Date.now()}`;
      const gymId = await insertGym('Backfill Gym');
      const gymBoard = await insertBoard({ ownerId: SYSTEM_OWNER_ID, serial: null, gymId, name: 'Gym - Kilter' });
      await linkSerial(OTHER_USER_ID, serial, gymBoard.uuid);

      const backfills = (await findSerialBackfills()).filter((row) => row.serialNumber === serial);
      expect(backfills).toHaveLength(1);
      expect(backfills[0].boardId).toBe(gymBoard.id);
    });

    it('skips a serial another active board already carries', async () => {
      const serial = `BACKFILLTAKEN-${Date.now()}`;
      const gymId = await insertGym('Taken Serial Gym');
      const gymBoard = await insertBoard({ ownerId: SYSTEM_OWNER_ID, serial: null, gymId, name: 'Gym - Kilter' });
      await insertBoard({ ownerId: CLONE_OWNER_ID, serial, gymId: null, name: 'Kilter Board' });
      await linkSerial(OTHER_USER_ID, serial, gymBoard.uuid);

      // Stamping it here would make the serial ambiguous, which is what the
      // runtime disambiguation prompt exists for — leave it to the merge.
      const backfills = (await findSerialBackfills()).filter((row) => row.serialNumber === serial);
      expect(backfills).toEqual([]);
    });
  });

  describe('mergeClonePair', () => {
    async function seedPair(serial: string): Promise<{ pair: ClonePair; gymBoard: Board; clone: Board }> {
      const gymId = await insertGym('Merge Gym');
      const gymBoard = await insertBoard({ ownerId: SYSTEM_OWNER_ID, serial: null, gymId, name: 'Gym - Kilter' });
      const clone = await insertBoard({ ownerId: CLONE_OWNER_ID, serial, gymId: null, name: 'Kilter Board' });
      await linkSerial(OTHER_USER_ID, serial, gymBoard.uuid);
      await linkSerial(CLONE_OWNER_ID, serial, clone.uuid);
      const pair = (await findClonePairs()).find((candidate) => candidate.serialNumber === serial)!;
      return { pair, gymBoard, clone };
    }

    it('renumbers the merged history chronologically instead of appending it', async () => {
      const serial = `MERGESEQ-${Date.now()}`;
      const { pair, gymBoard, clone } = await seedPair(serial);

      // The clone holds the OLDER half — a naive offset would sort it above the
      // gym board's rows, which `boardHistory` renders newest-first by seq.
      await insertEvent(clone.id, 1, '2026-07-06T03:17:44Z', 'old-a');
      await insertEvent(clone.id, 2, '2026-07-06T03:22:07Z', 'old-b');
      await insertEvent(gymBoard.id, 1, '2026-08-03T03:59:09Z', 'new-a');
      await insertEvent(gymBoard.id, 2, '2026-08-03T04:00:03Z', 'new-b');

      const counts = await db.transaction((tx) => mergeClonePair(pair, tx));
      expect(counts.climbEvents).toBe(2);

      const merged = await eventsOnBoard(gymBoard.id);
      expect(merged.map((row) => row.name)).toEqual(['old-a', 'old-b', 'new-a', 'new-b']);
      // Contiguous from 1, so the seq cursor `boardHistory` pages on stays sane.
      expect(merged.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
      expect(await eventsOnBoard(clone.id)).toEqual([]);
    });

    it('survives the two boards holding the same seq values', async () => {
      const serial = `MERGECOLLIDE-${Date.now()}`;
      const { pair, gymBoard, clone } = await seedPair(serial);
      // Both boards number from 1 — the case a straight repoint would fail on.
      await insertEvent(clone.id, 1, '2026-07-01T00:00:00Z', 'clone-1');
      await insertEvent(clone.id, 2, '2026-07-01T01:00:00Z', 'clone-2');
      await insertEvent(gymBoard.id, 1, '2026-07-02T00:00:00Z', 'gym-1');
      await insertEvent(gymBoard.id, 2, '2026-07-02T01:00:00Z', 'gym-2');

      await db.transaction((tx) => mergeClonePair(pair, tx));

      const merged = await eventsOnBoard(gymBoard.id);
      expect(merged.map((row) => row.name)).toEqual(['clone-1', 'clone-2', 'gym-1', 'gym-2']);
      expect(merged.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    });

    it('moves the serial link, adopts the serial, and soft-deletes the clone', async () => {
      const serial = `MERGELINK-${Date.now()}`;
      const { pair, gymBoard, clone } = await seedPair(serial);

      await db.transaction((tx) => mergeClonePair(pair, tx));

      const [gymRow] = await db.execute(sql`
        SELECT serial_number, deleted_at FROM user_boards WHERE id = ${gymBoard.id}
      `);
      expect((gymRow as { serial_number: string }).serial_number).toBe(serial);
      expect((gymRow as { deleted_at: Date | null }).deleted_at).toBeNull();

      const [cloneRow] = await db.execute(sql`SELECT deleted_at FROM user_boards WHERE id = ${clone.id}`);
      // Soft delete only — a bad pairing has to stay reversible.
      expect((cloneRow as { deleted_at: Date | null }).deleted_at).not.toBeNull();

      const links = await db.execute(sql`
        SELECT board_uuid FROM user_board_serials WHERE serial_number = ${serial}
      `);
      expect((links as unknown as { board_uuid: string }[]).every((row) => row.board_uuid === gymBoard.uuid)).toBe(
        true,
      );
    });

    it('drops the duplicate follow instead of colliding on the unique key', async () => {
      const serial = `MERGEFOLLOW-${Date.now()}`;
      const { pair, gymBoard, clone } = await seedPair(serial);
      // This climber follows BOTH boards — repointing blind would violate
      // board_follows_unique_user_board.
      await db.execute(sql`
        INSERT INTO board_follows (user_id, board_uuid) VALUES
          (${OTHER_USER_ID}, ${gymBoard.uuid}), (${OTHER_USER_ID}, ${clone.uuid})
      `);
      // ...while this one follows only the clone and should be carried over.
      await db.execute(sql`INSERT INTO board_follows (user_id, board_uuid) VALUES (${CLONE_OWNER_ID}, ${clone.uuid})`);

      const counts = await db.transaction((tx) => mergeClonePair(pair, tx));
      expect(counts.followsDropped).toBe(1);
      expect(counts.follows).toBe(1);

      const followers = await db.execute(sql`
        SELECT user_id FROM board_follows WHERE board_uuid = ${gymBoard.uuid} ORDER BY user_id
      `);
      expect((followers as unknown as { user_id: string }[]).map((row) => row.user_id)).toEqual([
        CLONE_OWNER_ID,
        OTHER_USER_ID,
      ]);
    });
  });
});
