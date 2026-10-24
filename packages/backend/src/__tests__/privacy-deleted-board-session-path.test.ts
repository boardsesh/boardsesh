/**
 * Real-DB coverage for a session on a named board (`/b/<slug>`) after the board
 * is soft-deleted. The session stays readable, but a deleted board is no longer
 * named: everyone except its owner and the people it was shared with gets its
 * geometry path, in the session payload and in every live session event.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, SessionEvent } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { projectSessionBoardPath } from '../services/board-session-privacy';
import { buildSessionPayload } from '../graphql/resolvers/sessions/helpers';
import { sessionSubscriptions } from '../graphql/resolvers/sessions/subscriptions';

const HOST = 'deleted-path-host';
const BOARD_OWNER = 'deleted-path-board-owner';
const GRANTEE = 'deleted-path-grantee';
const STRANGER = 'deleted-path-stranger';

const SLUG = 'deleted-path-garage';
const SESSION_ID = 'deleted-path-session';
const NAMED_PATH = `/b/${SLUG}/35`;
const GEOMETRY_PATH = '/kilter/1/10/1,2/35';

const viewer = (userId: string | null): ConnectionContext =>
  ({ connectionId: `deleted-path-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

type SessionUpdate = { sessionUpdates: SessionEvent };

async function payloadPath(userId: string | null): Promise<string> {
  const [sessionData] = await db.select().from(dbSchema.boardSessions).limit(1);
  const payload = await buildSessionPayload(SESSION_ID, viewer(userId), {
    users: [],
    queueState: null,
    sessionData,
    lastConnectedBoardSerial: null,
    isLeader: false,
    clientId: '',
  });
  return payload.boardPath;
}

/** Each path the live session stream hands this member, in order. */
async function streamedPaths(userId: string): Promise<string[]> {
  const stream = sessionSubscriptions.sessionUpdates.subscribe(undefined, { sessionId: SESSION_ID }, viewer(userId));
  const nextPath = async () => {
    const { value } = (await stream.next()) as IteratorResult<SessionUpdate>;
    const event = value.sessionUpdates;
    if (event.__typename !== 'SessionRosterSnapshot' && event.__typename !== 'SessionBoardPathChanged') {
      throw new Error(`unexpected ${event.__typename}`);
    }
    return event.boardPath;
  };
  try {
    const seed = await nextPath();
    // The crew rest clock seed always follows the roster seed (#5382).
    const { value: restCadenceSeed } = (await stream.next()) as IteratorResult<SessionUpdate>;
    if (restCadenceSeed.sessionUpdates.__typename !== 'SessionRestCadenceChanged') {
      throw new Error(`unexpected ${restCadenceSeed.sessionUpdates.__typename}`);
    }
    pubsub.publishSessionEvent(SESSION_ID, {
      __typename: 'SessionBoardPathChanged',
      boardPath: `/b/${SLUG}/45`,
      changedByParticipantId: null,
    });
    const changed = await nextPath();
    // The wall event immediately re-baselines the identity-bearing roster.
    const movedRoster = await nextPath();
    return [seed, changed, movedRoster];
  } finally {
    await stream.return(undefined);
  }
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([HOST, BOARD_OWNER, GRANTEE, STRANGER].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  await db.insert(dbSchema.userBoards).values({
    uuid: 'deleted-path-board',
    slug: SLUG,
    ownerId: BOARD_OWNER,
    name: 'Marco’s Garage',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    isPublic: true,
    deletedAt: new Date(),
  });
  await db.insert(dbSchema.resourceGrants).values({
    kind: 'board',
    resourceId: 'deleted-path-board',
    userId: GRANTEE,
    status: 'approved',
  });
});

// The shared setup truncates sessions and rosters before every test.
beforeEach(async () => {
  await db.insert(dbSchema.boardSessions).values({
    id: SESSION_ID,
    boardPath: NAMED_PATH,
    createdByUserId: HOST,
    isPublic: true,
    status: 'active',
  });
  await db
    .insert(dbSchema.boardSessionParticipants)
    .values([STRANGER, BOARD_OWNER, GRANTEE].map((userId) => ({ sessionId: SESSION_ID, userId })));
});

describe('a session on a soft-deleted named board', () => {
  it('names the board only to its owner and grant holders', async () => {
    expect(await projectSessionBoardPath(NAMED_PATH, BOARD_OWNER)).toBe(NAMED_PATH);
    expect(await projectSessionBoardPath(NAMED_PATH, GRANTEE)).toBe(NAMED_PATH);
    expect(await projectSessionBoardPath(NAMED_PATH, STRANGER)).toBe(GEOMETRY_PATH);
    expect(await projectSessionBoardPath(NAMED_PATH, HOST)).toBe(GEOMETRY_PATH);
    expect(await projectSessionBoardPath(NAMED_PATH, null)).toBe(GEOMETRY_PATH);
    // No angle in the path: the retained row's angle fills it in.
    expect(await projectSessionBoardPath(`/b/${SLUG}`, STRANGER)).toBe('/kilter/1/10/1,2/40');
  });

  it('withholds the slug from strangers in the session payload', async () => {
    expect(await payloadPath(STRANGER)).toBe(GEOMETRY_PATH);
    expect(await payloadPath(null)).toBe(GEOMETRY_PATH);
    expect(await payloadPath(BOARD_OWNER)).toBe(NAMED_PATH);
    expect(await payloadPath(GRANTEE)).toBe(NAMED_PATH);
  });

  it('withholds the slug from strangers in roster snapshots and board path changes', async () => {
    expect(await streamedPaths(STRANGER)).toEqual([GEOMETRY_PATH, '/kilter/1/10/1,2/45', '/kilter/1/10/1,2/45']);
    expect(await streamedPaths(BOARD_OWNER)).toEqual([NAMED_PATH, `/b/${SLUG}/45`, `/b/${SLUG}/45`]);
  });

  it('names a slug a live board reuses by that board’s own rule', async () => {
    await db.insert(dbSchema.userBoards).values({
      uuid: 'deleted-path-reused',
      slug: SLUG,
      ownerId: HOST,
      name: 'Reused slug',
      boardType: 'tension',
      layoutId: 9,
      sizeId: 1,
      setIds: '8',
      isPublic: false,
    });
    try {
      expect(await projectSessionBoardPath(NAMED_PATH, HOST)).toBe(NAMED_PATH);
      expect(await projectSessionBoardPath(NAMED_PATH, BOARD_OWNER)).toBe('/tension/9/1/8/35');
    } finally {
      await db.delete(dbSchema.userBoards).where(eq(dbSchema.userBoards.uuid, 'deleted-path-reused'));
    }
  });

  it('names nothing for a slug no board row carries any more', async () => {
    expect(await projectSessionBoardPath('/b/deleted-path-renamed-away/40', STRANGER)).toBe('');
    expect(await projectSessionBoardPath('/b/deleted-path-renamed-away/40', BOARD_OWNER)).toBe('');
    expect(await projectSessionBoardPath('/kilter/1/10/1/40', STRANGER)).toBe('/kilter/1/10/1/40');
  });
});
