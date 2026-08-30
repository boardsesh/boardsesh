import { describe, it as vitestIt, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { rowsFromResult } from '@boardsesh/db/client';
import { socialBoardQueries, socialBoardMutations } from '../graphql/resolvers/social/boards';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { findChosenBoardForSerial } from '../graphql/resolvers/board-presence/shared';
import { lockBoardSerialWrite } from '../graphql/resolvers/board-serial-write-lock';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';
import { createBarrier, createValueBarrier, handleLater } from './helpers/concurrency';

/**
 * Real-DB coverage for issue #3407's merge-tombstone following and the
 * createBoard cross-owner duplicate-serial backstop.
 *
 * The dedupe script soft-deletes duplicate user_boards rows for the same
 * physical wall and stamps `merged_into_board_uuid` with the survivor's uuid.
 * These tests prove the backend follows that pointer (boardByUuid, boardBySlug,
 * and the board-presence serial pointer) so stale links/bindings land on the
 * survivor — while a PLAIN soft-delete (no tombstone) still resolves to
 * nothing — and that createBoard blocks a cross-owner same-config same-serial
 * duplicate unless the caller opts in.
 *
 * All assertions are membership-by-uuid/id so unrelated seed rows can't perturb
 * them. Each createBoard case uses a fresh owner and the shared setup resets
 * rate limits between tests, so the per-op limit never trips.
 */

const PREFIX = 'merge-tombstone';
const SERIAL_SUFFIX = Date.now().toString(36).toUpperCase();

// Owner ids — distinct so the per-owner unique config index never collides.
const OWNER_SURVIVOR = `${PREFIX}-owner-survivor`;
const OWNER_A = `${PREFIX}-owner-a`;
const OWNER_B = `${PREFIX}-owner-b`;
const OWNER_C = `${PREFIX}-owner-c`;
const OWNER_D = `${PREFIX}-owner-d`;
const OWNER_SERIAL = `${PREFIX}-owner-serial`;

// The `board` (boardByUuid) resolver validates the arg as a real UUID, so every
// board uuid here is a genuine v4; slugs stay human-readable for legibility.

// boardByUuid / boardBySlug survivors + losers.
const SURVIVOR_UUID = uuidv4();
const SURVIVOR_SLUG = `${PREFIX}-survivor-slug`;
const LOSER_UUID = uuidv4();
const LOSER_SLUG = `${PREFIX}-loser-slug`;
const PLAIN_DELETED_UUID = uuidv4();
const PLAIN_DELETED_SLUG = `${PREFIX}-plain-deleted-slug`;

// 3-hop chain: hop1 -> hop2 -> hop3 -> chain-survivor.
const CHAIN_SURVIVOR_UUID = uuidv4();
const CHAIN_SURVIVOR_SLUG = `${PREFIX}-chain-survivor-slug`;
const CHAIN_HOP1_UUID = uuidv4();
const CHAIN_HOP2_UUID = uuidv4();
const CHAIN_HOP3_UUID = uuidv4();
// A 4th link in front of the chain — beyond the ≤3-hop walk bound.
const CHAIN_HOP0_UUID = uuidv4();

// Slug reused by a new active board (active must win over the merged loser).
const REUSED_SLUG = `${PREFIX}-reused-slug`;
const REUSED_ACTIVE_UUID = uuidv4();
const REUSED_LOSER_UUID = uuidv4();
const REUSED_SURVIVOR_UUID = uuidv4();
const REUSED_SURVIVOR_SLUG = `${PREFIX}-reused-survivor-slug`;

// Serial-pointer healing.
const SERIAL_MERGED = `${PREFIX}-SN-${SERIAL_SUFFIX}`;
const SERIAL_PLAIN = `${PREFIX}-SNP-${SERIAL_SUFFIX}`;
const SERIAL_SURVIVOR_UUID = uuidv4();
const SERIAL_SURVIVOR_SLUG = `${PREFIX}-serial-survivor-slug`;
const SERIAL_LOSER_UUID = uuidv4();
const SERIAL_PLAIN_LOSER_UUID = uuidv4();

// createBoard backstop: an existing cross-owner board carrying a serial.
// Serials are normalised to UPPERCASE on write (normalizeSerial), so seed the
// stored serial in that form — createBoard uppercases the input before the
// backstop compares it against this row.
const EXISTING_SERIAL = `${PREFIX}-EX-${SERIAL_SUFFIX}`.toUpperCase();
const EXISTING_BOARD_UUID = uuidv4();
const EXISTING_BOARD_SLUG = `${PREFIX}-existing-board-slug`;

let dbReady = false;
let dbUnavailableReason = 'PostgreSQL test database is unavailable';
let cleanupBoardMergeCatalogFixtures: () => Promise<void> = async () => {};

function it(name: string, testHandler: () => void | Promise<void>): ReturnType<typeof vitestIt> {
  return vitestIt(name, async (testContext) => {
    if (!dbReady) {
      testContext.skip(dbUnavailableReason);
      return;
    }
    await testHandler();
  });
}

const anonCtx = { connectionId: `${PREFIX}-conn`, isAuthenticated: false } as ConnectionContext;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `${PREFIX}-conn`, isAuthenticated: true, userId }) as ConnectionContext;

type BoardResult = { uuid: string; slug: string; name: string } | null;
const boardByUuid = (uuid: string) =>
  socialBoardQueries.board(null, { boardUuid: uuid }, anonCtx) as Promise<BoardResult>;
const boardBySlug = (slug: string) => socialBoardQueries.boardBySlug(null, { slug }, anonCtx) as Promise<BoardResult>;

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${`${id}@test.com`}, ${`Test ${id}`}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertBoard(opts: {
  uuid: string;
  slug: string;
  ownerId: string;
  serialNumber?: string | null;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  deleted?: boolean;
  mergedInto?: string | null;
  isPublic?: boolean;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number,
       is_public, is_unlisted, deleted_at, merged_into_board_uuid)
    VALUES (
      ${opts.uuid}, ${opts.slug}, ${opts.ownerId}, 'kilter',
      ${opts.layoutId ?? 1}, ${opts.sizeId ?? 10}, ${opts.setIds ?? '1,2'},
      ${`Board ${opts.uuid}`}, ${opts.serialNumber ?? null},
      ${opts.isPublic ?? true}, false,
      ${opts.deleted ? sql`now()` : sql`NULL`},
      ${opts.mergedInto ?? null}
    )
  `);
}

async function insertSerialPointer(userId: string, serial: string, boardUuid: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_board_serials
      (user_id, serial_number, board_name, layout_id, size_id, set_ids, board_uuid, created_at, updated_at)
    VALUES (${userId}, ${serial}, 'kilter', 1, 10, '1,2', ${boardUuid}, now(), now())
    ON CONFLICT (user_id, board_name, serial_number) DO UPDATE SET board_uuid = ${boardUuid}, updated_at = now()
  `);
}

async function serialPointerUuid(userId: string, serial: string): Promise<string | null> {
  const rows = rowsFromResult<{ board_uuid: string | null }>(
    await db.execute(sql`
      SELECT board_uuid FROM user_board_serials WHERE user_id = ${userId} AND serial_number = ${serial} LIMIT 1
    `),
  );
  return rows[0]?.board_uuid ?? null;
}

async function waitForAdvisoryWaitBlockedBy(blockingPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [blockedSession] = rowsFromResult<{ pid: number }>(
      await db.execute(sql`
        SELECT DISTINCT activity.pid AS pid
          FROM pg_stat_activity activity
          JOIN pg_locks waiting_lock
            ON waiting_lock.pid = activity.pid
           AND waiting_lock.granted = false
           AND waiting_lock.locktype = 'advisory'
         WHERE activity.datname = current_database()
           AND ${blockingPid} = ANY(pg_blocking_pids(activity.pid))
         LIMIT 1
      `),
    );
    if (blockedSession) return Number(blockedSession.pid);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for an advisory lock blocked by PostgreSQL pid ${blockingPid}`);
}

async function waitForRowWaitBlockedBy(blockingPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [blockedSession] = rowsFromResult<{ pid: number }>(
      await db.execute(sql`
        SELECT DISTINCT activity.pid AS pid
          FROM pg_stat_activity activity
         WHERE activity.datname = current_database()
           AND ${blockingPid} = ANY(pg_blocking_pids(activity.pid))
           AND EXISTS (
             SELECT 1
               FROM pg_locks waiting_lock
              WHERE waiting_lock.pid = activity.pid
                AND waiting_lock.granted = false
                AND waiting_lock.locktype <> 'advisory'
           )
         LIMIT 1
      `),
    );
    if (blockedSession) return Number(blockedSession.pid);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a row lock blocked by PostgreSQL pid ${blockingPid}`);
}

