import { describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { boardGymListedCondition, boardIdentityVisibleCondition, resourceAccessCondition } from '@boardsesh/db/queries';
import { gyms } from '@boardsesh/db/schema';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { gymVisibleCondition } from '../graphql/resolvers/social/gym-visibility';
import { mapRawGymRow, socialGymQueries } from '../graphql/resolvers/social/gyms';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { boardSessionPrivacyResolvers } from '../graphql/resolvers/shared/board-session-privacy';
import { CreateGymInputSchema, UpdateGymInputSchema } from '../validation/schemas/gyms';
import { RecordBoardSerialInputSchema } from '../validation/schemas/boards';

const dialect = new PgDialect();

describe('unlisted gym contract', () => {
  it('defaults existing and newly created gyms to listed', () => {
    const column = getTableConfig(gyms).columns.find((candidate) => candidate.name === 'is_listed');
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(true);
    expect(mapRawGymRow({ id: 1, uuid: 'gym', name: 'Gym', owner_id: 'owner', is_public: true }).isListed).toBe(true);
  });

  it('accepts an explicit unlisted setting independently of public link access', () => {
    expect(CreateGymInputSchema.parse({ name: 'QA gym', isPublic: true, isListed: false })).toMatchObject({
      isPublic: true,
      isListed: false,
    });
    expect(
      UpdateGymInputSchema.parse({ gymUuid: 'e52f8478-d7c8-4464-9462-7120cdbb783c', isListed: false }),
    ).toMatchObject({ isListed: false });
    expect(
      mapRawGymRow({ id: 1, uuid: 'gym', name: 'Gym', owner_id: 'owner', is_public: true, is_listed: false }).isListed,
    ).toBe(false);
  });

  it('separates direct gym access from anonymous discovery', () => {
    const direct = dialect.sqlToQuery(gymVisibleCondition(gyms, null)).sql;
    const discovery = dialect.sqlToQuery(gymVisibleCondition(gyms, null, true)).sql;
    expect(direct).not.toContain('is_listed');
    expect(discovery).toContain('is_listed');
    expect(discovery).toContain('is_public');
  });

  it('inherits listing on board discovery and feed identity without changing direct resource access', () => {
    const discovery = dialect.sqlToQuery(boardGymListedCondition(sql`candidate.gym_id`)).sql;
    const feedIdentity = dialect.sqlToQuery(boardIdentityVisibleCondition(sql`event.board_id`, null)).sql;
    const direct = dialect.sqlToQuery(resourceAccessCondition('board', sql`candidate.uuid`, null)).sql;
    expect(discovery).toContain('discovery_gym.is_listed');
    expect(feedIdentity).toContain('privacy_identity_board.gym_id');
    expect(feedIdentity).toContain('discovery_gym.is_listed');
    expect(direct).not.toContain('discovery_gym');
  });

  it('records optional MoonBoard fixture serials without admitting unrelated board families', () => {
    const input = {
      serialNumber: 'qa-moon-01',
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: '5,6,7,8,9,10',
    };
    expect(RecordBoardSerialInputSchema.parse(input)).toMatchObject({
      serialNumber: 'QA-MOON-01',
      boardName: 'moonboard',
    });
    expect(RecordBoardSerialInputSchema.safeParse({ ...input, boardName: 'woods' }).success).toBe(false);
    expect(RecordBoardSerialInputSchema.safeParse({ ...input, boardName: 'spray' }).success).toBe(false);
  });

  it('keeps an unlisted gym shareable while hiding its listed boards from global search', async () => {
    const ownerId = 'unlisted-gym-owner';
    const gymUuid = 'c02f8478-d7c8-4464-9462-7120cdbb783c';
    const boardUuid = 'b02f8478-d7c8-4464-9462-7120cdbb783c';
    const context = { connectionId: 'unlisted-gym-test', isAuthenticated: false } as ConnectionContext;
    await db.insert(dbSchema.users).values({ id: ownerId, email: 'unlisted-gym@test.com', name: 'Owner' });
    const [gym] = await db
      .insert(gyms)
      .values({
        uuid: gymUuid,
        slug: 'unlisted-qa-gym',
        ownerId,
        name: 'Unlisted QA gym',
        isPublic: true,
        isListed: false,
      })
      .returning();
    await db.insert(dbSchema.userBoards).values({
      uuid: boardUuid,
      slug: 'unlisted-gym-board',
      name: 'Unlisted QA board',
      ownerId,
      gymId: gym.id,
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27,28,29',
      serialNumber: 'QA-UNLISTED',
      isPublic: true,
      isUnlisted: false,
    });
    expect(await socialGymQueries.gymBySlug(null, { slug: gym.slug! }, context)).toMatchObject({
      uuid: gymUuid,
      isListed: false,
    });
    expect(await socialBoardQueries.gymBoards(null, { gymUuid }, context)).toMatchObject([
      { uuid: boardUuid, gymIsListed: false },
    ]);
    expect(await socialGymQueries.searchGyms(null, { input: { query: 'Unlisted QA' } }, context)).toMatchObject({
      gyms: [],
      totalCount: 0,
    });
    expect(await socialBoardQueries.searchBoards(null, { input: { query: 'Unlisted QA' } }, context)).toMatchObject({
      boards: [],
      totalCount: 0,
    });
    const [match] = await socialBoardQueries.observedBoardSerialMatches(
      null,
      { input: [{ boardType: 'kilter', observedSerialNumber: 'QA-UNLISTED' }] },
      context,
    );
    expect(match).toMatchObject({
      observedSerialNumber: 'QA-UNLISTED',
      candidates: [{ uuid: boardUuid, layoutId: 8, sizeId: 25 }],
    });
    const candidate = match.candidates[0];
    expect(
      boardSessionPrivacyResolvers.UserBoard.serialNumber(
        { ...candidate, ownerDisplayName: undefined, ownerAvatarUrl: undefined },
        null,
        context,
      ),
    ).toBeNull();
  });
});
