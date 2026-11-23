import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { createRequire } from 'node:module';
import type * as GraphQLModule from 'graphql';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  SEARCH_SPRAY_WALLS_DIRECTORY,
  type SearchSprayWallsDirectoryQueryResponse,
} from '@boardsesh/graphql/operations';
import { db } from '../db/client';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { schema } from '../graphql/index';

const { execute, parse } = createRequire(import.meta.url)('graphql') as typeof GraphQLModule;

const PREFIX = 'spray-directory';
const OWNER = `${PREFIX}-owner`;
const PRIVATE_ADDRESS = 'Hidden driveway address';
const PUBLIC_COORDINATES = { latitude: 52.37, longitude: 4.89 };

type WallFixture = {
  name: string;
  angle?: number;
  private?: boolean;
  unlisted?: boolean;
  unpublished?: boolean;
  hidden?: boolean;
  archived?: boolean;
  deletedWall?: boolean;
  deletedBoard?: boolean;
  hideLocation?: boolean;
};

const fixtures: WallFixture[] = [
  { name: 'public-a' },
  { name: 'public-b' },
  { name: 'other-angle', angle: 30 },
  { name: 'private', private: true },
  { name: 'unlisted', unlisted: true },
  { name: 'unpublished', unpublished: true },
  { name: 'hidden', hidden: true },
  { name: 'archived', archived: true },
  { name: 'deleted-wall', deletedWall: true },
  { name: 'deleted-board', deletedBoard: true },
  { name: 'hidden-location', hideLocation: true },
];

const wallUuid = (name: string) => `${PREFIX}-${name}`;

beforeAll(async () => {
  await db.insert(dbSchema.users).values({ id: OWNER, email: `${OWNER}@test.com`, name: 'Directory owner' });
  for (const [index, fixture] of fixtures.entries()) {
    const uuid = wallUuid(fixture.name);
    const layoutId = 800_000 + index;
    await db.insert(dbSchema.userBoards).values({
      uuid,
      slug: uuid,
      ownerId: OWNER,
      boardType: 'spray',
      layoutId,
      sizeId: layoutId,
      setIds: '1',
      name: uuid,
      angle: fixture.angle ?? 40,
      // Adjustable must not turn exact angle filtering into "matches anything".
      isAngleAdjustable: true,
      isPublic: !fixture.private,
      isUnlisted: fixture.unlisted ?? false,
      hideLocation: fixture.hideLocation ?? false,
      locationName: fixture.hideLocation ? PRIVATE_ADDRESS : 'Amsterdam',
      ...PUBLIC_COORDINATES,
      deletedAt: fixture.deletedBoard ? new Date() : null,
    });
    const [wall] = await db
      .insert(dbSchema.sprayWalls)
      .values({
        boardUuid: uuid,
        layoutId,
        hiddenAt: fixture.hidden ? new Date() : null,
        archivedAt: fixture.archived ? new Date() : null,
        deletedAt: fixture.deletedWall ? new Date() : null,
      })
      .returning({ id: dbSchema.sprayWalls.id });
    if (!fixture.unpublished) {
      const [version] = await db
        .insert(dbSchema.sprayWallVersions)
        .values({ wallId: wall.id, versionNumber: 1, status: 'published' })
        .returning({ id: dbSchema.sprayWallVersions.id });
      await db
        .update(dbSchema.sprayWalls)
        .set({ currentVersionId: version.id })
        .where(eq(dbSchema.sprayWalls.id, wall.id));
    }
  }
});

async function search(input: Record<string, unknown> = {}, userId?: string) {
  const ctx = { connectionId: `${PREFIX}-reader`, isAuthenticated: Boolean(userId), userId } as ConnectionContext;
  return (await socialBoardQueries.publicSprayWalls(
    null,
    { input: { boardType: 'spray', query: PREFIX, limit: 24, ...input } },
    ctx,
  )) as SearchSprayWallsDirectoryQueryResponse['searchBoards'];
}

