import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { MAX_BOARDS_PER_ACCOUNT } from '../graphql/resolvers/social/board-limits';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for the per-account board cap.
 *
 * Until #4174 the `user_boards_unique_owner_config` index was an accidental
 * ceiling on boards per account: the hardware catalog is finite and an owner
 * could only have one board per configuration. Dropping it was right, but it
 * left nothing bounding mint volume, and `allowDuplicateConfig` is a flag a
 * client can set on every call.
 *
 * The cap is seeded through direct SQL rather than N resolver calls, both
 * because createBoard's rate limiter allows only 10 per bucket and because 50
 * round trips would dominate the suite's runtime.
 */

const OWNER = 'board-cap-owner';
const OTHER = 'board-cap-other';
const ALL_USERS = [OWNER, OTHER];

// Real MoonBoard hardware, so `assertKnownBoardConfig` accepts it without any
// Aurora catalog fixtures.
const CONFIG = { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' };
// A second real configuration, for the board the BLE bind path should find.
const OTHER_CONFIG = { boardType: 'moonboard', layoutId: 2, sizeId: 1, setIds: '2,3' };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function seedBoard(opts: {
  ownerId?: string;
  config?: { boardType: string; layoutId: number; sizeId: number; setIds: string };
  deleted?: boolean;
  name?: string;
}): Promise<number> {
  const uuid = uuidv4();
  const config = opts.config ?? CONFIG;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, deleted_at, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${opts.ownerId ?? OWNER}, ${config.boardType}, ${config.layoutId}, ${config.sizeId},
            ${config.setIds}, ${opts.name ?? 'Seeded board'}, true, ${opts.deleted ? sql`now()` : null}, now(), now())
    RETURNING id
  `);
  return Number(Array.from(result as Iterable<{ id: number }>)[0].id);
}

/** Seed `count` live boards for OWNER in one statement per board. */
async function seedBoards(count: number, opts: { deleted?: boolean } = {}): Promise<void> {
  for (let index = 0; index < count; index++) {
    await seedBoard({ name: `Seeded board ${index}`, deleted: opts.deleted });
  }
}

const liveBoardCount = async (ownerId = OWNER): Promise<number> => {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count FROM user_boards WHERE owner_id = ${ownerId} AND deleted_at IS NULL
  `);
  return Number(Array.from(result as Iterable<{ count: number }>)[0].count);
};

const createBoard = (input: Record<string, unknown> = {}, userId = OWNER) =>
  socialBoardMutations.createBoard(
    null,
    { input: { ...CONFIG, name: 'One more board', ...input } },
    authCtx(userId),
  ) as Promise<{ uuid: string }>;

/** The thrown error's extensions, or null when the call succeeded. Rethrows anything else. */
async function captureLimitReached(promise: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const extensions = (error as { extensions?: Record<string, unknown> }).extensions;
    if (extensions?.code !== 'BOARD_LIMIT_REACHED') throw error;
    return extensions;
  }
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
  // Seeding the cap costs more calls than the createBoard bucket allows, so the
  // limiter is cleared right before the assertion that matters.
  resetAllRateLimits();
});

describe('per-account board cap', () => {
  it('refuses another board once the account is at the cap, and adds no row', async () => {
    await seedBoards(MAX_BOARDS_PER_ACCOUNT);
    resetAllRateLimits();

    const extensions = await captureLimitReached(createBoard());

    expect(extensions).not.toBeNull();
    expect(extensions?.maxBoards).toBe(MAX_BOARDS_PER_ACCOUNT);
    expect(await liveBoardCount()).toBe(MAX_BOARDS_PER_ACCOUNT);
  });

  it('still creates the board that takes the account TO the cap', async () => {
    // The pair to the test above: a cap that refuses one board early is a bug
    // for every user who legitimately reaches it.
    await seedBoards(MAX_BOARDS_PER_ACCOUNT - 1);
    resetAllRateLimits();

    const created = await createBoard({ allowDuplicateConfig: true });

    expect(created.uuid).toBeTruthy();
    expect(await liveBoardCount()).toBe(MAX_BOARDS_PER_ACCOUNT);
  });

  it('is not bypassed by allowDuplicateConfig', async () => {
    // That flag skips the duplicate guard, which is the one path that can add
    // unlimited same-config boards — so the cap has to sit in front of it.
    await seedBoards(MAX_BOARDS_PER_ACCOUNT);
    resetAllRateLimits();

    const extensions = await captureLimitReached(createBoard({ allowDuplicateConfig: true }));

    expect(extensions).not.toBeNull();
    expect(await liveBoardCount()).toBe(MAX_BOARDS_PER_ACCOUNT);
  });

  it('does not count boards the user deleted', async () => {
    // Deleting a board you no longer use is the remedy the error message names,
    // so it has to actually free a slot.
    await seedBoards(MAX_BOARDS_PER_ACCOUNT - 1);
    await seedBoards(5, { deleted: true });
    resetAllRateLimits();

    const created = await createBoard({ allowDuplicateConfig: true });

    expect(created.uuid).toBeTruthy();
  });

  it('does not count another account’s boards', async () => {
    await seedBoards(MAX_BOARDS_PER_ACCOUNT);
    resetAllRateLimits();

    const created = await createBoard({}, OTHER);

    expect(created.uuid).toBeTruthy();
  });

  it('refuses to mint a board for an unknown BLE serial at the cap', async () => {
    // The serial path creates boards too, so it gets the same backstop. The
    // seeded boards are all on CONFIG, so a serial reporting OTHER_CONFIG has
    // nothing to bind to and takes the create branch.
    await seedBoards(MAX_BOARDS_PER_ACCOUNT);
    resetAllRateLimits();

    const extensions = await captureLimitReached(
      boardPresenceMutations.resolveBoardForSerial(
        undefined,
        { serial: 'CAP-NEW-SERIAL', ...OTHER_CONFIG },
        authCtx(OWNER),
      ),
    );

    expect(extensions).not.toBeNull();
    expect(await liveBoardCount()).toBe(MAX_BOARDS_PER_ACCOUNT);
  });

  it('still binds a BLE serial onto a board the account already owns at the cap', async () => {
    // Connecting to a wall you already have adds no row, so it must keep working
    // at the cap — otherwise reaching the limit would lock a climber out of
    // their own boards.
    await seedBoards(MAX_BOARDS_PER_ACCOUNT - 1);
    const existingBoardId = await seedBoard({ config: OTHER_CONFIG, name: 'The connected wall' });
    resetAllRateLimits();

    const resolved = await boardPresenceMutations.resolveBoardForSerial(
      undefined,
      { serial: 'CAP-BIND-SERIAL', ...OTHER_CONFIG },
      authCtx(OWNER),
    );

    expect(resolved.boardId).toBe(existingBoardId);
    expect(await liveBoardCount()).toBe(MAX_BOARDS_PER_ACCOUNT);
  });
});