async function grantedAdvisoryLockCount(backendPid: number): Promise<number> {
  const [row] = rowsFromResult<{ count: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS count
        FROM pg_locks
       WHERE pid = ${backendPid}
         AND locktype = 'advisory'
         AND granted = true
    `),
  );
  return Number(row?.count ?? 0);
}

async function tombstoneBoardUnderSerialLock(
  serial: string,
  loserUuid: string,
  canonicalUuid: string,
  ready: { release: (backendPid: number) => void },
  releaseTransaction: Promise<void>,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [session] = rowsFromResult<{ pid: number }>(await transaction.execute(sql`SELECT pg_backend_pid() AS pid`));
    await transaction.execute(sql`
      SELECT id
        FROM user_boards
       WHERE uuid IN (${loserUuid}, ${canonicalUuid})
       ORDER BY id
       FOR UPDATE
    `);
    await lockBoardSerialWrite(transaction, serial);
    await transaction.execute(sql`
      UPDATE user_boards
         SET deleted_at = NOW(), merged_into_board_uuid = ${canonicalUuid}
       WHERE uuid = ${loserUuid}
    `);
    ready.release(Number(session.pid));
    await releaseTransaction;
  });
}

beforeAll(async () => {
  try {
    cleanupBoardMergeCatalogFixtures = await seedAuroraCatalogFixtures([
      {
        boardType: 'kilter',
        productId: 2_140_003_422,
        layoutId: 11,
        sizeId: 12,
        setIds: [1, 2],
        associationIdBase: 2_140_003_430,
      },
      {
        boardType: 'kilter',
        productId: 2_140_003_422,
        layoutId: 42,
        sizeId: 12,
        setIds: [1, 2],
        associationIdBase: 2_140_003_440,
      },
      {
        boardType: 'kilter',
        productId: 2_140_003_422,
        layoutId: 99,
        sizeId: 12,
        setIds: [1, 2],
        associationIdBase: 2_140_003_450,
      },
      {
        boardType: 'kilter',
        productId: 2_140_003_422,
        layoutId: 55,
        sizeId: 12,
        setIds: [1, 2],
        associationIdBase: 2_140_003_460,
      },
    ]);

    await Promise.all([
      insertUser(OWNER_SURVIVOR),
      insertUser(OWNER_A),
      insertUser(OWNER_B),
      insertUser(OWNER_C),
      insertUser(OWNER_D),
      insertUser(OWNER_SERIAL),
    ]);

    // boardByUuid / boardBySlug: survivor + merged loser + plain soft-delete.
    await insertBoard({ uuid: SURVIVOR_UUID, slug: SURVIVOR_SLUG, ownerId: OWNER_SURVIVOR });
    await insertBoard({
      uuid: LOSER_UUID,
      slug: LOSER_SLUG,
      ownerId: OWNER_A,
      deleted: true,
      mergedInto: SURVIVOR_UUID,
    });
    await insertBoard({
      uuid: PLAIN_DELETED_UUID,
      slug: PLAIN_DELETED_SLUG,
      ownerId: OWNER_A,
      layoutId: 2,
      deleted: true,
      mergedInto: null,
    });

    // 3-hop chain.
    await insertBoard({ uuid: CHAIN_SURVIVOR_UUID, slug: CHAIN_SURVIVOR_SLUG, ownerId: OWNER_SURVIVOR, layoutId: 3 });
    await insertBoard({
      uuid: CHAIN_HOP3_UUID,
      slug: `${CHAIN_HOP3_UUID}-slug`,
      ownerId: OWNER_B,
      deleted: true,
      mergedInto: CHAIN_SURVIVOR_UUID,
    });
    await insertBoard({
      uuid: CHAIN_HOP2_UUID,
      slug: `${CHAIN_HOP2_UUID}-slug`,
      ownerId: OWNER_C,
      deleted: true,
      mergedInto: CHAIN_HOP3_UUID,
    });
    await insertBoard({
      uuid: CHAIN_HOP1_UUID,
      slug: `${CHAIN_HOP1_UUID}-slug`,
      ownerId: OWNER_D,
      deleted: true,
      mergedInto: CHAIN_HOP2_UUID,
    });
    await insertBoard({
      uuid: CHAIN_HOP0_UUID,
      slug: `${CHAIN_HOP0_UUID}-slug`,
      ownerId: OWNER_A,
      deleted: true,
      mergedInto: CHAIN_HOP1_UUID,
    });

    // Slug reused by a new active board — active must win over the merged loser.
    await insertBoard({ uuid: REUSED_SURVIVOR_UUID, slug: REUSED_SURVIVOR_SLUG, ownerId: OWNER_SURVIVOR, layoutId: 4 });
    await insertBoard({
      uuid: REUSED_LOSER_UUID,
      slug: REUSED_SLUG,
      ownerId: OWNER_A,
      layoutId: 5,
      deleted: true,
      mergedInto: REUSED_SURVIVOR_UUID,
    });
    await insertBoard({ uuid: REUSED_ACTIVE_UUID, slug: REUSED_SLUG, ownerId: OWNER_B, layoutId: 6 });

    // Serial-pointer healing: survivor + merged loser + a plain-deleted loser.
    await insertBoard({ uuid: SERIAL_SURVIVOR_UUID, slug: SERIAL_SURVIVOR_SLUG, ownerId: OWNER_SERIAL, layoutId: 7 });
    await insertBoard({
      uuid: SERIAL_LOSER_UUID,
      slug: `${SERIAL_LOSER_UUID}-slug`,
      ownerId: OWNER_SERIAL,
      layoutId: 8,
      deleted: true,
      mergedInto: SERIAL_SURVIVOR_UUID,
    });
    await insertBoard({
      uuid: SERIAL_PLAIN_LOSER_UUID,
      slug: `${SERIAL_PLAIN_LOSER_UUID}-slug`,
      ownerId: OWNER_SERIAL,
      layoutId: 9,
      deleted: true,
      mergedInto: null,
    });
    await insertSerialPointer(OWNER_SERIAL, SERIAL_MERGED, SERIAL_LOSER_UUID);
    await insertSerialPointer(OWNER_SERIAL, SERIAL_PLAIN, SERIAL_PLAIN_LOSER_UUID);

    // createBoard backstop: an EXISTING active board owned by a DIFFERENT user.
    await insertBoard({
      uuid: EXISTING_BOARD_UUID,
      slug: EXISTING_BOARD_SLUG,
      ownerId: OWNER_A,
      serialNumber: EXISTING_SERIAL,
      layoutId: 11,
      sizeId: 12,
      setIds: '1,2',
    });

    dbReady = true;
  } catch (error) {
    dbUnavailableReason = `PostgreSQL test database unavailable: ${error instanceof Error ? error.message : String(error)}`;
    if (process.env.SKIP_TEST_INFRA === '1') return;
    throw error;
  }
});

afterAll(async () => {
  await cleanupBoardMergeCatalogFixtures();
});

describe('boardByUuid tombstone following', () => {
  it('returns the canonical survivor when the uuid is a merged loser', async () => {
    const board = await boardByUuid(LOSER_UUID);
    expect(board?.uuid).toBe(SURVIVOR_UUID);
    expect(board?.slug).toBe(SURVIVOR_SLUG);
  });

  it('returns the active board unchanged', async () => {
    const board = await boardByUuid(SURVIVOR_UUID);
    expect(board?.uuid).toBe(SURVIVOR_UUID);
  });

  it('returns null for a plain soft-delete (no merge tombstone)', async () => {
    expect(await boardByUuid(PLAIN_DELETED_UUID)).toBeNull();
  });

  it('follows a 3-hop merge chain to the survivor', async () => {
    const board = await boardByUuid(CHAIN_HOP1_UUID);
    expect(board?.uuid).toBe(CHAIN_SURVIVOR_UUID);
  });

  it('returns null (without throwing) when the chain exceeds the hop bound', async () => {
    // 4 pointers to the survivor — one past the ≤3-hop walk. Should be
    // unreachable in practice (the dedupe script flattens chains to depth 1),
    // so the bound trips safely instead of resolving.
    expect(await boardByUuid(CHAIN_HOP0_UUID)).toBeNull();
  });
});

describe('boardBySlug tombstone following', () => {
  it('returns the canonical survivor when the slug belongs to a merged loser', async () => {
    const board = await boardBySlug(LOSER_SLUG);
    expect(board?.uuid).toBe(SURVIVOR_UUID);
    expect(board?.slug).toBe(SURVIVOR_SLUG);
  });

  it('returns null for a plain soft-deleted slug (no tombstone)', async () => {
    expect(await boardBySlug(PLAIN_DELETED_SLUG)).toBeNull();
  });

  it('follows a 3-hop merge chain from a merged slug to the survivor', async () => {
    const board = await boardBySlug(`${CHAIN_HOP1_UUID}-slug`);
    expect(board?.uuid).toBe(CHAIN_SURVIVOR_UUID);
    expect(board?.slug).toBe(CHAIN_SURVIVOR_SLUG);
  });

  it('prefers the active board when a merged loser reused its slug', async () => {
    const board = await boardBySlug(REUSED_SLUG);
    // The new active board wins — we must NOT follow the merged loser's tombstone.
    expect(board?.uuid).toBe(REUSED_ACTIVE_UUID);
  });
});

describe('followBoard during a board merge', () => {
  it('returns Board not found when the merge commits first, without exposing the private survivor', async () => {
    const tag = `${PREFIX}-follow-merge-first-${Date.now()}`;
    const followerId = `${tag}-follower`;
    const survivorOwnerId = `${tag}-survivor-owner`;
    const serial = `${tag}-serial`;
    const loserUuid = uuidv4();
    const survivorUuid = uuidv4();
    const mergeReady = createValueBarrier<number>();
    const releaseMerge = createBarrier();
    let mergePromise: Promise<void> | undefined;
    let followPromise: ReturnType<typeof socialBoardMutations.followBoard> | undefined;

    try {
      await Promise.all([insertUser(followerId), insertUser(survivorOwnerId)]);
      await insertBoard({
        uuid: survivorUuid,
        slug: `${tag}-survivor`,
        ownerId: survivorOwnerId,
        serialNumber: serial,
        isPublic: false,
      });
      await insertBoard({
        uuid: loserUuid,
        slug: `${tag}-loser`,
        ownerId: followerId,
        serialNumber: serial,
        isPublic: false,
      });

      mergePromise = db.transaction(
        async (transaction) => {
          const [session] = rowsFromResult<{ pid: number }>(
            await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
          );
          await transaction.execute(sql`
            SELECT id
              FROM user_boards
             WHERE uuid IN (${loserUuid}, ${survivorUuid})
             ORDER BY id
             FOR UPDATE
          `);
          await transaction.execute(sql`
            UPDATE user_boards
               SET deleted_at = now(), is_public = false, merged_into_board_uuid = ${survivorUuid}
             WHERE uuid = ${loserUuid}
          `);
          mergeReady.release(Number(session.pid));
          await releaseMerge.promise;
        },
        { isolationLevel: 'read committed' },
      );
      handleLater(mergePromise);
      const mergePid = await mergeReady.promise;

      followPromise = socialBoardMutations.followBoard(
        undefined,
        { input: { boardUuid: loserUuid } },
        authCtx(followerId),
      );
      handleLater(followPromise);
      await waitForRowWaitBlockedBy(mergePid);

      releaseMerge.release();
      await mergePromise;
      await expect(followPromise).rejects.toThrow('Board not found');

      const follows = rowsFromResult<{ boardUuid: string }>(
        await db.execute(sql`
          SELECT board_uuid AS "boardUuid"
            FROM board_follows
           WHERE user_id = ${followerId}
             AND board_uuid IN (${loserUuid}, ${survivorUuid})
        `),
      );
      expect(follows).toEqual([]);
    } finally {
      releaseMerge.release();
      await Promise.allSettled([mergePromise, followPromise].filter((promise) => promise !== undefined));
      await db.execute(sql`DELETE FROM board_follows WHERE user_id = ${followerId}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${loserUuid}, ${survivorUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${followerId}, ${survivorOwnerId})`);
    }
  });

  it('lets a follower commit first, then migrates that committed follow to the survivor', async () => {
    const tag = `${PREFIX}-follow-follower-first-${Date.now()}`;
    const followerId = `${tag}-follower`;
    const loserOwnerId = `${tag}-loser-owner`;
    const survivorOwnerId = `${tag}-survivor-owner`;
    const serial = `${tag}-serial`;
    const loserUuid = uuidv4();
    const survivorUuid = uuidv4();
    const userRowLocked = createValueBarrier<number>();
    const releaseUserRow = createBarrier();
    const mergeStarted = createValueBarrier<number>();
    let userRowHolderPromise: Promise<void> | undefined;
    let followPromise: ReturnType<typeof socialBoardMutations.followBoard> | undefined;
    let mergePromise: Promise<void> | undefined;

    try {
      await Promise.all([insertUser(followerId), insertUser(loserOwnerId), insertUser(survivorOwnerId)]);
      await insertBoard({
        uuid: survivorUuid,
        slug: `${tag}-survivor`,
        ownerId: survivorOwnerId,
        serialNumber: serial,
      });
      await insertBoard({
        uuid: loserUuid,
        slug: `${tag}-loser`,
        ownerId: loserOwnerId,
        serialNumber: serial,
      });
      // Keep the survivor canonical even after the new loser follow commits:
      // both boards then have one follow and the earlier survivor id wins.
      await db.execute(sql`
        INSERT INTO board_follows (user_id, board_uuid)
        VALUES (${survivorOwnerId}, ${survivorUuid})
      `);

      // Hold the follower's user FK row so followBoard pauses at INSERT after
      // it has acquired FOR SHARE on the requested board.
      userRowHolderPromise = db.transaction(async (transaction) => {
        const [session] = rowsFromResult<{ pid: number }>(
          await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
        );
        await transaction.execute(sql`SELECT id FROM users WHERE id = ${followerId} FOR UPDATE`);
        userRowLocked.release(Number(session.pid));
        await releaseUserRow.promise;
      });
      handleLater(userRowHolderPromise);
      const userRowHolderPid = await userRowLocked.promise;

      followPromise = socialBoardMutations.followBoard(
        undefined,
        { input: { boardUuid: loserUuid } },
        authCtx(followerId),
      );
      handleLater(followPromise);
      const followerPid = await waitForRowWaitBlockedBy(userRowHolderPid);

      // This is the follow-repoint portion of the real dedupe transaction. It
      // begins before the follow commits, waits on followBoard's shared board
      // lock, then relies on READ COMMITTED to see and move the new follow.
      mergePromise = db.transaction(
        async (transaction) => {
          const [session] = rowsFromResult<{ pid: number }>(
            await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
          );
          mergeStarted.release(Number(session.pid));
          await transaction.execute(sql`
            SELECT id
              FROM user_boards
             WHERE uuid IN (${loserUuid}, ${survivorUuid})
             ORDER BY id
             FOR UPDATE
          `);
          await transaction.execute(sql`
            INSERT INTO board_follows (user_id, board_uuid, created_at)
            SELECT user_id, ${survivorUuid}, MIN(created_at)
              FROM board_follows
             WHERE board_uuid = ${loserUuid}
             GROUP BY user_id
            ON CONFLICT (user_id, board_uuid) DO NOTHING
          `);
          await transaction.execute(sql`DELETE FROM board_follows WHERE board_uuid = ${loserUuid}`);
          await transaction.execute(sql`
            UPDATE user_boards
               SET deleted_at = now(), is_public = false, merged_into_board_uuid = ${survivorUuid}
             WHERE uuid = ${loserUuid}
          `);
        },
        { isolationLevel: 'read committed' },
      );
      handleLater(mergePromise);
      const mergePid = await mergeStarted.promise;
      expect(await waitForRowWaitBlockedBy(followerPid)).toBe(mergePid);

      releaseUserRow.release();
      await userRowHolderPromise;
      await expect(followPromise).resolves.toBe(true);
      await mergePromise;

      const follows = rowsFromResult<{ boardUuid: string }>(
        await db.execute(sql`
          SELECT board_uuid AS "boardUuid"
            FROM board_follows
           WHERE user_id = ${followerId}
             AND board_uuid IN (${loserUuid}, ${survivorUuid})
           ORDER BY board_uuid
        `),
      );
      expect(follows).toEqual([{ boardUuid: survivorUuid }]);
    } finally {
      releaseUserRow.release();
      await Promise.allSettled(
        [userRowHolderPromise, followPromise, mergePromise].filter((promise) => promise !== undefined),
      );
      await db.execute(sql`DELETE FROM board_follows WHERE user_id = ${followerId}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${loserUuid}, ${survivorUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${followerId}, ${loserOwnerId}, ${survivorOwnerId})`);
    }
  });

  it('rejects an outsider following an active private board', async () => {
    const tag = `${PREFIX}-follow-private-${Date.now()}`;
    const ownerId = `${tag}-owner`;
    const outsiderId = `${tag}-outsider`;
    const boardUuid = uuidv4();

    try {
      await Promise.all([insertUser(ownerId), insertUser(outsiderId)]);
      await insertBoard({ uuid: boardUuid, slug: `${tag}-board`, ownerId, isPublic: false });

      await expect(
        socialBoardMutations.followBoard(undefined, { input: { boardUuid } }, authCtx(outsiderId)),
      ).rejects.toThrow('Cannot follow a private board');

      const [followCount] = rowsFromResult<{ count: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS count
            FROM board_follows
           WHERE user_id = ${outsiderId} AND board_uuid = ${boardUuid}
        `),
      );
      expect(Number(followCount.count)).toBe(0);
    } finally {
      await db.execute(sql`DELETE FROM board_follows WHERE user_id = ${outsiderId}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid = ${boardUuid}`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${ownerId}, ${outsiderId})`);
    }
  });
});

describe('findChosenBoardForSerial pointer healing', () => {
  it('follows a merged pointer to the survivor and heals user_board_serials', async () => {
    // Precondition: the pointer references the merged loser.
    expect(await serialPointerUuid(OWNER_SERIAL, SERIAL_MERGED)).toBe(SERIAL_LOSER_UUID);

    const board = await findChosenBoardForSerial(OWNER_SERIAL, SERIAL_MERGED);
    const survivorId = rowsFromResult<{ id: number }>(
      await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${SERIAL_SURVIVOR_UUID} LIMIT 1`),
    )[0].id;
    expect(board?.id).toBe(Number(survivorId));

    // The dangling pointer is healed straight to the survivor.
    expect(await serialPointerUuid(OWNER_SERIAL, SERIAL_MERGED)).toBe(SERIAL_SURVIVOR_UUID);
  });

  it('returns undefined for a plain-deleted pointer (no tombstone)', async () => {
    expect(await findChosenBoardForSerial(OWNER_SERIAL, SERIAL_PLAIN)).toBeUndefined();
    // The pointer is left untouched for the caller's candidate fallback.
    expect(await serialPointerUuid(OWNER_SERIAL, SERIAL_PLAIN)).toBe(SERIAL_PLAIN_LOSER_UUID);
  });

  it('waits for a concurrent C1→C2 merge before healing an L0→C1 pointer', async () => {
    const tag = `${PREFIX}-heal-race-${Date.now()}`;
    const serial = `HEAL-${SERIAL_SUFFIX}`;
    const pointerOwner = `${tag}-pointer-owner`;
    const loserOwner = `${tag}-loser-owner`;
    const canonicalOwner = `${tag}-canonical-owner`;
    const oldLoserUuid = uuidv4();
    const loserUuid = uuidv4();
    const canonicalUuid = uuidv4();
    const mergeReady = createValueBarrier<number>();
    const releaseMerge = createBarrier();
    let mergePromise: Promise<void> | undefined;
    let healPromise: ReturnType<typeof findChosenBoardForSerial> | undefined;

    try {
      await Promise.all([insertUser(pointerOwner), insertUser(loserOwner), insertUser(canonicalOwner)]);
      await insertBoard({
        uuid: canonicalUuid,
        slug: `${tag}-canonical`,
        ownerId: canonicalOwner,
        serialNumber: serial,
      });
      await insertBoard({ uuid: loserUuid, slug: `${tag}-loser`, ownerId: loserOwner, serialNumber: serial });
      await insertBoard({
        uuid: oldLoserUuid,
        slug: `${tag}-old-loser`,
        ownerId: pointerOwner,
        serialNumber: serial,
        deleted: true,
        mergedInto: loserUuid,
      });
      await insertSerialPointer(pointerOwner, serial, oldLoserUuid);

      mergePromise = tombstoneBoardUnderSerialLock(serial, loserUuid, canonicalUuid, mergeReady, releaseMerge.promise);
      handleLater(mergePromise);
      const mergePid = await mergeReady.promise;

      healPromise = findChosenBoardForSerial(pointerOwner, serial);
      handleLater(healPromise);
      await waitForAdvisoryWaitBlockedBy(mergePid);

      releaseMerge.release();
      await mergePromise;
      const healed = await healPromise;
      const [canonical] = rowsFromResult<{ id: number }>(
        await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${canonicalUuid}`),
      );
      expect(healed?.id).toBe(Number(canonical.id));
      expect(await serialPointerUuid(pointerOwner, serial)).toBe(canonicalUuid);
    } finally {
      releaseMerge.release();
      await Promise.allSettled([mergePromise, healPromise]);
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${oldLoserUuid}, ${loserUuid}, ${canonicalUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${pointerOwner}, ${loserOwner}, ${canonicalOwner})`);
    }
  });
});