describe('anonymous spray-wall directory', () => {
  it('lists only published, public, listed, active walls and counts the same rows', async () => {
    const result = await search();
    expect(result.boards.map(({ uuid }) => uuid).sort()).toEqual(
      ['public-a', 'public-b', 'other-angle', 'hidden-location'].map(wallUuid).sort(),
    );
    expect(result.totalCount).toBe(4);
    expect(result.hasMore).toBe(false);
  });

  it('filters exact angles before counting and paging, including adjustable walls', async () => {
    const first = await search({ angles: [40], limit: 1 });
    const second = await search({ angles: [40], limit: 1, offset: 1 });
    const third = await search({ angles: [40], limit: 1, offset: 2 });
    expect([first.totalCount, second.totalCount, third.totalCount]).toEqual([3, 3, 3]);
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    const rows = [...first.boards, ...second.boards, ...third.boards];
    expect(rows.map(({ uuid }) => uuid).sort()).toEqual(
      ['public-a', 'public-b', 'hidden-location'].map(wallUuid).sort(),
    );
    expect(rows.every(({ angle }) => angle === 40)).toBe(true);
  });

  it('keeps empty angles unfiltered and supports multiple exact angles', async () => {
    expect(await search({ angles: [] })).toEqual(await search());
    expect((await search({ angles: [30, 40] })).totalCount).toBe(4);
    expect(await search({ angles: [45] })).toMatchObject({ boards: [], totalCount: 0, hasMore: false });
  });

  it('ignores catalogue selectors and always returns the spray-wall directory', async () => {
    expect(await search({ boardType: 'kilter', boardTypes: ['tension'], layoutIds: [1], sizeIds: [1] })).toEqual(
      await search(),
    );
  });

  it('keeps the finite page-size cap', async () => {
    await expect(search({ limit: 51 })).rejects.toMatchObject({ name: 'InputValidationError' });
  });

  it('keeps anonymous visibility even when called by the wall owner through GraphQL', async () => {
    const result = await execute({
      schema,
      document: parse(SEARCH_SPRAY_WALLS_DIRECTORY),
      variableValues: { input: { query: PREFIX, limit: 24 } },
      contextValue: { connectionId: `${PREFIX}-schema-owner`, isAuthenticated: true, userId: OWNER },
    });
    expect(result.errors).toBeUndefined();
    const connection = (result.data as SearchSprayWallsDirectoryQueryResponse).searchBoards;
    expect(connection.boards.map(({ uuid }) => uuid).sort()).toEqual(
      ['public-a', 'public-b', 'other-angle', 'hidden-location'].map(wallUuid).sort(),
    );
    expect(connection.totalCount).toBe(4);
    expect(connection.boards.find(({ uuid }) => uuid === wallUuid('hidden-location'))).toMatchObject({
      locationName: null,
      latitude: null,
      longitude: null,
      distanceMeters: null,
    });
  });

  it('keeps a wall with hidden coordinates in browse results without revealing its location', async () => {
    const result = await search();
    expect(result.boards.find(({ uuid }) => uuid === wallUuid('hidden-location'))).toMatchObject({
      locationName: null,
      latitude: null,
      longitude: null,
      distanceMeters: null,
      gymName: null,
    });
    expect(await search({ query: PRIVATE_ADDRESS })).toMatchObject({ boards: [], totalCount: 0 });
  });

  it('withdraws a newly private wall on the next search', async () => {
    const uuid = wallUuid('public-a');
    await db.update(dbSchema.userBoards).set({ isPublic: false }).where(eq(dbSchema.userBoards.uuid, uuid));
    try {
      const result = await search({ angles: [40] });
      expect(result.boards.map((board) => board.uuid)).not.toContain(uuid);
      expect(result.totalCount).toBe(2);
    } finally {
      await db.update(dbSchema.userBoards).set({ isPublic: true }).where(eq(dbSchema.userBoards.uuid, uuid));
    }
  });
});
