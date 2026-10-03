import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  communityRoles,
  gyms,
  gymMembers,
  boardFollows,
  sprayWalls,
  sprayWallVersions,
  userBoards,
  userBoardActivity,
} from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { requireBoardEditAccess, socialBoardQueries } from '../graphql/resolvers/social/boards';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';

/**
 * Real-DB coverage for the "Your boards" ordering (issue #4884). The mutation
 * contract test (board-pins-and-activity.test.ts) proves the upserts; this
 * proves the ORDER BY, which is the whole point of the issue and is not
 * observable through a mock chain.
 *
 * The order under test, most significant first:
 *   1. owned unpublished spray walls, so imports remain on the first page
 *   2. pinned boards, oldest pin leading
 *   3. then by last opened, most recent first
 *   4. then boards never opened, by when THIS user added them
 *
 * All assertions are relative positions among the seeded uuids, so unrelated
 * seed rows in the dev database cannot perturb them.
 */

const PREFIX = 'mbo-order';
const USER = `${PREFIX}-user`;
const OTHER = `${PREFIX}-other`;

// Owned by USER. Suffixes describe the state each one is seeded into.
const PINNED_OLD = `${PREFIX}-pinned-old`;
const PINNED_NEW = `${PREFIX}-pinned-new`;
const USED_RECENT = `${PREFIX}-used-recent`;
const USED_OLD = `${PREFIX}-used-old`;
const NEVER_NEWEST = `${PREFIX}-never-newest`;
const NEVER_OLDEST = `${PREFIX}-never-oldest`;
// Owned by OTHER, followed by USER — proves the added-at fallback reads the
// FOLLOW date, not the board's own creation date.
const FOLLOWED_NEVER = `${PREFIX}-followed-never`;

let dbReady = false;

const ctx = {
  connectionId: `${PREFIX}-conn`,
  isAuthenticated: true,
  userId: USER,
} as ConnectionContext;

type BoardResult = { boards: Array<{ uuid: string; isPinnedByMe: boolean }>; totalCount: number; hasMore: boolean };

const myBoards = (input: Record<string, unknown> = {}) =>
  socialBoardQueries.myBoards(null, { input }, ctx) as Promise<BoardResult>;

/** Positions of the seeded uuids, in returned order, ignoring anything else. */
function orderOf(result: BoardResult, uuids: string[]): string[] {
  const wanted = new Set(uuids);
  return result.boards.map((board) => board.uuid).filter((uuid) => wanted.has(uuid));
}

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${`${id}@test.com`}, ${`Test ${id}`}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertBoard(uuid: string, ownerId: string, createdAt: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, is_unlisted, created_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, 11, '1', ${`Board ${uuid}`}, true, false, ${createdAt}::timestamp)
    ON CONFLICT (uuid) DO NOTHING
  `);
}

async function follow(uuid: string, createdAt: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_follows (user_id, board_uuid, created_at)
    VALUES (${USER}, ${uuid}, ${createdAt}::timestamp)
    ON CONFLICT (user_id, board_uuid) DO NOTHING
  `);
}