describe('createBoard cross-owner duplicate-serial backstop', () => {
  const baseInput = { boardType: 'kilter', layoutId: 11, sizeId: 12, setIds: '1,2' };

  it('throws BOARD_SERIAL_EXISTS with the existing board in extensions', async () => {
    await insertUser(`${OWNER_B}-cb`);
    let thrown: unknown;
    try {
      await socialBoardMutations.createBoard(
        null,
        { input: { ...baseInput, name: 'Dup Board', serialNumber: EXISTING_SERIAL } },
        authCtx(`${OWNER_B}-cb`),
      );
    } catch (error) {
      thrown = error;
    }
    const extensions = (thrown as { extensions?: Record<string, unknown> })?.extensions;
    expect(extensions?.code).toBe('BOARD_SERIAL_EXISTS');
    expect(extensions?.boardUuid).toBe(EXISTING_BOARD_UUID);
    expect(extensions?.slug).toBe(EXISTING_BOARD_SLUG);
    expect(extensions?.name).toBe(`Board ${EXISTING_BOARD_UUID}`);
  });

  it('masks the identifying payload when the existing board is private', async () => {
    const privateSerial = `${EXISTING_SERIAL}-PRIV`;
    const privateBoardUuid = uuidv4();
    await insertUser(`${OWNER_A}-priv`);
    await insertUser(`${OWNER_B}-priv`);
    await insertBoard({
      uuid: privateBoardUuid,
      slug: `${PREFIX}-private-existing`,
      ownerId: `${OWNER_A}-priv`,
      serialNumber: privateSerial,
      layoutId: 11,
      sizeId: 12,
      isPublic: false,
    });
    let thrown: unknown;
    try {
      await socialBoardMutations.createBoard(
        null,
        { input: { ...baseInput, name: 'Dup Of Private', serialNumber: privateSerial } },
        authCtx(`${OWNER_B}-priv`),
      );
    } catch (error) {
      thrown = error;
    }
    const extensions = (thrown as { extensions?: Record<string, unknown> })?.extensions;
    // Still blocked, but a private wall's identity must not be enumerable by
    // fuzzing serials through createBoard.
    expect(extensions?.code).toBe('BOARD_SERIAL_EXISTS');
    expect(extensions?.boardUuid).toBeUndefined();
    expect(extensions?.slug).toBeUndefined();
    expect(extensions?.name).toBeUndefined();
  });

  it('allows the create when allowDuplicateSerial is true', async () => {
    await insertUser(`${OWNER_C}-cb`);
    const board = await socialBoardMutations.createBoard(
      null,
      { input: { ...baseInput, name: 'Allowed Dup', serialNumber: EXISTING_SERIAL, allowDuplicateSerial: true } },
      authCtx(`${OWNER_C}-cb`),
    );
    expect((board as { serialNumber: string | null }).serialNumber).toBe(EXISTING_SERIAL);
  });

  it('serializes concurrent normal creates so only one same-serial board is inserted', async () => {
    const firstOwner = `${OWNER_C}-race`;
    const secondOwner = `${OWNER_D}-race`;
    const serial = `RACE-${SERIAL_SUFFIX}`;
    await Promise.all([insertUser(firstOwner), insertUser(secondOwner)]);

    const outcomes = await Promise.allSettled([
      socialBoardMutations.createBoard(
        null,
        { input: { ...baseInput, name: 'Race Board One', serialNumber: serial } },
        authCtx(firstOwner),
      ),
      socialBoardMutations.createBoard(
        null,
        { input: { ...baseInput, setIds: '2,1', name: 'Race Board Two', serialNumber: serial } },
        authCtx(secondOwner),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect((rejected.reason as { extensions?: Record<string, unknown> }).extensions?.code).toBe(
        'BOARD_SERIAL_EXISTS',
      );
    }

    const [count] = rowsFromResult<{ active_count: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS active_count
          FROM user_boards
         WHERE serial_number = ${serial}
           AND board_type = 'kilter'
           AND layout_id = 11
           AND size_id = 12
           AND deleted_at IS NULL
      `),
    );
    expect(Number(count?.active_count)).toBe(1);
  });

  it('serializes createBoard against the first-connect serial resolver', async () => {
    const createOwner = `${OWNER_A}-mixed-race`;
    const connectOwner = `${OWNER_B}-mixed-race`;
    const serial = `MIX-${SERIAL_SUFFIX}`;
    await Promise.all([insertUser(createOwner), insertUser(connectOwner)]);

    const [createOutcome, resolveOutcome] = await Promise.allSettled([
      socialBoardMutations.createBoard(
        null,
        { input: { ...baseInput, name: 'Mixed Race Board', serialNumber: serial } },
        authCtx(createOwner),
      ),
      boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 11, sizeId: 12, setIds: '2,1' },
        authCtx(connectOwner),
      ),
    ]);

    expect(resolveOutcome.status).toBe('fulfilled');
    if (createOutcome.status === 'rejected') {
      expect((createOutcome.reason as { extensions?: Record<string, unknown> }).extensions?.code).toBe(
        'BOARD_SERIAL_EXISTS',
      );
    }

    const rows = rowsFromResult<{ id: number }>(
      await db.execute(sql`
        SELECT id
          FROM user_boards
         WHERE serial_number = ${serial}
           AND board_type = 'kilter'
           AND layout_id = 11
           AND size_id = 12
           AND deleted_at IS NULL
      `),
    );
    expect(rows).toHaveLength(1);
    if (resolveOutcome.status === 'fulfilled') {
      expect(resolveOutcome.value.boardId).toBe(Number(rows[0].id));
    }
  });

  it('serializes createBoard against an edit that assigns the same serial', async () => {
    const createOwner = `${OWNER_C}-update-race`;
    const updateOwner = `${OWNER_D}-update-race`;
    const serial = `UPD-${SERIAL_SUFFIX}`;
    const updateBoardUuid = uuidv4();
    await Promise.all([insertUser(createOwner), insertUser(updateOwner)]);
    await insertBoard({
      uuid: updateBoardUuid,
      slug: `${PREFIX}-update-race-target`,
      ownerId: updateOwner,
      serialNumber: null,
      layoutId: 11,
      sizeId: 12,
      setIds: '1,2',
    });

    const outcomes = await Promise.allSettled([
      socialBoardMutations.createBoard(
        null,
        { input: { ...baseInput, name: 'Create Edit Race Board', serialNumber: serial } },
        authCtx(createOwner),
      ),
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: updateBoardUuid, serialNumber: serial } },
        authCtx(updateOwner),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect((rejected.reason as { extensions?: Record<string, unknown> }).extensions?.code).toBe(
        'BOARD_SERIAL_EXISTS',
      );
    }

    const [count] = rowsFromResult<{ active_count: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS active_count
          FROM user_boards
         WHERE serial_number = ${serial}
           AND board_type = 'kilter'
           AND layout_id = 11
           AND size_id = 12
           AND deleted_at IS NULL
      `),
    );
    expect(Number(count?.active_count)).toBe(1);
  });

  it('serializes serial-only and config-only edits on the same board', async () => {
    const existingOwner = `${OWNER_A}-edit-race-existing`;
    const targetOwner = `${OWNER_B}-edit-race-target`;
    const serial = `EDIT-${SERIAL_SUFFIX}`;
    const targetUuid = uuidv4();
    await Promise.all([insertUser(existingOwner), insertUser(targetOwner)]);
    await insertBoard({
      uuid: uuidv4(),
      slug: `${PREFIX}-edit-race-existing`,
      ownerId: existingOwner,
      serialNumber: serial,
      layoutId: 42,
      sizeId: 12,
      setIds: '1,2',
    });
    await insertBoard({
      uuid: targetUuid,
      slug: `${PREFIX}-edit-race-target`,
      ownerId: targetOwner,
      serialNumber: null,
      layoutId: 41,
      sizeId: 12,
      setIds: '1,2',
    });

    const outcomes = await Promise.allSettled([
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: targetUuid, serialNumber: serial } },
        authCtx(targetOwner),
      ),
      socialBoardMutations.updateBoard(null, { input: { boardUuid: targetUuid, layoutId: 42 } }, authCtx(targetOwner)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect((rejected.reason as { extensions?: Record<string, unknown> }).extensions?.code).toBe(
        'BOARD_SERIAL_EXISTS',
      );
    }

    const [target] = rowsFromResult<{ serial_number: string | null; layout_id: number }>(
      await db.execute(sql`
        SELECT serial_number, layout_id
          FROM user_boards
         WHERE uuid = ${targetUuid}
      `),
    );
    expect(target.serial_number === serial && Number(target.layout_id) === 42).toBe(false);
  });

  it('uses one row-then-serial lock order for update and first-connect binding', async () => {
    const owner = `${OWNER_C}-bind-edit-race`;
    const serial = `BIND-${SERIAL_SUFFIX}`;
    const targetUuid = uuidv4();
    await insertUser(owner);
    await insertBoard({
      uuid: targetUuid,
      slug: `${PREFIX}-bind-edit-race-target`,
      ownerId: owner,
      serialNumber: null,
      layoutId: 51,
      sizeId: 12,
      setIds: '1,2',
    });

    const [updated, resolved] = await Promise.all([
      socialBoardMutations.updateBoard(
        null,
        { input: { boardUuid: targetUuid, serialNumber: serial } },
        authCtx(owner),
      ),
      boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 51, sizeId: 12, setIds: '2,1' },
        authCtx(owner),
      ),
    ]);

    expect((updated as { uuid: string; serialNumber: string | null }).uuid).toBe(targetUuid);
    expect((updated as { serialNumber: string | null }).serialNumber).toBe(serial);
    const [target] = rowsFromResult<{ id: number; serial_number: string | null }>(
      await db.execute(sql`SELECT id, serial_number FROM user_boards WHERE uuid = ${targetUuid}`),
    );
    expect(resolved.boardId).toBe(Number(target.id));
    expect(target.serial_number).toBe(serial);
  });

  it('allows the same serial with a DIFFERENT config', async () => {
    await insertUser(`${OWNER_D}-cb`);
    const board = await socialBoardMutations.createBoard(
      null,
      // Different layoutId — legitimate serial reuse across board models.
      { input: { ...baseInput, layoutId: 99, name: 'Diff Config', serialNumber: EXISTING_SERIAL } },
      authCtx(`${OWNER_D}-cb`),
    );
    expect((board as { uuid: string }).uuid).toBeTruthy();
  });

  it('does not touch creates without a serial', async () => {
    await insertUser(`${OWNER_A}-cb`);
    const board = await socialBoardMutations.createBoard(
      null,
      { input: { ...baseInput, layoutId: 55, name: 'No Serial' } },
      authCtx(`${OWNER_A}-cb`),
    );
    expect((board as { serialNumber: string | null }).serialNumber).toBeNull();
  });
});

