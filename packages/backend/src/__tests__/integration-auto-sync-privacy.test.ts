import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import * as schema from '@boardsesh/db/schema';
import { generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';
import { autoSyncSessionToIntegrations } from '../integrations/export-service';

const { uploadSessionActivity } = vi.hoisted(() => ({ uploadSessionActivity: vi.fn() }));
vi.mock('../integrations/credentials', () => ({
  getFreshAccessToken: vi.fn(async (credential: { userId: string }) => `token:${credential.userId}`),
  recordSyncSuccess: vi.fn(async () => undefined),
}));
vi.mock('../integrations/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/registry')>()),
  getProvider: () => ({
    provider: 'strava',
    uploadSessionActivity,
    activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
  }),
}));

const fixtureUsers: string[] = [];
const fixtureClimbs: string[] = [];
afterEach(async () => {
  if (fixtureUsers.length) await db.delete(schema.users).where(inArray(schema.users.id, fixtureUsers.splice(0)));
  if (fixtureClimbs.length)
    await db.delete(schema.boardClimbs).where(inArray(schema.boardClimbs.uuid, fixtureClimbs.splice(0)));
  vi.clearAllMocks();
});

async function createClimber(isPrivate: boolean, autoSyncEnabled = true): Promise<string> {
  const userId = uuidv4();
  fixtureUsers.push(userId);
  await db.insert(schema.users).values({ id: userId, name: 'Export climber', email: `${userId}@test.com` });
  await db.insert(schema.userProfiles).values({ userId, isPrivate });
  await db.insert(schema.integrationCredentials).values({ userId, provider: 'strava', autoSyncEnabled });
  return userId;
}

async function createSession(ownerId: string, audience: 'public' | 'followers'): Promise<string> {
  const sessionId = uuidv4();
  await db.insert(schema.boardSessions).values({
    id: sessionId,
    createdByUserId: ownerId,
    boardPath: '/kilter/1/10/1,20/40',
    isPublic: audience === 'public',
    status: 'ended',
    startedAt: new Date('2026-06-01T10:00:00Z'),
    endedAt: new Date('2026-06-01T11:00:00Z'),
  });
  await db.insert(schema.resourcePrivacy).values({ kind: 'session', resourceId: sessionId, ownerId, audience });
  return sessionId;
}

async function logSend(userId: string, sessionId: string): Promise<void> {
  const climbUuid = uuidv4();
  fixtureClimbs.push(climbUuid);
  await db.insert(schema.boardClimbs).values({
    boardType: 'kilter',
    uuid: climbUuid,
    layoutId: 1,
    setterUsername: 'Catalog setter',
    name: 'Export climb',
    frames: 'p1r1',
    framesCount: 1,
    isDraft: false,
    isListed: true,
    edgeLeft: 0,
    edgeRight: 100,
    edgeBottom: 0,
    edgeTop: 150,
  });
  await db.insert(schema.boardseshTicks).values({
    uuid: uuidv4(),
    userId,
    sessionId,
    boardType: 'kilter',
    climbUuid,
    angle: 40,
    status: 'send',
    attemptCount: 1,
    climbedAt: '2026-06-01 10:30:00',
  });
}

describe('private session automatic integration exports', () => {
  it('exports the opted-in owner when anonymous viewers cannot read their session', async () => {
    const ownerId = await createClimber(true);
    const sessionId = await createSession(ownerId, 'followers');
    await logSend(ownerId, sessionId);
    expect(await generateSessionSummary(sessionId, null)).toBeNull();
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'private-export' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    expect(uploadSessionActivity).toHaveBeenCalledWith(
      `token:${ownerId}`,
      expect.objectContaining({ name: 'Kilter Board session — 1 send' }),
    );
    expect(
      await db.select().from(schema.integrationExports).where(eq(schema.integrationExports.userId, ownerId)),
    ).toHaveLength(1);
  });

  it('exports private participants in public sessions without exporting nonparticipants or opted-out users', async () => {
    const ownerId = await createClimber(false);
    const privateId = await createClimber(true);
    const optedOutId = await createClimber(false, false);
    await createClimber(false);
    const sessionId = await createSession(ownerId, 'public');
    await logSend(ownerId, sessionId);
    await logSend(privateId, sessionId);
    await logSend(optedOutId, sessionId);
    const anonymous = await generateSessionSummary(sessionId, null);
    expect(anonymous?.participants.some((participant) => participant.userId === privateId)).toBe(false);
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'public-export' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    expect(uploadSessionActivity).toHaveBeenCalledTimes(2);
    for (const userId of [ownerId, privateId])
      expect(uploadSessionActivity).toHaveBeenCalledWith(
        `token:${userId}`,
        expect.objectContaining({ name: 'Kilter Board session — 1 send' }),
      );
  });
});
