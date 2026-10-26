import { randomUUID } from 'node:crypto';
import { buildSchema, isInputObjectType, isObjectType } from 'graphql';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  boardClimbHolds,
  boardClimbNeighbors,
  boardClimbs,
  boardClimbStats,
  boardSessionQueues,
  boardSessions,
  userFavorites,
} from '@boardsesh/db/schema';
import { getMaterializedSimilarClimbs } from '@boardsesh/db/queries';
import { typeDefs, type Climb, type ClimbQueueItem, type ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { getClimbByUuid } from '../db/queries/climbs/get-climb';
import { searchClimbs } from '../db/queries/climbs/search-climbs';
import { findSimilarClimbs, parseFramesToHoldEntries } from '../graphql/resolvers/climbs/climb-similarity';
import { favoriteClimbsQuery } from '../graphql/resolvers/favorites/favorite-climbs-query';
import { hydrateClimbsByRefs } from '../graphql/resolvers/playlists/helpers/hydrate-climbs';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';
import { RedisSessionStore } from '../services/redis-session-store';
import { getQueueState } from '../services/room-manager/queue-state';
import { ClimbQueueItemSchema } from '../validation/schemas/climbs';
import { createMockRedis } from './helpers/mock-redis';

const layoutId = 985428;
const setter = 'RequiredSetsFixture';
const frames = 'p1r12p2r13';
const fixtureClimbs = [
  { uuid: randomUUID(), requiredSetIds: [1, 20] },
  { uuid: randomUUID(), requiredSetIds: null },
  { uuid: randomUUID(), requiredSetIds: [] },
];
const [known, legacy, empty] = fixtureClimbs;
const params = { board_name: 'kilter' as const, layout_id: layoutId, size_id: 10, set_ids: [1, 20], angle: 40 };
const viewer = { connectionId: 'required-hold-sets', isAuthenticated: true, userId: 'user-123' } as ConnectionContext;

function assertRequiredSets(climbs: ReadonlyArray<Pick<Climb, 'uuid' | 'requiredSetIds'>>) {
  for (const expected of fixtureClimbs) {
    expect(climbs.find(({ uuid }) => uuid === expected.uuid)?.requiredSetIds).toEqual(expected.requiredSetIds);
  }
}

beforeAll(async () => {
  await db.insert(boardClimbs).values(
    fixtureClimbs.map(({ uuid, requiredSetIds }) => ({
      uuid,
      boardType: 'kilter',
      layoutId,
      userId: viewer.userId,
      setterUsername: setter,
      name: `Required sets ${uuid}`,
      frames,
      framesCount: 1,
      framesPace: 125,
      angle: 40,
      isListed: true,
      isDraft: false,
      isHidden: false,
      compatibleSizeIds: [10],
      requiredSetIds,
      characteristics: ['no_match'],
    })),
  );
  await db.insert(boardClimbStats).values(
    fixtureClimbs.map(({ uuid }, index) => ({
      boardType: 'kilter',
      climbUuid: uuid,
      angle: 40,
      displayDifficulty: 16,
      difficultyAverage: 16,
      qualityAverage: 3,
      ascensionistCount: 12 - index,
    })),
  );
  await db
    .insert(boardClimbHolds)
    .values(
      fixtureClimbs.flatMap(({ uuid }) =>
        parseFramesToHoldEntries('kilter', frames).map((hold) => ({ boardType: 'kilter', climbUuid: uuid, ...hold })),
      ),
    );
  await db.insert(boardClimbNeighbors).values(
    [known, legacy].map(({ uuid }, index) => ({
      boardType: 'kilter',
      climbUuid: empty.uuid,
      neighborUuid: uuid,
      sharedHoldCount: 2,
      candidateHoldCount: 2,
      targetHoldCount: 2,
      jaccard: 1,
      rank: index + 1,
      listSize: 2,
    })),
  );
  await db
    .insert(userFavorites)
    .values(
      fixtureClimbs.map(({ uuid }) => ({ userId: viewer.userId!, boardName: 'kilter', climbUuid: uuid, angle: 40 })),
    );
});

describe('additive required hold sets contract', () => {
  const schema = buildSchema(typeDefs.join('\n'));
  it.each(['Climb', 'SimilarClimb', 'ClimbInput'])('exposes a nullable integer list on %s', (typeName) => {
    const schemaType = schema.getType(typeName);
    if (!isObjectType(schemaType) && !isInputObjectType(schemaType)) throw new Error(`Missing ${typeName}`);
    expect(schemaType.getFields().requiredSetIds?.type.toString()).toBe('[Int!]');
  });
});

describe('required hold sets from backend reads', () => {
  it.each(['creation', 'ascents'] as const)('projects hold sets through the %s search path', async (sortBy) => {
    // A full ranked page avoids the fallback and exercises its outer projection.
    const result = await searchClimbs(params, { page: 0, pageSize: sortBy === 'ascents' ? 1 : 20, sortBy });
    const climb = result.climbs.find(({ uuid }) => uuid === known.uuid);
    expect(climb).toMatchObject({
      requiredSetIds: [1, 20],
      compatibleSizeIds: [10],
      framesCount: 1,
      framesPace: 125,
      characteristics: ['no_match'],
    });
    // The existing Aurora set filter still withholds unknown requirements.
    expect(result.climbs.some(({ uuid }) => uuid === legacy.uuid)).toBe(false);
  });

  it.each(fixtureClimbs)('hydrates detail requirements $requiredSetIds', async ({ uuid, requiredSetIds }) => {
    const climb = await getClimbByUuid({ ...params, climb_uuid: uuid });
    expect(climb?.requiredSetIds).toEqual(requiredSetIds);
    expect(climb?.compatibleSizeIds).toEqual([10]);
  });

  it('preserves known, unknown and empty requirements in playlist hydration', async () => {
    const climbs = await hydrateClimbsByRefs(
      fixtureClimbs.map(({ uuid }) => ({ boardType: 'kilter', climbUuid: uuid })),
      { viewerUserId: viewer.userId, wallAngle: 40 },
    );
    assertRequiredSets(climbs);
  });

  it('hydrates favorite requirements without changing climb metadata', async () => {
    const { climbs } = await favoriteClimbsQuery.userFavoriteClimbs(
      null,
      { input: { boardName: 'kilter', layoutId, sizeId: 10, setIds: '1,20', angle: 40 } },
      viewer,
    );
    assertRequiredSets(climbs);
    expect(climbs.find(({ uuid }) => uuid === known.uuid)?.characteristics).toEqual(['no_match']);
  });

  it.each(['board', 'all', 'profile'] as const)('hydrates the %s setter read', async (mode) => {
    const result =
      mode === 'profile'
        ? await setterFollowQueries.userClimbs(null, { input: { userId: viewer.userId! } }, viewer)
        : await setterFollowQueries.setterClimbsFull(
            null,
            {
              input: {
                username: setter,
                ...(mode === 'board' ? { boardType: 'kilter', layoutId, sizeId: 10, setIds: '1,20', angle: 40 } : {}),
              },
            },
            viewer,
          );
    assertRequiredSets(result.climbs);
  });

  it.each(['live', 'materialized'] as const)('hydrates %s similar-climb requirements', async (mode) => {
    const climbs =
      mode === 'live'
        ? await findSimilarClimbs({
            boardType: 'kilter',
            layoutId,
            holds: parseFramesToHoldEntries('kilter', frames),
            threshold: 0.5,
            excludeUuid: empty.uuid,
          })
        : await getMaterializedSimilarClimbs(db, {
            boardType: 'kilter',
            layoutId,
            climbUuid: empty.uuid,
            threshold: 0.5,
            limit: 10,
          });
    expect(climbs.find(({ uuid }) => uuid === known.uuid)?.requiredSetIds).toEqual([1, 20]);
    expect(climbs.find(({ uuid }) => uuid === legacy.uuid)?.requiredSetIds).toBeNull();
    expect(climbs.find(({ uuid }) => uuid === known.uuid)?.characteristics).toEqual(['no_match']);
  });
});

describe('required hold sets through queue validation and persistence', () => {
  it.each([
    { requiredSetIds: [1, 20] },
    { requiredSetIds: null },
    { requiredSetIds: undefined },
    { requiredSetIds: [] },
  ])('round-trips $requiredSetIds without inventing legacy metadata', async ({ requiredSetIds }) => {
    const sessionId = randomUUID();
    const parsed = ClimbQueueItemSchema.parse({
      uuid: randomUUID(),
      climb: { uuid: known.uuid, angle: 40, ...(requiredSetIds === undefined ? {} : { requiredSetIds }) },
    });
    const item: ClimbQueueItem = {
      uuid: parsed.uuid,
      climb: {
        ...parsed.climb,
        boardType: parsed.climb.boardType ?? undefined,
        benchmark_difficulty: parsed.climb.benchmark_difficulty ?? null,
      },
    };
    await db.insert(boardSessions).values({ id: sessionId, boardPath: '/kilter/1/10/1,20/40' });
    await db.insert(boardSessionQueues).values({ sessionId, queue: [item], currentClimbQueueItem: item });
    const postgresState = await getQueueState(sessionId, null);
    expect(postgresState.queue[0]?.climb.requiredSetIds).toEqual(requiredSetIds);
    expect(postgresState.currentClimbQueueItem?.climb.requiredSetIds).toEqual(requiredSetIds);

    const redisStore = new RedisSessionStore(createMockRedis());
    await redisStore.updateQueueState(sessionId, [item], item, 1, 1, 'hash', 'ordered-hash', 0);
    const redisState = await redisStore.getSession(sessionId);
    expect(redisState?.queue[0]?.climb.requiredSetIds).toEqual(requiredSetIds);
    expect(redisState?.currentClimbQueueItem?.climb.requiredSetIds).toEqual(requiredSetIds);
  });
});