/**
 * The auto-gym insert paths.
 *
 * Every create above passes no location, so `resolveAutoGymForBoard` answers
 * `none` and they all land on the same plain insert. When #4166's
 * duplicate-CONFIG guard landed it split createBoard's single insert into three
 * — a gym-mint transaction, an unlinked fallback for when that mint fails, and
 * the plain insert — and each one has to hold the serial write lock across both
 * the guard read and the INSERT. An unguarded path reopens the exact race this
 * PR closes, and the cases above cannot see it: they never reach a mint.
 *
 * Location NAME only, never coordinates, so none of the PostGIS proximity tiers
 * run (the backend test DB has no PostGIS extension).
 */
describe('createBoard serial guard on the auto-gym insert paths', () => {
  const mintBaseInput = { boardType: 'kilter', layoutId: 11, sizeId: 12, setIds: '1,2' };

  async function countBoards(ownerId: string): Promise<number> {
    const [row] = rowsFromResult<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM user_boards WHERE owner_id = ${ownerId}`),
    );
    return row.count;
  }

  async function countGyms(ownerId: string): Promise<number> {
    const [row] = rowsFromResult<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM gyms WHERE owner_id = ${ownerId}`),
    );
    return row.count;
  }

  async function cleanupOwner(ownerId: string): Promise<void> {
    await db.execute(sql`DELETE FROM user_boards WHERE owner_id = ${ownerId}`);
    await db.execute(sql`DELETE FROM gyms WHERE owner_id = ${ownerId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`);
  }

  /**
   * Make the gym INSERT fail so the create falls through to the unlinked
   * fallback. A CHECK constraint scoped to one sentinel name is the smallest
   * lever that reproduces a real mint failure: the whole mint transaction rolls
   * back exactly as it would on a slug collision or a dead extension.
   *
   * `NOT VALID` matters — it still rejects new rows, but skips the scan of the
   * existing ones, so the ACCESS EXCLUSIVE lock on `gyms` is a catalog write and
   * nothing more. Test files run in parallel workers against one database and
   * plenty of them touch gyms; a validating ALTER would park them all behind a
   * full-table scan.
   */
  async function withFailingGymMint(gymName: string, body: () => Promise<void>): Promise<void> {
    const constraint = `mt_forced_mint_failure_${SERIAL_SUFFIX}`.toLowerCase();
    await db.execute(sql.raw(`ALTER TABLE gyms ADD CONSTRAINT ${constraint} CHECK (name <> '${gymName}') NOT VALID`));
    try {
      await body();
    } finally {
      await db.execute(sql.raw(`ALTER TABLE gyms DROP CONSTRAINT IF EXISTS ${constraint}`));
    }
  }

  it('blocks the gym-mint path on a cross-owner duplicate serial, and mints no gym', async () => {
    const owner = `${PREFIX}-mint-block`;
    await insertUser(owner);
    try {
      let thrown: unknown;
      try {
        await socialBoardMutations.createBoard(
          null,
          {
            input: {
              ...mintBaseInput,
              name: 'Mint Dup',
              locationName: `${PREFIX} Mint Block Gym`,
              serialNumber: EXISTING_SERIAL,
            },
          },
          authCtx(owner),
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { extensions?: Record<string, unknown> })?.extensions?.code).toBe('BOARD_SERIAL_EXISTS');
      // The guard sits at the top of the mint transaction, so a rejected create
      // leaves neither a board nor a gym. An orphan gym here would be the tell
      // that the lock was taken after the gym insert rather than before it.
      expect(await countBoards(owner)).toBe(0);
      expect(await countGyms(owner)).toBe(0);
    } finally {
      await cleanupOwner(owner);
    }
  });

  it('mints the gym and links the board when the serial is free', async () => {
    const owner = `${PREFIX}-mint-ok`;
    const serial = `MINT-OK-${SERIAL_SUFFIX}`;
    await insertUser(owner);
    try {
      const board = (await socialBoardMutations.createBoard(
        null,
        {
          input: {
            ...mintBaseInput,
            layoutId: 42,
            name: 'Mint Ok',
            locationName: `${PREFIX} Mint Ok Gym`,
            serialNumber: serial,
          },
        },
        authCtx(owner),
      )) as { uuid: string };
      const [row] = rowsFromResult<{ gym_id: number | null; serial_number: string | null }>(
        await db.execute(sql`SELECT gym_id, serial_number FROM user_boards WHERE uuid = ${board.uuid}`),
      );
      expect(row.gym_id).not.toBeNull();
      expect(row.serial_number).toBe(serial.toUpperCase());
      expect(await countGyms(owner)).toBe(1);
    } finally {
      await cleanupOwner(owner);
    }
  });

  it('lets allowDuplicateSerial through the mint path', async () => {
    const owner = `${PREFIX}-mint-allow`;
    await insertUser(owner);
    try {
      const board = (await socialBoardMutations.createBoard(
        null,
        {
          input: {
            ...mintBaseInput,
            name: 'Mint Allowed Dup',
            locationName: `${PREFIX} Mint Allow Gym`,
            serialNumber: EXISTING_SERIAL,
            allowDuplicateSerial: true,
          },
        },
        authCtx(owner),
      )) as { uuid: string };
      const [row] = rowsFromResult<{ gym_id: number | null }>(
        await db.execute(sql`SELECT gym_id FROM user_boards WHERE uuid = ${board.uuid}`),
      );
      expect(row.gym_id).not.toBeNull();
    } finally {
      await cleanupOwner(owner);
    }
  });

  it('falls back to an unlinked board — through the guarded insert — when the gym mint fails', async () => {
    const owner = `${PREFIX}-fallback-ok`;
    const gymName = `${PREFIX} Fallback Gym`;
    const serial = `FALLBACK-${SERIAL_SUFFIX}`;
    await insertUser(owner);
    try {
      await withFailingGymMint(gymName, async () => {
        const board = (await socialBoardMutations.createBoard(
          null,
          {
            input: { ...mintBaseInput, layoutId: 99, name: 'Fallback Ok', locationName: gymName, serialNumber: serial },
          },
          authCtx(owner),
        )) as { uuid: string };
        const [row] = rowsFromResult<{ gym_id: number | null; serial_number: string | null }>(
          await db.execute(sql`SELECT gym_id, serial_number FROM user_boards WHERE uuid = ${board.uuid}`),
        );
        // Unlinked, but created — and the serial still landed, so the fallback
        // went through the same guarded insert the plain path uses.
        expect(row.gym_id).toBeNull();
        expect(row.serial_number).toBe(serial.toUpperCase());
        expect(await countGyms(owner)).toBe(0);
      });
    } finally {
      await cleanupOwner(owner);
    }
  });

  it('never uses the unlinked fallback to escape a serial rejection', async () => {
    const owner = `${PREFIX}-fallback-block`;
    const gymName = `${PREFIX} Fallback Block Gym`;
    await insertUser(owner);
    try {
      await withFailingGymMint(gymName, async () => {
        let thrown: unknown;
        try {
          await socialBoardMutations.createBoard(
            null,
            {
              input: {
                ...mintBaseInput,
                name: 'Fallback Block',
                locationName: gymName,
                serialNumber: EXISTING_SERIAL,
              },
            },
            authCtx(owner),
          );
        } catch (error) {
          thrown = error;
        }
        // The mint fails for two reasons at once here: the serial guard rejects,
        // and the gym insert would too. The rejection has to win — retrying
        // without the gym would create the very cross-owner duplicate the guard
        // just refused, and the failure would look like an auto-gym hiccup.
        // Two things hold that up, and either alone is enough: the rejection is
        // rethrown rather than read as a mint failure, and the fallback insert
        // runs the guard again regardless. Put main's bare, unguarded fallback
        // insert back and this case goes red.
        expect((thrown as { extensions?: Record<string, unknown> })?.extensions?.code).toBe('BOARD_SERIAL_EXISTS');
        expect(await countBoards(owner)).toBe(0);
      });
    } finally {
      await cleanupOwner(owner);
    }
  });
});

