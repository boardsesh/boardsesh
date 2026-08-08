import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for updateBoard's duplicate-config guard.
 *
 * updateBoard used to enforce the strict per-owner config uniqueness that #4174
 * removed from createBoard and from the database: no place dimension, no
 * override, raw-string set-id equality, and a plain Error the clients could only
 * string-match. A gym reconfiguring one wall to match another of its own walls
 * hard-failed, and the only workaround (delete + recreate) threw away the
 * board's tick history.
 *
 * The rule here is now createBoard's: same config AND same place, overridable
 * once the user confirms, and skipped outright when the config didn't actually
 * move (the clients resend layout/size/setIds on every edit).
 *
 * Seeds through the resolver and via raw SQL, against the per-worker test DB —
 * mirrors create-board-duplicate-guard.test.ts.
 */

const OWNER = 'update-dup-owner';
const MODERATOR = 'update-dup-moderator';
const ALL_USERS = [OWNER, MODERATOR, SYSTEM_BOARD_OWNER_ID];

const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m — same building
const LAT_2KM = 47.0 + 0.018; // ~2 km — a different gym

// Two configurations of the same board type, both real MoonBoard hardware so
// `assertKnownBoardConfig` accepts them. STARTING is what the board under test
// begins on; TARGET is what the edit moves it to.
const BOARD_TYPE = 'moonboard';
const STARTING = { boardType: BOARD_TYPE, layoutId: 3, sizeId: 1, setIds: '5,6,7' };
const TARGET = { boardType: BOARD_TYPE, layoutId: 3, sizeId: 1, setIds: '5,6,7,8,9,10' };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type BoardRow = { uuid: string; name: string; layoutId: number; sizeId: number; setIds: string };

const createBoard = (input: Record<string, unknown>, userId = OWNER) =>
  socialBoardMutations.createBoard(
    null,
    { input: { ...STARTING, name: 'A board', ...input } },
    authCtx(userId),
  ) as Promise<BoardRow>;

const updateBoard = (input: Record<string, unknown>, userId = OWNER) =>
  socialBoardMutations.updateBoard(null, { input }, authCtx(userId)) as Promise<BoardRow>;

/** The stored config of a board, so a refused edit can be shown not to have landed. */
async function storedConfig(boardUuid: string): Promise<{ setIds: string; layoutId: number; name: string }> {
  const result = await db.execute(sql`
    SELECT set_ids, layout_id, name FROM user_boards WHERE uuid = ${boardUuid}
  `);
  const row = Array.from(result as Iterable<{ set_ids: string; layout_id: number; name: string }>)[0];
  return { setIds: row.set_ids, layoutId: Number(row.layout_id), name: row.name };
}

/**
 * The thrown GraphQLError's extensions, or null when the call succeeded.
 * Anything that is NOT a duplicate rejection is rethrown — an unrelated failure
 * must fail the test rather than read as "no duplicate".
 */
