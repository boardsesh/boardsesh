import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for createBoard's duplicate-config guard.
 *
 * The rule is "same config AND same place", not "same config" — issue #4166 was
 * a climber who owned a MoonBoard 2024 Standard at one gym and spent a week
 * failing to add another at a new gym. The `sameConfigFarApart` case below is
 * the regression test for that; it fails against the old resolver AND the old
 * `user_boards_unique_owner_config` index, both of which this change removed.
 *
 * Seeds via raw SQL and calls the resolver directly against the per-worker test
 * DB (plain postgres — no PostGIS), mirroring find-similar-gyms-and-auto-gym.
 */

const OWNER = 'dup-guard-owner';
const OTHER = 'dup-guard-other';
const ALL_USERS = [OWNER, OTHER];

const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m — same building
const LAT_2KM = 47.0 + 0.018; // ~2 km — a different gym

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type CreatedBoard = { uuid: string; name: string; gymId: number | null };

/** The same physical configuration every time — the guard's other half is location. */
const CONFIG = { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' };

const createBoard = (input: Record<string, unknown>, userId = OWNER) =>
  socialBoardMutations.createBoard(
    null,
    { input: { ...CONFIG, name: 'A board', ...input } },
    authCtx(userId),
  ) as Promise<CreatedBoard>;

const countBoards = async (): Promise<number> => {
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM user_boards WHERE deleted_at IS NULL`);
  return Number(Array.from(result as Iterable<{ count: number }>)[0].count);
};

/** The thrown GraphQLError's extensions, or null when it wasn't a duplicate rejection. */
async function captureDuplicate(promise: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const extensions = (error as { extensions?: Record<string, unknown> }).extensions;
    return extensions?.code === 'BOARD_DUPLICATE_CONFIG' ? extensions : null;
  }
}

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('createBoard duplicate-config guard', () => {
  it('rejects the same config at the same coordinates, naming the existing board', async () => {
    const first = await createBoard({
      name: 'Klimmuur MoonBoard',
      locationName: 'Klimmuur',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });

    const extensions = await captureDuplicate(
      createBoard({
        name: 'Another MoonBoard',
        locationName: 'Klimmuur',
        latitude: LAT_60M,
        longitude: BASE.longitude,
      }),
    );

    expect(extensions).not.toBeNull();
    // The client offers "use that board" straight from the error, so the
    // existing board's identity has to travel with it.
    expect(extensions?.existingBoardUuid).toBe(first.uuid);
    expect(extensions?.existingBoardName).toBe('Klimmuur MoonBoard');
    expect(extensions?.existingBoardLocationName).toBe('Klimmuur');
    expect(await countBoards()).toBe(1);
  });

  it('allows the same config ~2 km away — the #4166 regression', async () => {
    await createBoard({
      name: 'Klimmuur MoonBoard',
      locationName: 'Klimmuur',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });

    const second = await createBoard({
      name: 'Boulder Space MoonBoard',
      locationName: 'Boulder Space',
      latitude: LAT_2KM,
      longitude: BASE.longitude,
    });

    expect(second.name).toBe('Boulder Space MoonBoard');
    expect(await countBoards()).toBe(2);
  });

  it('allows the same config under a different location name when neither has coordinates', async () => {
    await createBoard({ name: 'Home wall', locationName: 'Garage' });
    await createBoard({ name: 'Gym wall', locationName: 'Klimmuur' });
    expect(await countBoards()).toBe(2);
  });

  it('rejects the same config when neither board says where it is', async () => {
    await createBoard({ name: 'First' });
    const extensions = await captureDuplicate(createBoard({ name: 'Second' }));
    expect(extensions).not.toBeNull();
    expect(await countBoards()).toBe(1);
  });

  it('creates anyway when the user confirms it is a different wall', async () => {
    await createBoard({ name: 'First' });
    const second = await createBoard({ name: 'Second', allowDuplicateConfig: true });
    expect(second.name).toBe('Second');
    expect(await countBoards()).toBe(2);
  });

  it('creates two identical boards at the same place when confirmed', async () => {
    // Two of the same wall in one gym is legal. Proves no unique index survives:
    // with `user_boards_unique_owner_config` in place this fails on a 23505.
    const shared = { locationName: 'Klimmuur', latitude: BASE.latitude, longitude: BASE.longitude };
    await createBoard({ name: 'MoonBoard 1', ...shared });
    await createBoard({ name: 'MoonBoard 2', ...shared, allowDuplicateConfig: true });
    expect(await countBoards()).toBe(2);
  });

  it('recognises the same hold sets stored in a different order', async () => {
    // The old guard compared set_ids as a raw string, so a re-ticked set could
    // slip past it while the client's normalised check said it was a duplicate.
    await createBoard({ name: 'First', setIds: '10,9,8,7,6,5' });
    const extensions = await captureDuplicate(createBoard({ name: 'Second', setIds: '5,6,7,8,9,10' }));
    expect(extensions).not.toBeNull();
    expect(await countBoards()).toBe(1);
  });

  it('does not block one user because another owns the same board', async () => {
    await createBoard({ name: 'Shared setup' }, OWNER);
    const other = await createBoard({ name: 'Shared setup' }, OTHER);
    expect(other.uuid).toBeTruthy();
    expect(await countBoards()).toBe(2);
  });

  it('does not block a genuinely different configuration', async () => {
    await createBoard({ name: 'First' });
    await createBoard({ name: 'Second', setIds: '5,6,7' });
    expect(await countBoards()).toBe(2);
  });
});