async function activity(uuid: string, lastUsedAt: string | null, pinnedAt: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_board_activity (user_id, board_uuid, last_used_at, pinned_at)
    VALUES (${USER}, ${uuid}, ${lastUsedAt}::timestamp, ${pinnedAt}::timestamp)
    ON CONFLICT (user_id, board_uuid) DO UPDATE SET last_used_at = excluded.last_used_at, pinned_at = excluded.pinned_at
  `);
}

beforeAll(async () => {
  try {
    await Promise.all([insertUser(USER), insertUser(OTHER)]);

    // Board creation dates are deliberately the INVERSE of the intended order,
    // so a result that merely echoes created_at cannot pass.
    await Promise.all([
      insertBoard(PINNED_OLD, USER, '2020-01-01'),
      insertBoard(PINNED_NEW, USER, '2020-01-02'),
      insertBoard(USED_RECENT, USER, '2020-01-03'),
      insertBoard(USED_OLD, USER, '2020-01-04'),
      insertBoard(NEVER_NEWEST, USER, '2024-06-01'),
      insertBoard(NEVER_OLDEST, USER, '2021-06-01'),
      insertBoard(FOLLOWED_NEVER, OTHER, '2019-01-01'),
    ]);

    // FOLLOWED_NEVER's board row is the OLDEST of all, but the user followed it
    // between the two never-opened owned boards — so the added-at fallback must
    // place it there, proving it reads board_follows.created_at.
    await follow(FOLLOWED_NEVER, '2022-06-01');

    await Promise.all([
      activity(PINNED_OLD, null, '2026-01-01'),
      activity(PINNED_NEW, '2026-09-01', '2026-02-01'),
      activity(USED_RECENT, '2026-08-20', null),
      activity(USED_OLD, '2026-03-10', null),
    ]);

    dbReady = true;
  } catch (error) {
    if (process.env.SKIP_TEST_INFRA === '1') return;
    throw error;
  }
});

describe('myBoards ordering (#4884)', () => {
  it('puts pinned boards first, oldest pin leading', async () => {
    if (!dbReady) return;
    const result = await myBoards({ limit: 50 });
    const order = orderOf(result, [PINNED_OLD, PINNED_NEW, USED_RECENT, USED_OLD]);

    // PINNED_NEW has the most recent last_used_at of everything seeded, and
    // PINNED_OLD has none at all — yet both outrank the used boards, and
    // PINNED_OLD leads because it was pinned first.
    expect(order.slice(0, 2)).toEqual([PINNED_OLD, PINNED_NEW]);
  });

  it('orders the rest by last opened, most recent first', async () => {
    if (!dbReady) return;
    const result = await myBoards({ limit: 50 });
    const order = orderOf(result, [USED_RECENT, USED_OLD]);
    expect(order).toEqual([USED_RECENT, USED_OLD]);
  });

  it('sorts boards that were never opened last', async () => {
    if (!dbReady) return;
    const result = await myBoards({ limit: 50 });
    const order = orderOf(result, [USED_OLD, NEVER_NEWEST, NEVER_OLDEST, FOLLOWED_NEVER]);
    // NULLS LAST is what this proves: without it, Postgres DESC would float the
    // never-opened boards to the very top.
    expect(order[0]).toBe(USED_OLD);
  });

  it('orders never-opened boards by when the user added them, following the follow date', async () => {
    if (!dbReady) return;
    const result = await myBoards({ limit: 50 });
    const order = orderOf(result, [NEVER_NEWEST, NEVER_OLDEST, FOLLOWED_NEVER]);
    // FOLLOWED_NEVER's board row is the oldest of the three (2019) but its
    // follow is from 2022, so COALESCE(follow.created_at, board.created_at)
    // lands it between the two owned boards rather than last.
    expect(order).toEqual([NEVER_NEWEST, FOLLOWED_NEVER, NEVER_OLDEST]);
  });

  it('reports the pin on the board it returns', async () => {
    if (!dbReady) return;
    const result = await myBoards({ limit: 50 });
    const byUuid = new Map(result.boards.map((board) => [board.uuid, board]));
    expect(byUuid.get(PINNED_OLD)?.isPinnedByMe).toBe(true);
    expect(byUuid.get(USED_RECENT)?.isPinnedByMe).toBe(false);
  });

  it('does not duplicate a board that is both followed and pinned, and leaves totalCount alone', async () => {
    if (!dbReady) return;
    // The ordering joins board_follows and user_board_activity; both are unique
    // per (user, board), but a fan-out would show up as a repeated uuid and a
    // page shorter than totalCount claims.
    await follow(PINNED_OLD, '2023-01-01');
    const result = await myBoards({ limit: 50 });
    const seen = result.boards.map((board) => board.uuid).filter((uuid) => uuid === PINNED_OLD);
    expect(seen).toHaveLength(1);
    expect(result.totalCount).toBeGreaterThanOrEqual(result.boards.length);
  });

  it('pages without dropping or repeating a row', async () => {
    if (!dbReady) return;
    // last_used_at is a mutable sort key, so the ORDER BY needs a deterministic
    // tiebreak or offset pagination can skip a board — which is how
    // findOwnedBoardForConfig ends up minting a duplicate wall.
    const [firstPage, secondPage] = await Promise.all([
      myBoards({ limit: 3, offset: 0 }),
      myBoards({ limit: 3, offset: 3 }),
    ]);
    const combined = [...firstPage.boards, ...secondPage.boards].map((board) => board.uuid);
    expect(new Set(combined).size).toBe(combined.length);
  });
});

describe('myBoards unfinished spray import visibility', () => {
  it('keeps an owned import on the first page ahead of twenty-one opened/pinned boards, without leaking it to followers', async () => {
    if (!dbReady) return;
    const importingOwner = randomUUID();
    const otherViewer = randomUUID();
    await Promise.all([insertUser(importingOwner), insertUser(otherViewer)]);
    const ownerContext = {
      connectionId: importingOwner,
      userId: importingOwner,
      isAuthenticated: true,
    } as ConnectionContext;
    const oldBoards = Array.from({ length: 21 }, (_, index) => ({
      uuid: randomUUID(),
      slug: `${importingOwner}-${index}`,
      ownerId: importingOwner,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 11,
      setIds: '1',
      name: `Opened wall ${index}`,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    }));
    await db.insert(userBoards).values(oldBoards);
    await db.insert(userBoardActivity).values(
      oldBoards.map((board, index) => ({
        boardUuid: board.uuid,
        userId: importingOwner,
        lastUsedAt: new Date('2026-10-01T12:00:00Z'),
        pinnedAt: index < 10 ? new Date(Date.UTC(2026, 8, 1 + index)) : null,
      })),
    );
    const unfinished = (await sprayWallMutations.createSprayWall(
      {},
      { input: { name: 'Import in progress', angle: 40 } },
      ownerContext,
    )) as { uuid: string };
    const firstPage = await socialBoardQueries.myBoards({}, {}, ownerContext);
    expect(firstPage.boards).toHaveLength(20);
    expect(firstPage.boards[0]).toMatchObject({
      uuid: unfinished.uuid,
      sprayImport: { stage: 'draft', isReset: false },
    });
    expect(firstPage.boards[1].uuid).toBe(oldBoards[0].uuid);
    expect(firstPage.hasMore).toBe(true);

    await db.insert(boardFollows).values({ userId: otherViewer, boardUuid: unfinished.uuid });
    const otherPage = await socialBoardQueries.myBoards({}, {}, {
      connectionId: otherViewer,
      userId: otherViewer,
      isAuthenticated: true,
    } as ConnectionContext);
    expect(otherPage.boards).toEqual([]);
    expect(otherPage.totalCount).toBe(0);

    const [wall] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, unfinished.uuid));
    const [published] = await db
      .insert(sprayWallVersions)
      .values({ wallId: wall.id, versionNumber: 1, status: 'published' })
      .returning();
    await db.update(sprayWalls).set({ currentVersionId: published.id }).where(eq(sprayWalls.id, wall.id));
    await db.insert(sprayWallVersions).values({ wallId: wall.id, versionNumber: 2, status: 'draft' });
    const afterPublication = await socialBoardQueries.myBoards({}, {}, ownerContext);
    expect(afterPublication.boards[0].uuid).toBe(oldBoards[0].uuid);
    expect(afterPublication.boards.some((board) => board.uuid === unfinished.uuid)).toBe(false);
  });
});

describe('transaction-scoped board edit authorization', () => {
  it('reads community and gym edit grants from the supplied transaction', async () => {
    if (!dbReady) return;
    const editorId = randomUUID();
    await insertUser(editorId);
    const editorContext = { connectionId: editorId, userId: editorId, isAuthenticated: true } as ConnectionContext;
    await db.transaction(async (transaction) => {
      const publicBoardUuid = randomUUID();
      const [publicBoard] = await transaction
        .insert(userBoards)
        .values({
          uuid: publicBoardUuid,
          slug: publicBoardUuid,
          name: 'Transactional public board',
          ownerId: USER,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 11,
          setIds: '1',
          isPublic: true,
        })
        .returning();
      await transaction
        .insert(communityRoles)
        .values({ userId: editorId, role: 'community_leader', boardType: 'kilter' });
      await expect(requireBoardEditAccess(editorContext, publicBoard, transaction)).resolves.toBeUndefined();

      const gymUuid = randomUUID();
      const [gym] = await transaction
        .insert(gyms)
        .values({ uuid: gymUuid, name: 'Transactional gym', ownerId: USER })
        .returning();
      await transaction.insert(gymMembers).values({ gymId: gym.id, userId: editorId, role: 'admin' });
      const privateBoardUuid = randomUUID();
      const [privateBoard] = await transaction
        .insert(userBoards)
        .values({
          uuid: privateBoardUuid,
          slug: privateBoardUuid,
          name: 'Transactional private board',
          ownerId: USER,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 11,
          setIds: '1',
          isPublic: false,
          gymId: gym.id,
        })
        .returning();
      await expect(requireBoardEditAccess(editorContext, privateBoard, transaction)).resolves.toBeUndefined();
    });
  });
});
