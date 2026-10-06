import { beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { boardClimbs, boardClimbStats, userFavorites, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { climbFieldResolvers } from '../graphql/resolvers/climbs/field-resolvers';

// `onlyFavorited` (#6077): the climb search narrowed to the climbs the signed-in
// climber has hearted on this board. A heart belongs to the climb, not to the
// angle it was given at, so the filter ignores `user_favorites.angle`.

const viewerId = 'favorited-search-viewer';
const otherId = 'favorited-search-other';
const layoutId = 99781;
const boardInput = { boardName: 'kilter', layoutId, sizeId: 1, setIds: '1' };
const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `favorited-search-${userId}` }) as ConnectionContext;
const anonymous = {
  isAuthenticated: false,
  userId: undefined,
  connectionId: 'favorited-search-anon',
} as ConnectionContext;

async function search(ctx: ConnectionContext, input: { angle: number; onlyFavorited: boolean }): Promise<string[]> {
  const context = await climbQueries.searchClimbs(null, { input: { ...boardInput, ...input } }, ctx);
  const climbs = await climbFieldResolvers.climbs(context as Parameters<typeof climbFieldResolvers.climbs>[0]);
  return climbs.map((climb) => climb.uuid).sort();
}

describe('climb search: onlyFavorited', () => {
  beforeAll(async () => {
    await db.insert(users).values([viewerId, otherId].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    const uuids = ['fav-at-40', 'fav-at-25', 'fav-by-other', 'fav-none'];
    await db.insert(boardClimbs).values(
      uuids.map((uuid) => ({
        uuid,
        boardType: 'kilter',
        layoutId,
        isListed: true,
        isDraft: false,
        name: uuid,
        setterUsername: 'favorited-setter',
        frames: 'p1r1',
        compatibleSizeIds: [1],
        requiredSetIds: [1],
      })),
    );
    await db.insert(boardClimbStats).values(
      uuids.flatMap((climbUuid) =>
        [25, 40].map((angle) => ({
          boardType: 'kilter',
          climbUuid,
          angle,
          displayDifficulty: 16,
          ascensionistCount: 3,
          qualityAverage: 3,
        })),
      ),
    );
    await db.insert(userFavorites).values([
      { userId: viewerId, boardName: 'kilter', climbUuid: 'fav-at-40', angle: 40 },
      { userId: viewerId, boardName: 'kilter', climbUuid: 'fav-at-25', angle: 25 },
      // Another climber's heart must not reach the viewer's list.
      { userId: otherId, boardName: 'kilter', climbUuid: 'fav-by-other', angle: 40 },
      // A heart on another board for a matching uuid must not count either.
      { userId: viewerId, boardName: 'tension', climbUuid: 'fav-none', angle: 40 },
    ]);
  });

  it('keeps only the climbs the viewer hearted on this board', async () => {
    expect(await search(ctxFor(viewerId), { angle: 40, onlyFavorited: true })).toEqual(['fav-at-25', 'fav-at-40']);
  });

  it('matches a heart given at another angle', async () => {
    expect(await search(ctxFor(viewerId), { angle: 25, onlyFavorited: true })).toEqual(['fav-at-25', 'fav-at-40']);
  });

  it("does not leak another climber's hearts", async () => {
    expect(await search(ctxFor(otherId), { angle: 40, onlyFavorited: true })).toEqual(['fav-by-other']);
  });

  it('resolves the user and keeps the result out of the shared cache', async () => {
    const context = await climbQueries.searchClimbs(
      null,
      { input: { ...boardInput, angle: 40, onlyFavorited: true } },
      ctxFor(viewerId),
    );
    expect(context).toMatchObject({ userId: viewerId, _isCacheable: false });
  });

  it('returns nothing when signed out, never the whole catalogue', async () => {
    const context = await climbQueries.searchClimbs(
      null,
      { input: { ...boardInput, angle: 40, onlyFavorited: true } },
      anonymous,
    );
    expect(context).toMatchObject({ _cachedClimbs: [], _cachedTotalCount: 0, _cachedHasMore: false });
    expect(await search(anonymous, { angle: 40, onlyFavorited: true })).toEqual([]);
  });

  it('leaves the list alone when the flag is off', async () => {
    expect(await search(anonymous, { angle: 40, onlyFavorited: false })).toEqual([
      'fav-at-25',
      'fav-at-40',
      'fav-by-other',
      'fav-none',
    ]);
  });
});