async function captureDuplicate(promise: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const extensions = (error as { extensions?: Record<string, unknown> }).extensions;
    if (extensions?.code !== 'BOARD_DUPLICATE_CONFIG') throw error;
    return extensions;
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

describe('updateBoard duplicate-config guard', () => {
  it('refuses a config change that lands on a sibling at the same place, naming it', async () => {
    const sibling = await createBoard({
      ...TARGET,
      name: 'Klimmuur MoonBoard 2024',
      locationName: 'Klimmuur',
      ...BASE,
    });
    const edited = await createBoard({
      name: 'Klimmuur MoonBoard (old sets)',
      locationName: 'Klimmuur',
      latitude: LAT_60M,
      longitude: BASE.longitude,
    });

    const extensions = await captureDuplicate(updateBoard({ boardUuid: edited.uuid, setIds: TARGET.setIds }));

    expect(extensions).not.toBeNull();
    // The client offers "save anyway" straight off the error, so the colliding
    // board's identity has to travel with it.
    expect(extensions?.existingBoardUuid).toBe(sibling.uuid);
    expect(extensions?.existingBoardName).toBe('Klimmuur MoonBoard 2024');
    expect(extensions?.existingBoardLocationName).toBe('Klimmuur');
    // Nothing landed.
    expect(await storedConfig(edited.uuid)).toMatchObject({ setIds: STARTING.setIds });
  });

  it('allows the same config change when the sibling is ~2 km away', async () => {
    await createBoard({ ...TARGET, name: 'Boulder Space MoonBoard', locationName: 'Boulder Space', ...BASE });
    const edited = await createBoard({
      name: 'Klimmuur MoonBoard',
      locationName: 'Klimmuur',
      latitude: LAT_2KM,
      longitude: BASE.longitude,
    });

    const updated = await updateBoard({ boardUuid: edited.uuid, setIds: TARGET.setIds });

    expect(updated.setIds).toBe(TARGET.setIds);
  });

  it('saves anyway when the user confirms the two walls are different', async () => {
    await createBoard({ ...TARGET, name: 'Wall A', locationName: 'Klimmuur', ...BASE });
    const edited = await createBoard({ name: 'Wall B', locationName: 'Klimmuur', ...BASE });

    const updated = await updateBoard({
      boardUuid: edited.uuid,
      setIds: TARGET.setIds,
      allowDuplicateConfig: true,
    });

    expect(updated.setIds).toBe(TARGET.setIds);
    expect(await storedConfig(edited.uuid)).toMatchObject({ setIds: TARGET.setIds });
  });

  it('lets an owner of two identical boards rename one — the config resend regression', async () => {
    // The clients send layout/size/setIds on every edit whether or not they
    // moved. Under the old strict guard that meant an owner of two same-config
    // boards could never save ANY edit to either: a rename was refused for
    // colliding with the sibling.
    const shared = { locationName: 'Klimmuur', ...BASE };
    await createBoard({ name: 'MoonBoard 1', ...shared });
    const second = await createBoard({ name: 'MoonBoard 2', ...shared, allowDuplicateConfig: true });

    const updated = await updateBoard({ boardUuid: second.uuid, name: 'MoonBoard 2 (left)', ...STARTING });

    expect(updated.name).toBe('MoonBoard 2 (left)');
    expect(await storedConfig(second.uuid)).toMatchObject({ name: 'MoonBoard 2 (left)', setIds: STARTING.setIds });
  });

  it('recognises the sibling when the same hold sets arrive in a different order', async () => {
    await createBoard({ ...TARGET, setIds: '10,9,8,7,6,5', name: 'Sibling', locationName: 'Klimmuur', ...BASE });
    const edited = await createBoard({ name: 'Edited', locationName: 'Klimmuur', ...BASE });

    const extensions = await captureDuplicate(updateBoard({ boardUuid: edited.uuid, setIds: '5,6,7,8,9,10' }));

    expect(extensions).not.toBeNull();
    expect(await storedConfig(edited.uuid)).toMatchObject({ setIds: STARTING.setIds });
  });

  // The next two cases run on named-but-uncoordinated boards, the shape most
  // real boards have: the coordinate fields sit behind "More options" and can
  // only be filled by "Use my location", i.e. by standing at the wall.
  it('judges the collision on the POST-update location — moving away is allowed', async () => {
    await createBoard({ ...TARGET, name: 'Sibling', locationName: 'Klimmuur' });
    const edited = await createBoard({ name: 'Edited', locationName: 'Klimmuur' });

    // The same config change that would be refused in place: the board is also
    // moving to another gym, which is exactly the reconfiguration this guard
    // must not block. Judged on the stored location it would have been refused.
    const updated = await updateBoard({
      boardUuid: edited.uuid,
      setIds: TARGET.setIds,
      locationName: 'Boulder Space',
    });

    expect(updated.setIds).toBe(TARGET.setIds);
  });

  it('judges the collision on the POST-update location — moving onto the sibling is refused', async () => {
    const sibling = await createBoard({ ...TARGET, name: 'Sibling', locationName: 'Klimmuur' });
    const edited = await createBoard({ name: 'Edited', locationName: 'Boulder Space' });

    // Judged on the stored location this would have been allowed; the edit puts
    // the board at Klimmuur, where the sibling already runs that config.
    const extensions = await captureDuplicate(
      updateBoard({ boardUuid: edited.uuid, setIds: TARGET.setIds, locationName: 'Klimmuur' }),
    );

    expect(extensions?.existingBoardUuid).toBe(sibling.uuid);
    expect(await storedConfig(edited.uuid)).toMatchObject({ setIds: STARTING.setIds });
  });

  it('never blocks a board with itself', async () => {
    const only = await createBoard({ name: 'Only wall', locationName: 'Klimmuur', ...BASE });

    // A real config change with no sibling anywhere: the board's own row is the
    // only candidate, and it must be excluded from the probe.
    const changed = await updateBoard({ boardUuid: only.uuid, setIds: TARGET.setIds });
    expect(changed.setIds).toBe(TARGET.setIds);

    // And the resend-verbatim shape stays a no-op edit.
    const resent = await updateBoard({ boardUuid: only.uuid, ...TARGET, name: 'Only wall (renamed)' });
    expect(resent.name).toBe('Only wall (renamed)');
    expect(resent.setIds).toBe(TARGET.setIds);
  });

  it('exempts the system catalog owner, whose boards legitimately share a config', async () => {
    // Seeded catalog boards all belong to the system user and many gyms run the
    // identical wall, so the guard must never stand between a moderator and a
    // catalog fix.
    const siblingUuid = uuidv4();
    const catalogUuid = uuidv4();
    for (const [uuid, setIds, name] of [
      [siblingUuid, TARGET.setIds, 'Catalog sibling'],
      [catalogUuid, STARTING.setIds, 'Catalog board'],
    ] as const) {
      await db.execute(sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, created_at, updated_at)
        VALUES (${uuid}, ${uuid}, ${SYSTEM_BOARD_OWNER_ID}, ${BOARD_TYPE}, ${TARGET.layoutId}, ${TARGET.sizeId},
                ${setIds}, ${name}, true, now(), now())
      `);
    }
    await db.execute(sql`
      INSERT INTO community_roles (user_id, role, board_type, created_at)
      VALUES (${MODERATOR}, 'admin', NULL, now())
    `);

    const updated = await updateBoard({ boardUuid: catalogUuid, setIds: TARGET.setIds }, MODERATOR);

    expect(updated.setIds).toBe(TARGET.setIds);
  });
});
