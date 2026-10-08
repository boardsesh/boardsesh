import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { resourceAccessCondition, sessionBoardLocationCondition } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { canAccessResource } from '../services/privacy';

const ownerId = 'privacy-path-owner';
let publicBoardId: number;
let privateBoardId: number;

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, name: 'Owner', email: 'privacy-path-owner@test.invalid' });
  const boards = await db
    .insert(schema.userBoards)
    .values([
      {
        uuid: 'privacy-public-path-board',
        slug: 'privacy-public-path',
        ownerId,
        name: 'Public board',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: true,
      },
      {
        uuid: 'privacy-hidden-location-board',
        slug: 'privacy-hidden-location',
        ownerId,
        name: 'Hidden location',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: true,
        hideLocation: true,
      },
      {
        uuid: 'privacy-private-path-board',
        slug: 'privacy-private-path',
        ownerId,
        name: 'Private board',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: false,
      },
    ])
    .returning({ id: schema.userBoards.id, slug: schema.userBoards.slug });
  publicBoardId = boards.find((board) => board.slug === 'privacy-public-path')!.id;
  privateBoardId = boards.find((board) => board.slug === 'privacy-private-path')!.id;
});

beforeEach(async () => {
  await db.insert(schema.boardSessions).values(
    [
      { id: 'path-catalog', boardPath: 'kilter/1/1/1/40', boardId: null },
      { id: 'path-public', boardPath: '/b/privacy-public-path/40', boardId: null },
      { id: 'path-hidden-location', boardPath: '/b/privacy-hidden-location/40', boardId: null },
      { id: 'path-private', boardPath: 'b/privacy-private-path', boardId: null },
      { id: 'path-localized', boardPath: '//es//b//privacy-private-path/40/list', boardId: null },
      { id: 'path-stale-public-board', boardPath: 'b/privacy-private-path', boardId: publicBoardId },
      { id: 'path-private-board', boardPath: 'b/privacy-public-path', boardId: privateBoardId },
      { id: 'path-missing', boardPath: '/b/missing-private-wall', boardId: null },
      { id: 'path-spray-missing', boardPath: '/spray/999999999/1/1/40', boardId: null },
    ].map((session) => ({ ...session, isPublic: true, createdByUserId: ownerId })),
  );
});

describe('legacy session paths stay within board privacy', () => {
  it('caps path-only and stale-board sessions before discovery, without shadowing the outer session ID', async () => {
    const sessions = await db
      .select({ id: schema.boardSessions.id })
      .from(schema.boardSessions)
      .where(resourceAccessCondition('session', schema.boardSessions.id, null))
      .orderBy(schema.boardSessions.id);
    expect(sessions.map((session) => session.id)).toEqual(['path-catalog', 'path-hidden-location', 'path-public']);
  });

  it('withholds location for a public wall referenced only by its legacy path', async () => {
    const visibleLocations = await db
      .select({ id: schema.boardSessions.id })
      .from(schema.boardSessions)
      .where(sessionBoardLocationCondition(schema.boardSessions.id, null))
      .orderBy(schema.boardSessions.id);
    expect(visibleLocations.map((session) => session.id)).toEqual(['path-catalog', 'path-public']);

    const ownerLocations = await db
      .select({ id: schema.boardSessions.id })
      .from(schema.boardSessions)
      .where(sessionBoardLocationCondition(schema.boardSessions.id, ownerId));
    expect(ownerLocations.some((session) => session.id === 'path-hidden-location')).toBe(true);
  });

  it('applies the same parent cap at runtime while retaining the known board owner’s access', async () => {
    expect(await canAccessResource('session', 'path-private', null)).toBe(false);
    expect(await canAccessResource('session', 'path-private', ownerId)).toBe(true);
    expect(await canAccessResource('session', 'path-stale-public-board', null)).toBe(false);
    expect(await canAccessResource('session', 'path-private-board', null)).toBe(false);
    expect(await canAccessResource('session', 'path-missing', ownerId)).toBe(false);
    expect(await canAccessResource('session', 'path-public', null)).toBe(true);
  });
});
