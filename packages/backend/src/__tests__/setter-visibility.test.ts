import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setterFollowMutations, setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

/**
 * `setterProfile`, `setterClimbs` and `setterClimbsFull` filtered on
 * `setter_username` alone, with no `is_listed` / `is_draft` predicate — so
 * anyone who asked got the setter's drafts and unlisted climbs, and
 * `setterProfile.climbCount` counted them.
 *
 * None of the three is authenticated against the setter, so there is no "it's
 * my own draft" case this could be protecting: the caller is always a stranger
 * looking at somebody else's unpublished work.
 */

const SETTER = 'setter-visibility-test-setter';
const CLIMB_PREFIX = 'setter-visibility-climb-';

async function insertClimb(suffix: string, flags: { isListed: boolean; isDraft: boolean }) {
  await db.execute(sql`
    INSERT INTO "board_climbs" (
      uuid, board_type, layout_id, setter_username, name, frames, frames_count,
      is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at
    )
    VALUES (
      ${CLIMB_PREFIX + suffix}, 'kilter', 1, ${SETTER}, ${'Climb ' + suffix}, 'p1r1', 1,
      ${flags.isDraft}, ${flags.isListed}, 0, 100, 0, 150, '2026-01-01'
    )
  `);
  await db.execute(sql`
    INSERT INTO "board_climb_stats" (
      board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
      ascensionist_count, difficulty_average, quality_average
    )
    VALUES ('kilter', ${CLIMB_PREFIX + suffix}, 40, 20, NULL, 10, 20, 3.5)
  `);
}

/** `user-123` is the account `setup.ts` seeds; `followSetter` needs a real one. */
const FOLLOWER_ID = 'user-123';

// Every field but `connectionId` is optional, so this needs no cast — and not
// casting is the point: an object literal the compiler checks cannot drift out
// of shape with `ConnectionContext` the way a `as ConnectionContext` one does.
function authedCtx(): ConnectionContext {
  return {
    connectionId: 'conn-setter-visibility',
    transport: 'ws',
    isAuthenticated: true,
    userId: FOLLOWER_ID,
  };
}

afterEach(async () => {
  await db.execute(sql`DELETE FROM "setter_follows" WHERE "setter_username" = ${SETTER}`);
  await db.execute(sql`DELETE FROM "board_climb_stats" WHERE "climb_uuid" LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" LIKE ${CLIMB_PREFIX + '%'}`);
});

async function followRowCount(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT count(*)::int AS count FROM "setter_follows" WHERE "setter_username" = ${SETTER}`,
  );
  return Array.from(rows as Iterable<{ count: number }>)[0]?.count ?? 0;
}

describe('setter queries hand out only publicly visible climbs', () => {
  it('counts and lists the listed non-draft climb, and neither the draft nor the unlisted one', async () => {
    await insertClimb('visible', { isListed: true, isDraft: false });
    await insertClimb('draft', { isListed: true, isDraft: true });
    await insertClimb('unlisted', { isListed: false, isDraft: false });

    const profile = await setterFollowQueries.setterProfile(null, { input: { username: SETTER } }, {} as never);
    expect(profile?.climbCount).toBe(1);

    const climbs = await setterFollowQueries.setterClimbs(
      null,
      { input: { username: SETTER, limit: 10, offset: 0 } },
      {} as never,
    );
    expect(climbs.totalCount).toBe(1);
    expect(climbs.climbs.map((climb) => climb.uuid)).toEqual([`${CLIMB_PREFIX}visible`]);

    const allBoards = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: SETTER, limit: 10, offset: 0 } },
      {} as never,
    );
    expect(allBoards.totalCount).toBe(1);
    expect(allBoards.climbs.map((climb) => climb.uuid)).toEqual([`${CLIMB_PREFIX}visible`]);

    const oneBoard = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: SETTER, boardType: 'kilter', angle: 40, limit: 10, offset: 0 } },
      {} as never,
    );
    expect(oneBoard.totalCount).toBe(1);
    expect(oneBoard.climbs.map((climb) => climb.uuid)).toEqual([`${CLIMB_PREFIX}visible`]);
  });

  it('keeps a drafts-only setter out of search, rather than offering a result that 404s', async () => {
    // The whole point of the 404 is undone if search still offers the setter,
    // with a climb count that includes the hidden climbs, and the tap lands on
    // a not-found page.
    await insertClimb('search-draft', { isListed: true, isDraft: true });

    const drafts = await setterFollowQueries.searchUsersAndSetters(
      null,
      { input: { query: SETTER, limit: 10, offset: 0 } },
      {} as never,
    );
    expect(drafts.results.map((result) => result.setter?.username)).not.toContain(SETTER);

    await insertClimb('search-visible', { isListed: true, isDraft: false });

    const visible = await setterFollowQueries.searchUsersAndSetters(
      null,
      { input: { query: SETTER, limit: 10, offset: 0 } },
      {} as never,
    );
    const hit = visible.results.find((result) => result.setter?.username === SETTER)?.setter;
    expect(hit).toBeDefined();
    // ...and the count it advertises is the visible one, not the total.
    expect(hit?.climbCount).toBe(1);
  });

  it('is null for a setter whose whole catalogue is drafts or unlisted', async () => {
    // The signal `/setter/[setter_username]` turns into a real 404. Without the
    // predicate this returned a profile with climbCount 2.
    await insertClimb('draft-only', { isListed: true, isDraft: true });
    await insertClimb('unlisted-only', { isListed: false, isDraft: false });

    const profile = await setterFollowQueries.setterProfile(null, { input: { username: SETTER } }, {} as never);
    expect(profile).toBeNull();
  });
});

/**
 * The mutation shares `visibleSetterClimbConditions` with the four query paths
 * above, but nothing exercised it — so a regression there would have surfaced
 * in production rather than in CI. The rule it enforces: you cannot follow a
 * setter whose page 404s.
 */
describe('followSetter refuses a setter whose page does not resolve', () => {
  it('throws for a setter whose whole catalogue is drafts or unlisted, and writes no row', async () => {
    await insertClimb('follow-draft', { isListed: true, isDraft: true });
    await insertClimb('follow-unlisted', { isListed: false, isDraft: false });

    await expect(
      setterFollowMutations.followSetter(null, { input: { setterUsername: SETTER } }, authedCtx()),
    ).rejects.toThrow('Setter not found');

    // Paired oracle: a handler that threw AFTER inserting would pass on the
    // rejection alone.
    expect(await followRowCount()).toBe(0);
  });

  it('follows a setter who has one publicly visible climb', async () => {
    await insertClimb('follow-visible', { isListed: true, isDraft: false });
    await insertClimb('follow-hidden', { isListed: true, isDraft: true });

    await expect(
      setterFollowMutations.followSetter(null, { input: { setterUsername: SETTER } }, authedCtx()),
    ).resolves.toBe(true);

    expect(await followRowCount()).toBe(1);
  });
});
