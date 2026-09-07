import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { Climb, ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { resolvers } from '../graphql/resolvers/index';
import { favoriteClimbsQuery } from '../graphql/resolvers/favorites/favorite-climbs-query';
import { hydrateClimbsByRefs } from '../graphql/resolvers/playlists/helpers/hydrate-climbs';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

/**
 * #5127 review gap, second layer: `Climb.is_no_match` reads `characteristics`
 * off the parent object, and every field on that parent is optional. A producer
 * that never selects the column therefore compiles, and its climbs silently fall
 * back to Aurora's description convention — so favouriting a climb whose author
 * turned the rule OFF flipped it back ON.
 *
 * Real Postgres on purpose: a column missing from a drizzle select, or from the
 * raw-SQL select list behind `userClimbs`, reads back as `undefined` and takes
 * the fallback. Feeding a mock row straight to the mapper cannot see either.
 */

const RUN_ID = crypto.randomUUID().slice(0, 8);
// Deliberately not the layout the payload test uses — the two files clean up by
// layout id and can run against the same database.
// Per-run layout id, so `cleanup()` can wipe the whole layout — which is what
// makes it leak-proof when a run dies before afterAll — without a concurrent
// run on a shared DB ever deleting fixtures out from under this one. The range
// is 50M wide (1-in-50M collision, off a 32-bit run id) and each of the two
// no-match test files owns a disjoint band, so they cannot collide with each
// other at all. Rows leaked by a crashed run land on a layout nobody queries
// again, so they can never reach an assertion.
const LAYOUT_ID = 950000000 + (parseInt(RUN_ID, 16) % 50_000_000);
const OWNER_ID = `nm5127p-owner-${RUN_ID}`;
const SETTER = `nm5127p-setter-${RUN_ID}`;
const ANGLE = 40;
// The description that made the surfaces disagree: the rule is declared after prose.
const TRAILING_NO_MATCH = 'Kick board is off. No matching.';
const CLIMB_EXPLICIT_FALSE = `nm5127p-climb-off-${RUN_ID}`;
const CLIMB_NULL_ARRAY = `nm5127p-climb-null-${RUN_ID}`;
const CLIMB_EXPLICIT_TRUE = `nm5127p-climb-on-${RUN_ID}`;

/** Exactly what the `Climb.is_no_match` field resolver computes for this parent. */
const isNoMatchField = (climb: Climb): boolean => (resolvers.Climb.is_no_match as (parent: Climb) => boolean)(climb);

function makeCtx(): ConnectionContext {
  return {
    connectionId: `nm5127p-${RUN_ID}`,
    isAuthenticated: true,
    userId: OWNER_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function insertClimb(uuid: string, characteristics: string | null, description: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, angle, setter_username, user_id, name, description, characteristics,
       frames, is_draft, is_listed, is_hidden, created_at)
    VALUES (
      ${uuid}, 'kilter', ${LAYOUT_ID}, ${ANGLE}, ${SETTER}, ${OWNER_ID}, 'No-match producer fixture', ${description},
      ${characteristics}::text[], 'p1080r12', false, true, false, '2026-01-01'
    )
    ON CONFLICT (uuid) DO NOTHING
  `);
}

// Scoped to the fixture layout / owner rather than this run's uuids: a run that
// dies between beforeAll and afterAll would otherwise strand rows that the next
// run's setter-wide queries could pick up.
async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${OWNER_ID}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE board_type = 'kilter' AND layout_id = ${LAYOUT_ID}`);
  await db.execute(sql`DELETE FROM "users" WHERE id = ${OWNER_ID}`);
}

/**
 * Every producer must agree with the climb view on all three rows: the array
 * wins in both directions, and only a NULL array falls back to the prose.
 */
function expectNoMatchAgreesWithCharacteristics(climbs: Climb[], surface: string): void {
  const byUuid = new Map(climbs.map((climb) => [climb.uuid, climb]));

  const turnedOff = byUuid.get(CLIMB_EXPLICIT_FALSE);
  expect(turnedOff, `${surface} returned the explicit-false climb`).toBeDefined();
  expect(turnedOff?.characteristics, `${surface} projects characteristics`).toEqual([]);
  expect(isNoMatchField(turnedOff!), `${surface} is_no_match for the explicit-false climb`).toBe(false);

  const neverEdited = byUuid.get(CLIMB_NULL_ARRAY);
  expect(neverEdited?.characteristics, `${surface} keeps a NULL array null`).toBeNull();
  expect(isNoMatchField(neverEdited!), `${surface} is_no_match for the Aurora-only climb`).toBe(true);

  const turnedOn = byUuid.get(CLIMB_EXPLICIT_TRUE);
  expect(turnedOn?.characteristics, `${surface} projects the no_match token`).toEqual(['no_match']);
  expect(isNoMatchField(turnedOn!), `${surface} is_no_match for the explicit-true climb`).toBe(true);
}

describe('Climb producers project characteristics, so is_no_match matches the climb view (#5127)', () => {
  beforeAll(async () => {
    await cleanup();

    await db.execute(sql`
      INSERT INTO "users" (id, email, name, created_at, updated_at)
      VALUES (${OWNER_ID}, ${`${OWNER_ID}@test.invalid`}, 'No-match producer fixture owner', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);

    // The author turned the rule off; the prose still declares it.
    await insertClimb(CLIMB_EXPLICIT_FALSE, '{}', TRAILING_NO_MATCH);
    // Never edited on Boardsesh — the Aurora description is all there is.
    await insertClimb(CLIMB_NULL_ARRAY, null, TRAILING_NO_MATCH);
    // The rule is on, and the description says nothing about it.
    await insertClimb(CLIMB_EXPLICIT_TRUE, '{no_match}', 'Crimpy start, big move off the gaston');

    for (const uuid of [CLIMB_EXPLICIT_FALSE, CLIMB_NULL_ARRAY, CLIMB_EXPLICIT_TRUE]) {
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
        VALUES (${OWNER_ID}, 'kilter', ${uuid}, ${ANGLE})
        ON CONFLICT DO NOTHING
      `);
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it('userFavoriteClimbs', async () => {
    const result = await favoriteClimbsQuery.userFavoriteClimbs(
      null,
      { input: { boardName: 'kilter', layoutId: LAYOUT_ID, sizeId: 10, setIds: '1,20', angle: ANGLE, pageSize: 100 } },
      makeCtx(),
    );

    expectNoMatchAgreesWithCharacteristics(result.climbs, 'userFavoriteClimbs');
    // Without boardType the resolver fails open, so a MoonBoard climb whose
    // prose mentions matching would read as a no-match climb.
    expect(result.climbs.every((climb) => climb.boardType === 'kilter')).toBe(true);
  });

  it('playlist climbs (hydrateClimbsByRefs)', async () => {
    const climbs = await hydrateClimbsByRefs(
      [CLIMB_EXPLICIT_FALSE, CLIMB_NULL_ARRAY, CLIMB_EXPLICIT_TRUE].map((climbUuid) => ({
        climbUuid,
        boardType: 'kilter',
      })),
    );

    expectNoMatchAgreesWithCharacteristics(climbs, 'hydrateClimbsByRefs');
  });

  it('setterClimbsFull, specific-board mode', async () => {
    const result = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: SETTER, boardType: 'kilter', layoutId: LAYOUT_ID, angle: ANGLE, limit: 100 } },
      makeCtx(),
    );

    expectNoMatchAgreesWithCharacteristics(result.climbs, 'setterClimbsFull (specific board)');
  });

  it('setterClimbsFull, all-boards mode', async () => {
    const result = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: SETTER, limit: 100 } },
      makeCtx(),
    );

    expectNoMatchAgreesWithCharacteristics(result.climbs, 'setterClimbsFull (all boards)');
  });

  it('userClimbs, through the raw-SQL select list', async () => {
    const result = await setterFollowQueries.userClimbs(null, { input: { userId: OWNER_ID, limit: 100 } }, makeCtx());

    expectNoMatchAgreesWithCharacteristics(result.climbs, 'userClimbs');
  });
});