describe('serial pointer lock ordering', () => {
  it('locks an explicit choice row before the serial advisory lock', async () => {
    const tag = `${PREFIX}-explicit-choice-lock-order-${Date.now()}`;
    const serial = `CHOICE-LOCK-${SERIAL_SUFFIX}`;
    const userId = `${tag}-user`;
    const otherOwner = `${tag}-other-owner`;
    const chosenUuid = uuidv4();
    const otherUuid = uuidv4();
    const rowHolderReady = createValueBarrier<number>();
    const shouldAcquireSerial = createValueBarrier<boolean>();
    const serialLocked = createBarrier();
    const releaseRowHolder = createBarrier();
    let rowHolderPromise: Promise<void> | undefined;
    let choosePromise: ReturnType<typeof boardPresenceMutations.chooseBoardForSerial> | undefined;

    try {
      await Promise.all([insertUser(userId), insertUser(otherOwner)]);
      await insertBoard({
        uuid: chosenUuid,
        slug: `${tag}-chosen`,
        ownerId: userId,
        serialNumber: serial,
      });
      await insertBoard({
        uuid: otherUuid,
        slug: `${tag}-other`,
        ownerId: otherOwner,
        serialNumber: serial,
      });
      const [chosenBoard] = rowsFromResult<{ id: number }>(
        await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${chosenUuid}`),
      );

      rowHolderPromise = db.transaction(async (transaction) => {
        const [session] = rowsFromResult<{ pid: number }>(
          await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
        );
        await transaction.execute(sql`SELECT id FROM user_boards WHERE uuid = ${chosenUuid} FOR UPDATE`);
        rowHolderReady.release(Number(session.pid));
        if (await shouldAcquireSerial.promise) {
          await lockBoardSerialWrite(transaction, serial);
          serialLocked.release();
        }
        await releaseRowHolder.promise;
      });
      handleLater(rowHolderPromise);
      const rowHolderPid = await rowHolderReady.promise;

      choosePromise = boardPresenceMutations.chooseBoardForSerial(
        undefined,
        { boardId: Number(chosenBoard.id), serial },
        authCtx(userId),
      );
      handleLater(choosePromise);
      const choosingPid = await waitForRowWaitBlockedBy(rowHolderPid);

      // Before the fix, the FK check on user_board_serials.board_uuid waited
      // here while the chooser already held the serial lock. A concurrent
      // row→serial writer would then complete the deadlock cycle.
      expect(await grantedAdvisoryLockCount(choosingPid)).toBe(0);

      shouldAcquireSerial.release(true);
      await serialLocked.promise;
      releaseRowHolder.release();
      await rowHolderPromise;
      const chosen = await choosePromise;

      expect(chosen.boardId).toBe(Number(chosenBoard.id));
      expect(await serialPointerUuid(userId, serial)).toBe(chosenUuid);
    } finally {
      shouldAcquireSerial.release(false);
      releaseRowHolder.release();
      await Promise.allSettled([rowHolderPromise, choosePromise].filter((promise) => promise !== undefined));
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${chosenUuid}, ${otherUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${userId}, ${otherOwner})`);
    }
  });

  it('locks the legacy cross-owner auto-pick before the serial advisory lock', async () => {
    const tag = `${PREFIX}-legacy-auto-pick-lock-order-${Date.now()}`;
    const serial = `LEGACY-LOCK-${SERIAL_SUFFIX}`;
    const userId = `${tag}-user`;
    const firstOwner = `${tag}-first-owner`;
    const secondOwner = `${tag}-second-owner`;
    const firstUuid = uuidv4();
    const secondUuid = uuidv4();
    const rowHolderReady = createValueBarrier<number>();
    const shouldAcquireSerial = createValueBarrier<boolean>();
    const serialLocked = createBarrier();
    const releaseRowHolder = createBarrier();
    let rowHolderPromise: Promise<void> | undefined;
    let resolvePromise: ReturnType<typeof boardPresenceMutations.resolveBoardForSerial> | undefined;

    try {
      await Promise.all([insertUser(userId), insertUser(firstOwner), insertUser(secondOwner)]);
      // Oldest-first candidate ordering is the legacy fallback when the caller
      // owns none of the matching boards, so insert the expected pick first.
      await insertBoard({
        uuid: firstUuid,
        slug: `${tag}-first`,
        ownerId: firstOwner,
        serialNumber: serial,
      });
      await insertBoard({
        uuid: secondUuid,
        slug: `${tag}-second`,
        ownerId: secondOwner,
        serialNumber: serial,
      });
      const [firstBoard] = rowsFromResult<{ id: number }>(
        await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${firstUuid}`),
      );

      rowHolderPromise = db.transaction(async (transaction) => {
        const [session] = rowsFromResult<{ pid: number }>(
          await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
        );
        await transaction.execute(sql`SELECT id FROM user_boards WHERE uuid = ${firstUuid} FOR UPDATE`);
        rowHolderReady.release(Number(session.pid));
        if (await shouldAcquireSerial.promise) {
          await lockBoardSerialWrite(transaction, serial);
          serialLocked.release();
        }
        await releaseRowHolder.promise;
      });
      handleLater(rowHolderPromise);
      const rowHolderPid = await rowHolderReady.promise;

      resolvePromise = boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 99, sizeId: 10, setIds: '1,2' },
        authCtx(userId),
      );
      handleLater(resolvePromise);
      const resolvingPid = await waitForRowWaitBlockedBy(rowHolderPid);

      // Planning is serial-only and read-only. The write phase must wait on the
      // exact cross-owner parent row before it can own the serial lock.
      expect(await grantedAdvisoryLockCount(resolvingPid)).toBe(0);

      shouldAcquireSerial.release(true);
      await serialLocked.promise;
      releaseRowHolder.release();
      await rowHolderPromise;
      const resolved = await resolvePromise;

      expect(resolved.boardId).toBe(Number(firstBoard.id));
      expect(await serialPointerUuid(userId, serial)).toBe(firstUuid);
    } finally {
      shouldAcquireSerial.release(false);
      releaseRowHolder.release();
      await Promise.allSettled([rowHolderPromise, resolvePromise].filter((promise) => promise !== undefined));
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${firstUuid}, ${secondUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${userId}, ${firstOwner}, ${secondOwner})`);
    }
  });

  it('waits for the canonical row without retaining the serial and preserves a newer pointer', async () => {
    const tag = `${PREFIX}-pointer-heal-lock-order-${Date.now()}`;
    const serial = `HEAL-LOCK-${SERIAL_SUFFIX}`;
    const userId = `${tag}-user`;
    const loserOwner = `${tag}-loser-owner`;
    const canonicalOwner = `${tag}-canonical-owner`;
    const alternateOwner = `${tag}-alternate-owner`;
    const loserUuid = uuidv4();
    const canonicalUuid = uuidv4();
    const alternateUuid = uuidv4();
    const rowHolderReady = createValueBarrier<number>();
    const shouldAcquireSerial = createValueBarrier<boolean>();
    const serialLocked = createBarrier();
    const releaseRowHolder = createBarrier();
    let rowHolderPromise: Promise<void> | undefined;
    let lookupPromise: ReturnType<typeof findChosenBoardForSerial> | undefined;

    try {
      await Promise.all([
        insertUser(userId),
        insertUser(loserOwner),
        insertUser(canonicalOwner),
        insertUser(alternateOwner),
      ]);
      await insertBoard({
        uuid: canonicalUuid,
        slug: `${tag}-canonical`,
        ownerId: canonicalOwner,
        serialNumber: serial,
      });
      await insertBoard({
        uuid: alternateUuid,
        slug: `${tag}-alternate`,
        ownerId: alternateOwner,
        serialNumber: serial,
      });
      await insertBoard({
        uuid: loserUuid,
        slug: `${tag}-loser`,
        ownerId: loserOwner,
        serialNumber: serial,
        deleted: true,
        mergedInto: canonicalUuid,
      });
      await insertSerialPointer(userId, serial, loserUuid);
      const [canonicalBoard] = rowsFromResult<{ id: number }>(
        await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${canonicalUuid}`),
      );

      rowHolderPromise = db.transaction(async (transaction) => {
        const [session] = rowsFromResult<{ pid: number }>(
          await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
        );
        await transaction.execute(sql`SELECT id FROM user_boards WHERE uuid = ${canonicalUuid} FOR UPDATE`);
        rowHolderReady.release(Number(session.pid));
        if (await shouldAcquireSerial.promise) {
          await lockBoardSerialWrite(transaction, serial);
          await transaction.execute(sql`
            UPDATE user_board_serials
               SET board_uuid = ${alternateUuid}, updated_at = NOW()
             WHERE user_id = ${userId}
               AND serial_number = ${serial}
          `);
          serialLocked.release();
        }
        await releaseRowHolder.promise;
      });
      handleLater(rowHolderPromise);
      const rowHolderPid = await rowHolderReady.promise;

      lookupPromise = findChosenBoardForSerial(userId, serial);
      handleLater(lookupPromise);
      const healingPid = await waitForRowWaitBlockedBy(rowHolderPid);

      // The serial-first lookup is read-only. Its separate healer must be
      // waiting for the canonical row without retaining the serial lock.
      expect(await grantedAdvisoryLockCount(healingPid)).toBe(0);

      shouldAcquireSerial.release(true);
      await serialLocked.promise;
      releaseRowHolder.release();
      await rowHolderPromise;
      const chosen = await lookupPromise;

      expect(Number(chosen?.id)).toBe(Number(canonicalBoard.id));
      expect(await serialPointerUuid(userId, serial)).toBe(alternateUuid);
    } finally {
      shouldAcquireSerial.release(false);
      releaseRowHolder.release();
      await Promise.allSettled([rowHolderPromise, lookupPromise].filter((promise) => promise !== undefined));
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${loserUuid}, ${canonicalUuid}, ${alternateUuid})`);
      await db.execute(
        sql`DELETE FROM users WHERE id IN (${userId}, ${loserOwner}, ${canonicalOwner}, ${alternateOwner})`,
      );
    }
  });

  it('locks the linked board row before recordBoardSerial writes the pointer', async () => {
    const tag = `${PREFIX}-record-serial-lock-order-${Date.now()}`;
    const serial = `RECORD-LOCK-${SERIAL_SUFFIX}`;
    const userId = `${tag}-user`;
    const linkedUuid = uuidv4();
    const rowHolderReady = createValueBarrier<number>();
    const shouldTouchPointer = createValueBarrier<boolean>();
    const releaseRowHolder = createBarrier();
    let rowHolderPromise: Promise<void> | undefined;
    let recordPromise: ReturnType<typeof socialBoardMutations.recordBoardSerial> | undefined;

    try {
      await insertUser(userId);
      // The board the BLE connect links to. It carries no serial of its own, so
      // recordBoardSerial finds no config-matching saved board to short-circuit
      // on and really performs its upsert.
      await insertBoard({ uuid: linkedUuid, slug: `${tag}-linked`, ownerId: userId, layoutId: 71 });
      // An existing recording with no board link — the first-connect shape. The
      // upsert therefore takes the ON CONFLICT DO UPDATE path AND changes
      // board_uuid, so the FK check actually runs. PostgreSQL skips it when the
      // key is unchanged, which is why steady-state reconnects never armed this.
      await insertSerialPointer(userId, serial, null);

      rowHolderPromise = db.transaction(async (transaction) => {
        const [session] = rowsFromResult<{ pid: number }>(
          await transaction.execute(sql`SELECT pg_backend_pid() AS pid`),
        );
        await transaction.execute(sql`SELECT id FROM user_boards WHERE uuid = ${linkedUuid} FOR UPDATE`);
        rowHolderReady.release(Number(session.pid));
        if (await shouldTouchPointer.promise) {
          // What pointer healing, serial resolution and the dedupe merge all do
          // next: write this user's pointer row while still holding the board
          // row. Before the fix that blocked on the pointer row recordBoardSerial
          // had already taken while waiting for this board row, and PostgreSQL
          // broke the cycle by killing one of the two transactions.
          await transaction.execute(sql`
            UPDATE user_board_serials
               SET updated_at = NOW()
             WHERE user_id = ${userId}
               AND serial_number = ${serial}
          `);
        }
        await releaseRowHolder.promise;
      });
      handleLater(rowHolderPromise);
      const rowHolderPid = await rowHolderReady.promise;

      recordPromise = socialBoardMutations.recordBoardSerial(
        null,
        {
          input: {
            serialNumber: serial,
            boardName: 'kilter',
            layoutId: 71,
            sizeId: 10,
            setIds: '1,2',
            boardUuid: linkedUuid,
          },
        },
        authCtx(userId),
      );
      handleLater(recordPromise);
      const recordingPid = await waitForRowWaitBlockedBy(rowHolderPid);

      // Waiting on the board row while holding nothing else. The serial advisory
      // lock must stay untouched here too: taking it before this FK wait would
      // just move the same inversion one hop out, against every row→serial writer.
      expect(await grantedAdvisoryLockCount(recordingPid)).toBe(0);

      shouldTouchPointer.release(true);
      releaseRowHolder.release();
      // Both must complete. Awaited together so whichever transaction PostgreSQL
      // picks as a deadlock victim surfaces as a rejection here.
      const [, recorded] = await Promise.all([rowHolderPromise, recordPromise]);

      expect(recorded?.boardUuid).toBe(linkedUuid);
      expect(await serialPointerUuid(userId, serial)).toBe(linkedUuid);
    } finally {
      shouldTouchPointer.release(false);
      releaseRowHolder.release();
      await Promise.allSettled([rowHolderPromise, recordPromise].filter((promise) => promise !== undefined));
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid = ${linkedUuid}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    }
  });
});

