import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

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
      user_id
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
      ${params.userId ?? null}
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
