import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import { buildSchema, graphql } from 'graphql';
import { typeDefs, type ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { favoriteMutations } from '../graphql/resolvers/favorites/mutations';
import { favoriteQueries } from '../graphql/resolvers/favorites/queries';

type IndexShape = 'legacy' | 'dual' | 'uuid';
const USER_ID = 'favorites-rollout-user';
const OTHER_USER_ID = 'favorites-rollout-other';
const CLIMB_UUID = 'favorites-rollout-climb';
const graphSchema = buildSchema(typeDefs.join('\n'));

function context(userId = USER_ID): ConnectionContext {
  return {
    connectionId: 'favorites-rollout-connection',
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function resetIndex(shape: IndexShape): Promise<void> {
  await db.execute(sql`TRUNCATE user_favorites, sync_deletions RESTART IDENTITY CASCADE`);
  await db.execute(sql`DROP INDEX IF EXISTS unique_user_favorite`);
  await db.execute(sql`DROP INDEX IF EXISTS unique_user_favorite_legacy`);
  if (shape === 'legacy') {
    await db.execute(
      sql`CREATE UNIQUE INDEX unique_user_favorite ON user_favorites(user_id, board_name, climb_uuid, angle)`,
    );
  } else {
    await db.execute(sql`CREATE UNIQUE INDEX unique_user_favorite ON user_favorites(user_id, climb_uuid)`);
    if (shape === 'dual') {
      await db.execute(
        sql`CREATE UNIQUE INDEX unique_user_favorite_legacy ON user_favorites(user_id, board_name, climb_uuid, angle)`,
      );
    }
  }
}

async function favorites(userId = USER_ID) {
  return db.select().from(dbSchema.userFavorites).where(eq(dbSchema.userFavorites.userId, userId));
}

// The worker database can be reused by another test file. Leave its indexes
// matching the migrated schema after exercising older deployment shapes.
afterAll(() => resetIndex('dual'));

beforeEach(async () => {
  for (const userId of [USER_ID, OTHER_USER_ID]) {
    await db
      .insert(dbSchema.users)
      .values({ id: userId, email: `${userId}@test.com` })
      .onConflictDoNothing();
  }
  await db.execute(sql`
    INSERT INTO board_climbs(uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
    VALUES (${CLIMB_UUID}, 'kilter', 1, 'setter', 'Rollout climb', '', 'p1r1', true)
    ON CONFLICT (uuid) DO NOTHING
  `);
});

describe.each<IndexShape>(['legacy', 'dual', 'uuid'])('favorites with the %s index shape', (shape) => {
  beforeEach(() => resetIndex(shape));

  it('accepts UUID-only adds and preserves the non-null legacy sync columns', async () => {
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context());
    const rows = await favorites();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ climbUuid: CLIMB_UUID, boardName: 'kilter', angle: 0 });
  });

  it('accepts queued legacy inputs at another angle without duplicating or violating either key', async () => {
    await favoriteMutations.addFavorite(
      undefined,
      { input: { climbUuid: CLIMB_UUID, boardName: 'kilter', angle: 40 } },
      context(),
    );
    await favoriteMutations.addFavorite(
      undefined,
      { input: { climbUuid: CLIMB_UUID, boardName: 'tension', angle: 25 } },
      context(),
    );
    expect(await favorites()).toHaveLength(1);
    expect(
      await favoriteQueries.favorites(
        undefined,
        { climbUuids: [CLIMB_UUID], boardName: 'tension', angle: 25 },
        context(),
      ),
    ).toEqual([CLIMB_UUID]);
  });

  it('toggles an existing favorite off from another board and angle', async () => {
    await favoriteMutations.addFavorite(
      undefined,
      { input: { climbUuid: CLIMB_UUID, boardName: 'kilter', angle: 40 } },
      context(),
    );
    expect(
      await favoriteMutations.toggleFavorite(
        undefined,
        { input: { climbUuid: CLIMB_UUID, boardName: 'tension', angle: 25 } },
        context(),
      ),
    ).toEqual({ favorited: false });
    expect(await favorites()).toHaveLength(0);
  });

  it('serializes concurrent adds across legacy and UUID-only payloads', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        favoriteMutations.addFavorite(
          undefined,
          {
            input:
              index % 2 ? { climbUuid: CLIMB_UUID } : { climbUuid: CLIMB_UUID, boardName: 'kilter', angle: index * 5 },
          },
          context(),
        ),
      ),
    );
    expect(await favorites()).toHaveLength(1);
  });

  it('serializes concurrent toggles so an even number leaves no favorite', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        favoriteMutations.toggleFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context()),
      ),
    );
    expect(results.filter((result) => result.favorited)).toHaveLength(3);
    expect(await favorites()).toHaveLength(0);
  });

  it('keeps removals idempotent and scoped to the signed-in user', async () => {
    for (const userId of [USER_ID, OTHER_USER_ID]) {
      await favoriteMutations.addFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context(userId));
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await favoriteMutations.removeFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context())).toBe(
        true,
      );
    }
    expect(await favorites()).toHaveLength(0);
    expect(await favorites(OTHER_USER_ID)).toHaveLength(1);
  });

  it.each(['legacy', 'uuid'])('executes %s GraphQL documents and inputs', async (format) => {
    const input =
      format === 'legacy' ? { boardName: 'kilter', climbUuid: CLIMB_UUID, angle: 40 } : { climbUuid: CLIMB_UUID };
    const mutation = await graphql({
      schema: graphSchema,
      source: 'mutation Toggle($input: ToggleFavoriteInput!) { toggleFavorite(input: $input) { favorited } }',
      variableValues: { input },
      rootValue: {
        toggleFavorite: (args: { input: typeof input }) => favoriteMutations.toggleFavorite(undefined, args, context()),
      },
    });
    expect(mutation.errors).toBeUndefined();
    expect(mutation.data?.toggleFavorite).toEqual({ favorited: true });
    const query = await graphql({
      schema: graphSchema,
      source:
        format === 'legacy'
          ? 'query Favorites($boardName: String!, $climbUuids: [String!]!, $angle: Int!) { favorites(boardName: $boardName, climbUuids: $climbUuids, angle: $angle) }'
          : 'query Favorites($climbUuids: [String!]!) { favorites(climbUuids: $climbUuids) }',
      variableValues: { boardName: 'tension', climbUuids: [CLIMB_UUID], angle: 25 },
      rootValue: {
        favorites: (args: { climbUuids: string[]; boardName?: string; angle?: number }) =>
          favoriteQueries.favorites(undefined, args, context()),
      },
    });
    expect(query.errors).toBeUndefined();
    expect(query.data?.favorites).toEqual([CLIMB_UUID]);
  });
});