describe('serial choices during a board merge', () => {
  it('legacy auto-pick stores the surviving board after a concurrent merge', async () => {
    const tag = `${PREFIX}-legacy-choice-race-${Date.now()}`;
    const serial = `LEGACY-${SERIAL_SUFFIX}`;
    const userId = `${tag}-user`;
    const loserOwner = `${tag}-loser-owner`;
    const canonicalOwner = `${tag}-canonical-owner`;
    const loserUuid = uuidv4();
    const canonicalUuid = uuidv4();
    const mergeReady = createValueBarrier<number>();
    const releaseMerge = createBarrier();
    let mergePromise: Promise<void> | undefined;
    let resolvePromise: ReturnType<typeof boardPresenceMutations.resolveBoardForSerial> | undefined;

    try {
      await Promise.all([insertUser(userId), insertUser(loserOwner), insertUser(canonicalOwner)]);
      await insertBoard({ uuid: loserUuid, slug: `${tag}-loser`, ownerId: loserOwner, serialNumber: serial });
      await insertBoard({
        uuid: canonicalUuid,
        slug: `${tag}-canonical`,
        ownerId: canonicalOwner,
        serialNumber: serial,
      });

      mergePromise = tombstoneBoardUnderSerialLock(serial, loserUuid, canonicalUuid, mergeReady, releaseMerge.promise);
      handleLater(mergePromise);
      const mergePid = await mergeReady.promise;

      resolvePromise = boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial, boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
        authCtx(userId),
      );
      handleLater(resolvePromise);
      await waitForAdvisoryWaitBlockedBy(mergePid);

      releaseMerge.release();
      await mergePromise;
      const resolved = await resolvePromise;
      const [canonical] = rowsFromResult<{ id: number }>(
        await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${canonicalUuid}`),
      );
      expect(resolved.boardId).toBe(Number(canonical.id));
      expect(await serialPointerUuid(userId, serial)).toBe(canonicalUuid);
    } finally {
      releaseMerge.release();
      await Promise.allSettled([mergePromise, resolvePromise]);
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${loserUuid}, ${canonicalUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${userId}, ${loserOwner}, ${canonicalOwner})`);
    }
  });

  it('explicit choice rejects a board tombstoned by a concurrent merge', async () => {
    const tag = `${PREFIX}-explicit-choice-race-${Date.now()}`;
    const serial = `EXPLICIT-${SERIAL_SUFFIX}`;
    const userId = `${tag}-user`;
    const loserOwner = `${tag}-loser-owner`;
    const canonicalOwner = `${tag}-canonical-owner`;
    const loserUuid = uuidv4();
    const canonicalUuid = uuidv4();
    const mergeReady = createValueBarrier<number>();
    const releaseMerge = createBarrier();
    let mergePromise: Promise<void> | undefined;
    let choosePromise: ReturnType<typeof boardPresenceMutations.chooseBoardForSerial> | undefined;

    try {
      await Promise.all([insertUser(userId), insertUser(loserOwner), insertUser(canonicalOwner)]);
      await insertBoard({ uuid: loserUuid, slug: `${tag}-loser`, ownerId: loserOwner, serialNumber: serial });
      await insertBoard({
        uuid: canonicalUuid,
        slug: `${tag}-canonical`,
        ownerId: canonicalOwner,
        serialNumber: serial,
      });
      const [loser] = rowsFromResult<{ id: number }>(
        await db.execute(sql`SELECT id FROM user_boards WHERE uuid = ${loserUuid}`),
      );

      mergePromise = tombstoneBoardUnderSerialLock(serial, loserUuid, canonicalUuid, mergeReady, releaseMerge.promise);
      handleLater(mergePromise);
      const mergePid = await mergeReady.promise;

      choosePromise = boardPresenceMutations.chooseBoardForSerial(
        undefined,
        { boardId: Number(loser.id), serial },
        authCtx(userId),
      );
      handleLater(choosePromise);
      const choosingPid = await waitForRowWaitBlockedBy(mergePid);
      expect(await grantedAdvisoryLockCount(choosingPid)).toBe(0);

      releaseMerge.release();
      await mergePromise;
      const [outcome] = await Promise.allSettled([choosePromise]);
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect((outcome.reason as { extensions?: Record<string, unknown> }).extensions?.code).toBe('NOT_FOUND');
      }
      expect(await serialPointerUuid(userId, serial)).toBeNull();
    } finally {
      releaseMerge.release();
      await Promise.allSettled([mergePromise, choosePromise]);
      await db.execute(sql`DELETE FROM user_board_serials WHERE serial_number = ${serial}`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${loserUuid}, ${canonicalUuid})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${userId}, ${loserOwner}, ${canonicalOwner})`);
    }
  });
});
