import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { setterFollowMutations, setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

const TEST_USER_ID = 'setter-follows-integration-user';
const CLIMB_PREFIX = 'setter-follows-integration-climb-';

async function insertUser(id: string) {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertClimb(params: {
  uuid: string;
  boardType: string;
  setterUsername: string | null;
  userId?: string | null;
  ascensionistCount: number;
  /** Community-moderation flag; defaults to visible. */
  isHidden?: boolean;
}) {
  await db.execute(sql`
    INSERT INTO "board_climbs" (
      uuid,
      board_type,
      layout_id,
      setter_username,
      name,
      frames,
      frames_count,
      is_draft,
      is_listed,
      is_hidden,
      edge_left,
      edge_right,
      edge_bottom,
      edge_top,
      created_at,
      user_id,
      characteristics
    )
    VALUES (
      ${params.uuid},
      ${params.boardType},
      1,
      ${params.setterUsername},
      ${params.uuid},
      'p1r1',
      1,
      false,
      true,
      ${params.isHidden ?? false},
      0,
      100,
      0,
      150,
      '2026-01-01',
      ${params.userId ?? null},
      ${sql.raw("ARRAY['no_match']::text[]")}
    )
  `);

  await db.execute(sql`
    INSERT INTO "board_climb_stats" (
      board_type,
      climb_uuid,
      angle,
      display_difficulty,
      benchmark_difficulty,
      ascensionist_count,
      difficulty_average,
      quality_average
    )
    VALUES (
      ${params.boardType},
      ${params.uuid},
      40,
      20,
      NULL,
      ${params.ascensionistCount},
      20,
      3.5
    )
  `);
}

async function cleanup() {
  await db.execute(sql`DELETE FROM "user_board_mappings" WHERE "user_id" = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM "board_climb_stats" WHERE "climb_uuid" LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" LIKE ${CLIMB_PREFIX + '%'}`);
}

describe('setterFollowQueries.userClimbs', () => {
  beforeAll(async () => {
    await insertUser(TEST_USER_ID);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('matches linked setter usernames on board_type as well as username', async () => {
    await db.execute(sql`
      INSERT INTO "user_board_mappings" (
        "user_id",
        "board_type",
        "board_user_id",
        "board_username"
      )
      VALUES (${TEST_USER_ID}, 'kilter', 101, 'shared-setter')
    `);

    await insertClimb({
      uuid: `${CLIMB_PREFIX}direct`,
      boardType: 'tension',
      setterUsername: 'local-user',
      userId: TEST_USER_ID,
      ascensionistCount: 12,
    });
    await insertClimb({
      uuid: `${CLIMB_PREFIX}linked-kilter`,
      boardType: 'kilter',
      setterUsername: 'shared-setter',
      ascensionistCount: 30,
    });
    await insertClimb({
      uuid: `${CLIMB_PREFIX}wrong-board`,
      boardType: 'tension',
      setterUsername: 'shared-setter',
      ascensionistCount: 50,
    });

    const result = await setterFollowQueries.userClimbs(
      null,
      { input: { userId: TEST_USER_ID, sortBy: 'popular', limit: 10, offset: 0 } },
      {} as never,
    );

    expect(result.totalCount).toBe(2);
    expect(result.climbs.map((climb) => climb.uuid)).toEqual([`${CLIMB_PREFIX}linked-kilter`, `${CLIMB_PREFIX}direct`]);
  });

  // The mocked guard in resolver-climb-fields.test.ts can only read the SQL text
  // back; this proves the column actually survives the owned_climbs CTE and the
  // outer SELECT against a real Postgres, as a text[] and not a string (#5214).
  it('returns the stored characteristics array', async () => {
    await insertClimb({
      uuid: `${CLIMB_PREFIX}rules`,
      boardType: 'tension',
      setterUsername: 'local-user',
      userId: TEST_USER_ID,
      ascensionistCount: 3,
    });

    const result = await setterFollowQueries.userClimbs(
      null,
      { input: { userId: TEST_USER_ID, sortBy: 'popular', limit: 10, offset: 0 } },
      {} as never,
    );

    expect(result.climbs[0]?.characteristics).toEqual(['no_match']);
  });
});

describe('setterFollowQueries.setterProfile', () => {
  const HIDDEN_SETTER = 'setter-follows-integration-hidden-setter';

  afterEach(async () => {
    await cleanup();
  });

  it('keeps the profile alive when every climb is hidden, and counts zero', async () => {
    // Moderation hides climbs, not people. If the existence check filtered on
    // is_hidden, this setter's public page would 404 the moment their last climb
    // was hidden — the failure this test exists to catch.
    await insertClimb({
      uuid: `${CLIMB_PREFIX}all-hidden`,
      boardType: 'kilter',
      setterUsername: HIDDEN_SETTER,
      ascensionistCount: 5,
      isHidden: true,
    });

    const profile = await setterFollowQueries.setterProfile(null, { input: { username: HIDDEN_SETTER } }, {} as never);

    expect(profile).not.toBeNull();
    expect(profile?.username).toBe(HIDDEN_SETTER);
    expect(profile?.boardTypes).toEqual(['kilter']);
    expect(profile?.climbCount).toBe(0);
  });

  it('counts only the climbs a visitor can browse to', async () => {
    await insertClimb({
      uuid: `${CLIMB_PREFIX}visible-1`,
      boardType: 'kilter',
      setterUsername: HIDDEN_SETTER,
      ascensionistCount: 5,
    });
    await insertClimb({
      uuid: `${CLIMB_PREFIX}visible-2`,
      boardType: 'kilter',
      setterUsername: HIDDEN_SETTER,
      ascensionistCount: 5,
    });
    await insertClimb({
      uuid: `${CLIMB_PREFIX}hidden-1`,
      boardType: 'kilter',
      setterUsername: HIDDEN_SETTER,
      ascensionistCount: 5,
      isHidden: true,
    });

    const profile = await setterFollowQueries.setterProfile(null, { input: { username: HIDDEN_SETTER } }, {} as never);

    expect(profile?.climbCount).toBe(2);
  });
});

// #6561: following or unfollowing a setter name also follows or unfollows the
// account behind it. That account is found the way `setterProfile` names it:
// first the account that set the name's listable climbs, then a login linked
// under the name on a board the name has climbs on, and a private account's
// linked login only for viewers who may already see its activity.
describe('setterFollowMutations: the account behind a setter name (real DB)', () => {
  // "x" in the issue: one login name that different accounts link on different boards.
  const SETTER_NAME = 'setter-follows-integration-x';
  const STRANGER = 'setter-follows-integration-stranger';
  /** A private account that linked the name. */
  const PRIVATE_LINK = 'setter-follows-integration-private-link';
  /** A public account that linked the name. */
  const PUBLIC_LINK = 'setter-follows-integration-public-link';
  /** The public account that set the Kilter climbs under the name. */
  const KILTER_AUTHOR = 'setter-follows-integration-kilter-author';
  const USERS = [STRANGER, PRIVATE_LINK, PUBLIC_LINK, KILTER_AUTHOR];

  const asStranger = { isAuthenticated: true, userId: STRANGER, connectionId: STRANGER } as ConnectionContext;
  const followName = () =>
    setterFollowMutations.followSetter(null, { input: { setterUsername: SETTER_NAME } }, asStranger);
  const unfollowName = () =>
    setterFollowMutations.unfollowSetter(null, { input: { setterUsername: SETTER_NAME } }, asStranger);

  async function linkLogin(userId: string, boardType: string) {
    await db.insert(dbSchema.userBoardMappings).values({ userId, boardType, boardUsername: SETTER_NAME });
  }

  /** A published Kilter climb under the name; `userId` null is a synced climb with no account on it. */
  async function kilterClimbUnderName(suffix: string, userId: string | null) {
    await insertClimb({
      uuid: `${CLIMB_PREFIX}x-${suffix}`,
      boardType: 'kilter',
      setterUsername: SETTER_NAME,
      userId,
      ascensionistCount: 1,
    });
  }

  async function strangerRequestsTo(recipientId: string) {
    return db
      .select()
      .from(dbSchema.userFollowRequests)
      .where(
        and(
          eq(dbSchema.userFollowRequests.requesterId, STRANGER),
          eq(dbSchema.userFollowRequests.recipientId, recipientId),
        ),
      );
  }

  async function strangerFollowsOf(followingId: string) {
    return db
      .select()
      .from(dbSchema.userFollows)
      .where(and(eq(dbSchema.userFollows.followerId, STRANGER), eq(dbSchema.userFollows.followingId, followingId)));
  }

  async function strangerSetterFollows() {
    return db
      .select()
      .from(dbSchema.setterFollows)
      .where(
        and(eq(dbSchema.setterFollows.followerId, STRANGER), eq(dbSchema.setterFollows.setterUsername, SETTER_NAME)),
      );
  }

  beforeEach(async () => {
    for (const id of USERS) await insertUser(id);
    await db.insert(dbSchema.userProfiles).values([
      { userId: PRIVATE_LINK, isPrivate: true },
      { userId: PUBLIC_LINK, isPrivate: false },
      { userId: KILTER_AUTHOR, isPrivate: false },
    ]);
  });

  afterEach(async () => {
    await cleanup();
    // Cascades to the mappings, profiles, follows, follow requests and setter follows.
    await db.delete(dbSchema.users).where(inArray(dbSchema.users.id, USERS));
  });

  it('sends no follow request to a private account that linked the name on another board', async () => {
    await linkLogin(PRIVATE_LINK, 'tension');
    await kilterClimbUnderName('by-author', KILTER_AUTHOR);

    await expect(followName()).resolves.toBe(true);

    expect(await strangerSetterFollows()).toHaveLength(1);
    expect(await strangerRequestsTo(PRIVATE_LINK)).toEqual([]);
    // The account that set the Kilter climbs is the one followed.
    expect(await strangerFollowsOf(KILTER_AUTHOR)).toHaveLength(1);
  });

  it('follows the name alone when its climbs carry no account and the login is on another board', async () => {
    await linkLogin(PRIVATE_LINK, 'tension');
    await kilterClimbUnderName('synced', null);

    await expect(followName()).resolves.toBe(true);

    expect(await strangerSetterFollows()).toHaveLength(1);
    expect(await strangerRequestsTo(PRIVATE_LINK)).toEqual([]);
  });

  it('sends no follow request to a private account by its linked login alone, on the same board', async () => {
    // No climb names the private account, so the name does not lead to it.
    await linkLogin(PRIVATE_LINK, 'kilter');
    await kilterClimbUnderName('synced', null);

    await expect(followName()).resolves.toBe(true);

    expect(await strangerSetterFollows()).toHaveLength(1);
    expect(await strangerRequestsTo(PRIVATE_LINK)).toEqual([]);
  });

  it('asks a private account that set the climbs, without following it', async () => {
    await kilterClimbUnderName('by-private', PRIVATE_LINK);

    await expect(followName()).resolves.toBe(true);

    expect(await strangerRequestsTo(PRIVATE_LINK)).toHaveLength(1);
    expect(await strangerFollowsOf(PRIVATE_LINK)).toEqual([]);
  });

  it('keeps a follow of a public account that linked the name on another board when unfollowing the name', async () => {
    await linkLogin(PUBLIC_LINK, 'tension');
    await kilterClimbUnderName('synced', null);
    // The stranger followed this account on its own, and the name separately.
    await db.insert(dbSchema.userFollows).values({ followerId: STRANGER, followingId: PUBLIC_LINK });
    await db.insert(dbSchema.setterFollows).values({ followerId: STRANGER, setterUsername: SETTER_NAME });

    await expect(unfollowName()).resolves.toBe(true);

    expect(await strangerSetterFollows()).toEqual([]);
    expect(await strangerFollowsOf(PUBLIC_LINK)).toHaveLength(1);
  });

  it('follows and unfollows a public account linked on the board the climbs are on', async () => {
    await linkLogin(PUBLIC_LINK, 'kilter');
    await kilterClimbUnderName('synced', null);

    await expect(followName()).resolves.toBe(true);
    expect(await strangerFollowsOf(PUBLIC_LINK)).toHaveLength(1);

    await expect(unfollowName()).resolves.toBe(true);
    expect(await strangerSetterFollows()).toEqual([]);
    expect(await strangerFollowsOf(PUBLIC_LINK)).toEqual([]);
  });
});
