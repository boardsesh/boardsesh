import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { boardClimbs, setterFollows, userFollows, userBoardMappings, users } from '@boardsesh/db/schema';
import { followedAuthorCondition, getSetterStats } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { followedAuthorQueries } from '../graphql/resolvers/social/followed-authors';
import { climbQueries } from '../graphql/resolvers/climbs/queries';

const viewerId = 'followed-authors-viewer';
const creatorId = 'followed-authors-creator';
const unmappedId = 'followed-authors-unmapped';
const ctx = { userId: viewerId, isAuthenticated: true, connectionId: 'followed-authors-test' } as ConnectionContext;
const layoutId = 99771;
const boardInput = { boardName: 'kilter', layoutId, sizeId: 1, setIds: '1', angle: 40 };

describe('followed authors', () => {
  beforeAll(async () => {
    await db
      .insert(users)
      .values([viewerId, creatorId, unmappedId].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db
      .insert(userFollows)
      .values([creatorId, unmappedId].map((followingId) => ({ followerId: viewerId, followingId })));
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'accountless-setter' });
    await db
      .insert(userBoardMappings)
      .values({ userId: creatorId, boardType: 'kilter', boardUsername: 'linked-setter', boardUserId: 993 });
    await db.insert(boardClimbs).values(
      [
        { uuid: 'fa-accountless', setterUsername: 'accountless-setter' },
        { uuid: 'fa-native', setterUsername: 'native-display-name', userId: creatorId },
        { uuid: 'fa-linked', setterUsername: 'linked-setter' },
        { uuid: 'fa-other', setterUsername: 'other-setter' },
        { uuid: 'fa-wrong-board', setterUsername: 'linked-setter', boardType: 'tension' },
      ].map((climb) => ({
        boardType: 'kilter',
        layoutId,
        isListed: true,
        isDraft: false,
        name: climb.uuid,
        frames: 'p1r1',
        compatibleSizeIds: [1],
        requiredSetIds: [1],
        ...climb,
      })),
    );
  });

  it('matches accountless, native, and board-scoped linked authors once', async () => {
    const matches = await db
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.layoutId, layoutId), followedAuthorCondition(viewerId)));
    expect(matches.map((climb) => climb.uuid).sort()).toEqual(['fa-accountless', 'fa-linked', 'fa-native']);
    await db.insert(setterFollows).values({ followerId: viewerId, setterUsername: 'linked-setter' });
    const overlap = await db
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.uuid, 'fa-linked'), followedAuthorCondition(viewerId)));
    expect(overlap).toHaveLength(1);
    await db
      .delete(setterFollows)
      .where(and(eq(setterFollows.followerId, viewerId), eq(setterFollows.setterUsername, 'linked-setter')));
  });

  it('returns a complete owner-scoped snapshot including users with zero links', async () => {
    expect(await followedAuthorQueries.followedAuthors(null, {}, ctx)).toEqual({
      setterUsernames: ['accountless-setter'],
      users: [
        { userId: creatorId, boardAccounts: [{ boardType: 'kilter', username: 'linked-setter' }] },
        { userId: unmappedId, boardAccounts: [] },
      ],
    });
    const stranger = await followedAuthorQueries.followedAuthors(null, {}, { ...ctx, userId: 'user-123' });
    expect(stranger).toEqual({ setterUsernames: [], users: [] });
  });

  it('applies following to setter counts before limiting results', async () => {
    const stats = await getSetterStats(
      db,
      { board_name: 'kilter', layout_id: layoutId, size_id: 1, set_ids: [1], angle: 40 },
      undefined,
      viewerId,
    );
    expect(stats.map((setter) => setter.setter_username).sort()).toEqual([
      'accountless-setter',
      'linked-setter',
      'native-display-name',
    ]);
    expect(stats.every((setter) => setter.climb_count === 1)).toBe(true);
  });

  it('disables shared search caching and requires authentication for the filter', async () => {
    const input = { ...boardInput, onlyFollowedAuthors: true };
    const search = await climbQueries.searchClimbs(null, { input }, ctx);
    expect(search).toMatchObject({ userId: viewerId, _isCacheable: false });
    const anonymous = { ...ctx, isAuthenticated: false, userId: undefined };
    await expect(climbQueries.searchClimbs(null, { input }, anonymous)).rejects.toThrow();
    await expect(climbQueries.setterStats(null, { input }, anonymous)).rejects.toThrow();
    await expect(followedAuthorQueries.followedAuthors(null, {}, anonymous)).rejects.toThrow();
    const nobody = await db
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .where(and(inArray(boardClimbs.uuid, ['fa-accountless', 'fa-linked']), followedAuthorCondition(undefined)));
    expect(nobody).toEqual([]);
  });

  it('leaves unfiltered setter results accessible without following or authentication', async () => {
    const anonymous = { ...ctx, isAuthenticated: false, userId: undefined };
    const input = { ...boardInput, onlyFollowedAuthors: false };
    await expect(climbQueries.searchClimbs(null, { input }, anonymous)).resolves.toBeDefined();
    const setters = await climbQueries.setterStats(null, { input }, anonymous);
    expect(setters.map((setter) => setter.setterUsername).sort()).toEqual([
      'accountless-setter',
      'linked-setter',
      'native-display-name',
      'other-setter',
    ]);
  });
});