describe('pre-migration duplicate favorites', () => {
  beforeEach(async () => {
    await resetIndex('legacy');
    await db.insert(dbSchema.userFavorites).values(
      [40, 50].map((angle) => ({
        userId: USER_ID,
        climbUuid: CLIMB_UUID,
        boardName: 'kilter',
        angle,
      })),
    );
  });

  it('returns one UUID while leaving duplicates for the archive migration', async () => {
    expect(await favoriteQueries.favorites(undefined, { climbUuids: [CLIMB_UUID] }, context())).toEqual([CLIMB_UUID]);
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context());
    expect(await favorites()).toHaveLength(2);
  });

  it('removes all variants when the climber removes the heart', async () => {
    expect(await favoriteMutations.toggleFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context())).toEqual({
      favorited: false,
    });
    expect(await favorites()).toHaveLength(0);
  });

  it('keeps legacy deletion IDs readable by old composite-key clients', async () => {
    await favoriteMutations.removeFavorite(undefined, { input: { climbUuid: CLIMB_UUID } }, context());
    const deletions = await db
      .select({ recordId: dbSchema.syncDeletions.recordId })
      .from(dbSchema.syncDeletions)
      .where(and(eq(dbSchema.syncDeletions.userId, USER_ID), eq(dbSchema.syncDeletions.tableName, 'user_favorites')));
    expect(deletions.map((deletion) => deletion.recordId).sort()).toEqual([
      `kilter:${CLIMB_UUID}:40`,
      `kilter:${CLIMB_UUID}:50`,
    ]);
  });
});
