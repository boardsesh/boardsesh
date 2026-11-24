import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { count, eq, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * createBoard's mint path falls back to an unlinked board when the gym can't
 * be created. That fallback never runs the existing-wall check, so a failure
 * of the check itself (a dropped connection, a failed lock) must fail the
 * create rather than fall through to it (#8151 review). Its own file because
 * it replaces assertNoExistingWalls with a spy for every test in the module.
 */

vi.mock('../graphql/resolvers/social/existing-wall-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/social/existing-wall-check')>();
  return { ...actual, assertNoExistingWalls: vi.fn(actual.assertNoExistingWalls) };
});

const { assertNoExistingWalls } = await import('../graphql/resolvers/social/existing-wall-check');
const { db } = await import('../db/client');
const dbSchema = await import('@boardsesh/db/schema');
const { socialBoardMutations } = await import('../graphql/resolvers/social/boards');
const { resetAllRateLimits } = await import('../utils/rate-limiter');

const CLIMBER = 'wall-check-mint-failure-climber';

const authCtx = (userId: string): ConnectionContext =>
  ({
    connectionId: `conn-${userId}-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId,
  }) as ConnectionContext;

async function countOwnedBy(table: typeof dbSchema.userBoards | typeof dbSchema.gyms): Promise<number> {
  const [row] = await db.select({ total: count() }).from(table).where(eq(table.ownerId, CLIMBER));
  return Number(row.total);
}

beforeEach(async () => {
  resetAllRateLimits();
  vi.mocked(assertNoExistingWalls).mockClear();
  await db.execute(sql`
    TRUNCATE TABLE "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${CLIMBER}, ${CLIMBER + '@test.com'}, ${CLIMBER}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
});

describe('createBoard mint path with the existing-wall check', () => {
  it('fails the create, with no board and no gym, when the check itself fails', async () => {
    const lookupFailure = new Error('connection reset during wall lookup');
    vi.mocked(assertNoExistingWalls).mockRejectedValueOnce(lookupFailure);

    await expect(
      socialBoardMutations.createBoard(
        null,
        {
          input: {
            boardType: 'moonboard',
            layoutId: 5,
            sizeId: 1,
            setIds: '17,18,19,20',
            name: 'Garage MoonBoard',
            locationName: 'My garage',
            latitude: 47.0,
            longitude: 8.0,
            existingWallCheck: 'REJECT_IF_FOUND',
          },
        },
        authCtx(CLIMBER),
      ),
    ).rejects.toBe(lookupFailure);

    expect(assertNoExistingWalls).toHaveBeenCalledTimes(1);
    expect(await countOwnedBy(dbSchema.userBoards)).toBe(0);
    expect(await countOwnedBy(dbSchema.gyms)).toBe(0);
  });
});
