import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  appWorkouts,
  boardClimbAliases,
  boardClimbs,
  boardLayouts,
  boardProducts,
  boardProductSizes,
  boardSessionParticipants,
  boardSessions,
  boardseshTicks,
  oauthClient,
  oauthConnections,
  sessionWorkouts,
  userBoards,
  users,
} from '@boardsesh/db/schema';
import { PartnerSessionSchema } from '@boardsesh/public-api';
import { db } from '../db/client';
import {
  PartnerSessionReadTooLarge,
  readPartnerSessions,
  recordedSessionDuration,
} from '../services/public-api/sessions';
import { readLogbookClimbMetadata, serializeLogbookTick } from '../services/logbook-tick-serializer';
import { readLogbookTick } from '../services/logbook-feed';
import type { FeedTransaction } from '../services/logbook-feed';
import { serveLogbookSession } from '../handlers/public-api/sessions';
import { matchPublicApiPreflight, matchPublicApiRoute } from '../handlers/public-api/http';
import type { PartnerApiPrincipal } from '../auth/partner/bearer';
import type { PartnerRuntime } from '../handlers/public-api/router';

const OWNER = 'user-123';
const GUEST = 'session-sync-guest';
const HISTORICAL_START = new Date('2025-04-03T18:00:00Z');
const HISTORICAL_END = new Date('2025-04-03T19:15:10.999Z');

beforeEach(async () => {
  await db.insert(users).values({ id: GUEST, email: 'guest@session-sync.test' }).onConflictDoNothing();
});

async function createSession(overrides: Partial<typeof boardSessions.$inferInsert> = {}) {
  const [session] = await db
    .insert(boardSessions)
    .values({
      id: randomUUID(),
      boardPath: 'kilter/1/1/1/40',
      createdByUserId: OWNER,
      status: 'ended',
      startedAt: HISTORICAL_START,
      endedAt: HISTORICAL_END,
      name: 'Old volume session',
      notes: 'Worked the heel hook',
      goal: 'Move quietly',
      timezone: 'Europe/Amsterdam',
      ...overrides,
    })
    .returning();
  return session;
}

async function readSession(userId: string, exportId: string) {
  return db.transaction(async (transaction) =>
    (await readPartnerSessions(transaction, userId, [exportId])).get(exportId),
  );
}

async function logTick(sessionId: string, climbUuid: string, userId = OWNER) {
  const uuid = randomUUID();
  await db.insert(boardseshTicks).values({
    uuid,
    sessionId,
    userId,
    boardType: 'kilter',
    climbUuid,
    angle: 40,
    status: 'send',
    attemptCount: 1,
    climbedAt: '2025-04-03 18:30:00',
  });
  return uuid;
}

describe('completed partner sessions', () => {
  it('exports historical recaps, recorded seconds and opaque read-only links even without ticks', async () => {
    const session = await createSession();
    const result = await readSession(OWNER, session.exportId);
    expect(PartnerSessionSchema.parse(result)).toMatchObject({
      id: session.exportId,
      title: 'Old volume session',
      notes: 'Worked the heel hook',
      goal: 'Move quietly',
      origin: 'explicit',
      startedAt: HISTORICAL_START.toISOString(),
      endedAt: HISTORICAL_END.toISOString(),
      durationSeconds: 4510,
      timezone: 'Europe/Amsterdam',
      workout: null,
      url: `https://www.boardsesh.com/history/session/${session.exportId}`,
      appUrl: `com.boardsesh.app://history/session/${session.exportId}`,
    });
    expect(JSON.stringify(result)).not.toContain(session.id);
    expect(session.exportId).not.toBe(session.id);
  });

  it('includes inferred history but excludes active and permanent sessions', async () => {
    const inferred = await createSession({ origin: 'inferred', boardPath: null });
    const active = await createSession({ status: 'active', endedAt: null });
    const permanent = await createSession({ isPermanent: true });
    const results = await db.transaction((transaction) =>
      readPartnerSessions(transaction, OWNER, [inferred.exportId, active.exportId, permanent.exportId]),
    );
    expect([...results.keys()]).toEqual([inferred.exportId]);
    expect(results.get(inferred.exportId)?.origin).toBe('inferred');
  });

  it('requires durable participation and redacts another creator’s recap metadata', async () => {
    const session = await createSession();
    await logTick(session.id, 'arbitrary-session-tick', GUEST);
    expect(await readSession(GUEST, session.exportId)).toBeUndefined();
    await db.insert(boardSessionParticipants).values({ sessionId: session.id, userId: GUEST });
    expect(await readSession(GUEST, session.exportId)).toMatchObject({
      title: null,
      notes: null,
      goal: null,
      timezone: null,
      durationSeconds: 4510,
      board: { name: null },
    });
  });

  it('does not substitute ticks when recorded start/end bounds are missing or reversed', async () => {
    for (const bounds of [
      { startedAt: null },
      { endedAt: null },
      { startedAt: HISTORICAL_END, endedAt: HISTORICAL_START },
    ]) {
      const session = await createSession(bounds);
      await logTick(session.id, randomUUID());
      expect((await readSession(OWNER, session.exportId))?.durationSeconds).toBeNull();
    }
    expect(recordedSessionDuration(HISTORICAL_START, HISTORICAL_START)).toBe(0);
    expect(recordedSessionDuration(new Date('invalid'), HISTORICAL_END)).toBeNull();
  });

  it('reads recap clears and current access instead of serving frozen snapshot metadata', async () => {
    const session = await createSession();
    await db.insert(boardSessionParticipants).values({ sessionId: session.id, userId: GUEST });
    await db.update(boardSessions).set({ notes: null }).where(eq(boardSessions.id, session.id));
    expect((await readSession(OWNER, session.exportId))?.notes).toBeNull();
    await db.delete(boardSessionParticipants).where(eq(boardSessionParticipants.sessionId, session.id));
    expect(await readSession(GUEST, session.exportId)).toBeUndefined();
  });

  it('does not disclose someone else’s nonpublic spray-wall identity', async () => {
    const [board] = await db
      .insert(userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: OWNER,
        boardType: 'spray',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Secret garage',
        isPublic: false,
      })
      .returning();
    const session = await createSession({ boardId: board.id, boardPath: 'spray/1/1/1/40' });
    await db.insert(boardSessionParticipants).values({ sessionId: session.id, userId: GUEST });
    expect((await readSession(GUEST, session.exportId))?.board).toMatchObject({
      type: 'spray',
      name: null,
      layout: null,
      size: null,
    });
  });

  it.each([
    { path: '/b/private-spray/25', type: 'spray', angle: 25 },
    { path: 'b/private-spray/0', type: 'spray', angle: 0 },
    { path: '/fr/b/private-spray/-5/list', type: 'spray', angle: -5 },
    { path: '/spray/918271/918271/1/35/list', type: 'spray', angle: 35 },
    { path: 'spray/918271/918271/1/35', type: 'spray', angle: 35 },
    { path: '/b/private-spray', type: 'spray', angle: 40 },
    { path: '/b/private-spray/list', type: 'spray', angle: 40 },
    { path: '/b/private-spray/40.0', type: 'spray', angle: 40 },
    { path: '/b/private-spray/91', type: 'spray', angle: 40 },
    { path: '/b/private-spray/999999999999999999999999999999999999999999', type: 'spray', angle: 40 },
    // A legacy tuple must not expose the currently joined spray wall either.
    { path: '/kilter/1/1/1/25', type: 'kilter', angle: 25 },
  ])('keeps another owner’s spray identity private for $path', async ({ path, type, angle }) => {
    await db
      .insert(boardProducts)
      .values({ boardType: 'spray', id: 918271, name: 'Private product' })
      .onConflictDoNothing();
    await db
      .insert(boardLayouts)
      .values({ boardType: 'spray', id: 918271, productId: 918271, name: 'Secret layout' })
      .onConflictDoNothing();
    await db
      .insert(boardProductSizes)
      .values({ boardType: 'spray', id: 918271, productId: 918271, name: 'Secret size' })
      .onConflictDoNothing();
    const [board] = await db
      .insert(userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: GUEST,
        boardType: 'spray',
        layoutId: 918271,
        sizeId: 918271,
        setIds: '1',
        name: 'Secret borrowed wall',
        angle: 40,
        isPublic: false,
      })
      .returning();
    // The exporter created the session, but does not own its wall.
    const session = await createSession({ boardId: board.id, boardPath: path });
    const exported = await readSession(OWNER, session.exportId);
    expect(exported?.title).toBe('Old volume session');
    expect(exported?.board).toEqual({ type, angle, name: null, layout: null, size: null });
    expect(JSON.stringify(exported)).not.toContain('Secret');
  });

  it.each([
    { path: '/b/named-kilter/25/list', angle: 25 },
    { path: 'b/named-kilter', angle: 40 },
    { path: '/kilter/1/1/35/50/list', angle: 50 },
    { path: '/fr/kilter/1/1/1/30/list', angle: 30 },
    { path: 'kilter/1/1/1/0', angle: 0 },
    { path: '/kilter/1/1/1/40.0', angle: 40 },
  ])('preserves manufacturer board context for $path', async ({ path, angle }) => {
    const [board] = await db
      .insert(userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: OWNER,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Home board',
        angle: 40,
      })
      .returning();
    const session = await createSession({ boardId: board.id, boardPath: path });
    expect((await readSession(OWNER, session.exportId))?.board).toMatchObject({
      type: 'kilter',
      angle,
      name: 'Home board',
    });
  });

  it('uses a named session path angle when recovering a partner workout plan', async () => {
    const [board] = await db
      .insert(userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: OWNER,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Home board',
        angle: 40,
      })
      .returning();
    const session = await createSession({ boardId: board.id, boardPath: '/b/named-kilter/25/list' });
    const climbUuid = randomUUID();
    await db
      .insert(boardClimbs)
      .values({ uuid: climbUuid, boardType: 'kilter', layoutId: 1, name: 'Named board climb' });
    const tickId = await logTick(session.id, climbUuid);
    await db.update(boardseshTicks).set({ angle: 25 }).where(eq(boardseshTicks.uuid, tickId));
    const clientId = `source-${randomUUID()}`;
    const connectionId = randomUUID();
    const externalRef = randomUUID();
    await db.insert(oauthClient).values({ id: randomUUID(), clientId, redirectUris: ['https://source.test/callback'] });
    await db.insert(oauthConnections).values({ id: connectionId, userId: OWNER, clientId });
    await db.insert(appWorkouts).values({
      id: `wk_${randomUUID()}`,
      userId: OWNER,
      clientId,
      connectionId,
      connectionGeneration: 0,
      externalRef,
      title: 'Volume',
      sessionId: session.id,
      status: 'completed',
      expiresAt: HISTORICAL_END,
      spec: {
        externalRef,
        title: 'Volume',
        blocks: [{ type: 'volume', climbCount: 1, targetGrade: { scale: 'v', value: 3 } }],
      },
      planSnapshot: [{ index: 0, climbUuids: [climbUuid] }],
    });
    const exported = await readSession(OWNER, session.exportId);
    expect(exported?.board).toMatchObject({ type: 'kilter', angle: 25 });
    expect(exported?.workout?.stages[0].climbs[0]).toMatchObject({ angle: 25, tickIds: [tickId], skipped: false });
    expect(exported?.workout?.offPlanTickIds).toEqual([]);
  });

  it('groups ticks only for authorized sessions and only with session access enabled', async () => {
    const session = await createSession();
    const tickId = await logTick(session.id, randomUUID());
    const tick = await readLogbookTick(db, { userId: OWNER, tickUuid: tickId });
    expect(tick).not.toBeNull();
    await db.transaction(async (transaction) => {
      const withoutSessionScope = await readLogbookClimbMetadata(transaction, OWNER, [tick!]);
      expect(serializeLogbookTick(tick!, withoutSessionScope).sessionId).toBeNull();
      const authorized = await readLogbookClimbMetadata(transaction, OWNER, [tick!], { includeSessions: true });
      expect(serializeLogbookTick(tick!, authorized).sessionId).toBe(session.exportId);
    });
    await db.update(boardSessions).set({ status: 'active', endedAt: null }).where(eq(boardSessions.id, session.id));
    await db.transaction(async (transaction) => {
      const metadata = await readLogbookClimbMetadata(transaction, OWNER, [tick!], { includeSessions: true });
      expect(serializeLogbookTick(tick!, metadata).sessionId).toBeNull();
    });
  });

  it('exports full own workout details from another partner without private integration identifiers', async () => {
    const session = await createSession();
    const climbUuid = randomUUID();
    await db.insert(boardClimbs).values({ uuid: climbUuid, boardType: 'kilter', layoutId: 1, name: 'Heel practice' });
    const ownTick = await logTick(session.id, climbUuid);
    const guestTick = await logTick(session.id, climbUuid, GUEST);
    const sourceClientId = `other-partner-${randomUUID()}`;
    const sourceConnectionId = randomUUID();
    await db
      .insert(oauthClient)
      .values({ id: randomUUID(), clientId: sourceClientId, redirectUris: ['https://source.test/callback'] });
    await db.insert(oauthConnections).values({ id: sourceConnectionId, userId: OWNER, clientId: sourceClientId });
    const sourceWorkoutId = `wk_${randomUUID()}`;
    const privateExternalRef = randomUUID();
    const privateBlockExternalRef = `exercise-${randomUUID()}`;
    await db.insert(appWorkouts).values({
      id: sourceWorkoutId,
      userId: OWNER,
      clientId: sourceClientId,
      connectionId: sourceConnectionId,
      connectionGeneration: 0,
      externalRef: privateExternalRef,
      title: 'Coach’s volume',
      sessionId: session.id,
      status: 'completed',
      expiresAt: HISTORICAL_END,
      spec: {
        externalRef: privateExternalRef,
        title: 'Coach’s volume',
        notes: 'Stay on your feet',
        blocks: [
          {
            type: 'volume',
            externalRef: privateBlockExternalRef,
            climbCount: 1,
            targetGrade: { scale: 'v', value: 3 },
            restSeconds: 45,
          },
        ],
      },
    });
    await db.insert(sessionWorkouts).values({
      sessionId: session.id,
      userId: OWNER,
      revision: 1,
      plan: {
        version: 1,
        stages: [
          {
            id: `${sourceWorkoutId}:0`,
            kind: 'volume',
            targetGrade: 19,
            pacing: { mode: 'afterTick', restSeconds: 45 },
            items: [{ queueItemUuid: 'private-queue-id', climbUuid, angle: 40 }],
          },
        ],
      },
      tickMap: [{ tickUuid: ownTick, queueItemUuid: 'private-queue-id' }],
    });
    const result = await readSession(OWNER, session.exportId);
    expect(result?.workout).toMatchObject({
      source: 'partner',
      title: 'Coach’s volume',
      notes: 'Stay on your feet',
      plannedBlocks: [{ type: 'volume', climbCount: 1, targetGrade: { scale: 'v', value: 3 }, restSeconds: 45 }],
      stages: [
        {
          index: 0,
          kind: 'volume',
          pacing: { mode: 'afterTick', restSeconds: 45 },
          climbs: [{ climbId: climbUuid, name: 'Heel practice', tickIds: [ownTick], reps: ['send'], skipped: false }],
          tally: { sent: 1, attempts: 0, skipped: 0, climbs: 1 },
        },
      ],
      offPlanTickIds: [],
    });
    for (const forbidden of [
      sourceClientId,
      sourceConnectionId,
      sourceWorkoutId,
      privateExternalRef,
      privateBlockExternalRef,
      'private-queue-id',
      guestTick,
      session.id,
    ])
      expect(JSON.stringify(result)).not.toContain(forbidden);
    expect(result?.workout?.plannedBlocks[0]).not.toHaveProperty('externalRef');
  });

  it('canonicalizes merged planned climbs and still attributes raw and surviving ticks', async () => {
    const session = await createSession();
    const storedAlias = randomUUID();
    const survivingClimb = randomUUID();
    await db.insert(boardClimbs).values({
      uuid: survivingClimb,
      boardType: 'kilter',
      layoutId: 1,
      name: 'Surviving climb',
    });
    // No board_climbs row remains for the stored alias.
    await db.insert(boardClimbAliases).values({
      boardType: 'kilter',
      aliasUuid: storedAlias,
      canonicalUuid: survivingClimb,
      source: 'test',
    });
    const rawTick = await logTick(session.id, storedAlias);
    const canonicalTick = await logTick(session.id, survivingClimb);
    await db.insert(sessionWorkouts).values({
      sessionId: session.id,
      userId: OWNER,
      revision: 1,
      plan: {
        version: 1,
        stages: [
          {
            id: 'stored-stage',
            kind: 'volume',
            items: [
              { queueItemUuid: 'first-item', climbUuid: storedAlias, angle: 40 },
              { queueItemUuid: 'second-item', climbUuid: storedAlias, angle: 40 },
            ],
          },
        ],
      },
      tickMap: [],
    });
    const exported = await readSession(OWNER, session.exportId);
    const workout = exported?.workout;
    expect(workout?.stages[0].climbs).toHaveLength(2);
    for (const climb of workout?.stages[0].climbs ?? []) {
      expect(climb).toMatchObject({ climbId: survivingClimb, name: 'Surviving climb', skipped: false });
    }
    expect(workout?.stages[0].climbs.flatMap((climb) => climb.tickIds).sort()).toEqual([rawTick, canonicalTick].sort());
    expect(workout?.offPlanTickIds).toEqual([]);
    expect(JSON.stringify(exported)).not.toContain(storedAlias);
    const feedTick = await readLogbookTick(db, { userId: OWNER, tickUuid: rawTick });
    expect(feedTick?.canonicalClimbUuid).toBe(survivingClimb);
  });
});

describe('partner session HTTP contract', () => {
  const principal = (scopes: string[]): PartnerApiPrincipal => ({
    userId: OWNER,
    clientId: 'receiving-app',
    connectionId: 'connection',
    connectionGeneration: 0,
    accessTokenHash: 'test-hash',
    connectionLastUsedAt: null,
    scopes,
  });

  it('matches session GET and CORS while leaving nested or trailing paths unmatched', () => {
    const id = randomUUID();
    expect(matchPublicApiRoute('GET', `/v1/logbook/sessions/${id}`)).toMatchObject({
      kind: 'logbook-session',
      sessionId: id,
    });
    expect(matchPublicApiPreflight('OPTIONS', `/v1/logbook/sessions/${id}`)?.kind).toBe('logbook-session');
    expect(matchPublicApiRoute('GET', `/v1/logbook/sessions/${id}/`)).toBeUndefined();
    expect(matchPublicApiRoute('POST', `/v1/logbook/sessions/${id}`)).toBeUndefined();
  });

  it.each([[], ['logbook:read'], ['sessions:read']])(
    'requires both scopes before reading sessions: %s',
    async (...grantedScopes) => {
      const readSession = vi.fn();
      const runtime = { logbook: { readSession } } as unknown as PartnerRuntime;
      const result = await serveLogbookSession(runtime, principal(grantedScopes.flat()), randomUUID(), 'req-test');
      expect(result.status).toBe(403);
      expect(readSession).not.toHaveBeenCalled();
    },
  );

  it('explicitly refuses an oversized workout instead of returning unchanged-cursor success', async () => {
    const runtime = {
      logbook: {
        readSession: vi.fn().mockRejectedValue(new PartnerSessionReadTooLarge()),
        isConnectionEnded: () => false,
      },
    } as unknown as PartnerRuntime;
    const response = await serveLogbookSession(
      runtime,
      principal(['logbook:read', 'sessions:read']),
      randomUUID(),
      'req-size',
    );
    expect(response).toMatchObject({
      status: 503,
      headers: { 'retry-after': '60' },
      body: { error: 'server_error', message: expect.stringContaining('Retry with a smaller limit') },
    });
    expect(response.body).not.toHaveProperty('hasMore');
    expect(response.body).not.toHaveProperty('cursor');
  });
});

describe('large workout metadata pages', () => {
  it('keeps every metadata query below the PostgreSQL bind-parameter limit', async () => {
    const parameterCounts: number[] = [];
    const where = async (condition: SQL) => {
      parameterCounts.push(new PgDialect().sqlToQuery(condition).params.length);
      return [];
    };
    const chain = { leftJoin: () => chain, where };
    const transaction = { select: () => ({ from: () => chain }) } as unknown as FeedTransaction;
    // Without chunking the stats triples alone need 69,000 parameters.
    const plannedClimbs = Array.from({ length: 23_000 }, (_, index) => ({
      uuid: '',
      boardType: 'kilter',
      canonicalClimbUuid: `planned-${index}`,
      angle: 40,
    }));
    await readLogbookClimbMetadata(transaction, OWNER, plannedClimbs);
    expect(parameterCounts.length).toBeGreaterThan(2);
    expect(parameterCounts.every((count) => count < 65_535)).toBe(true);
  });

  it('batches alias and catalog lookups for large valid partner fallback plans', async () => {
    const parameterCounts: number[] = [];
    const sessions = Array.from({ length: 200 }, (_, sessionIndex) => ({
      session: {
        id: `session-${sessionIndex}`,
        exportId: randomUUID(),
        createdByUserId: OWNER,
        boardPath: 'kilter/1/1/1/40',
        name: null,
        notes: null,
        goal: null,
        timezone: null,
        origin: 'explicit',
        startedAt: HISTORICAL_START,
        endedAt: HISTORICAL_END,
      },
      boardType: 'kilter',
      boardName: null,
      boardAngle: 40,
      boardOwnerId: OWNER,
      layout: null,
      size: null,
    }));
    const workouts = sessions.map(({ session }, sessionIndex) => ({
      id: `wk_${sessionIndex}`,
      sessionId: session.id,
      spec: {
        externalRef: `source-${sessionIndex}`,
        title: 'Volume',
        blocks: Array.from({ length: 12 }, () => ({
          type: 'volume',
          climbCount: 40,
          targetGrade: { scale: 'v', value: 3 },
        })),
      },
      planSnapshot: Array.from({ length: 12 }, (_, index) => ({
        index,
        climbUuids: Array.from({ length: 40 }, (_, climbIndex) => `climb-${sessionIndex}-${index}-${climbIndex}`),
      })),
    }));
    interface Query extends Promise<unknown[]> {
      leftJoin(): Query;
      where(condition: SQL): Query;
      orderBy(): Query;
      limit(): Query;
    }
    function queryFor(rows: unknown[]): Query {
      const query = Promise.resolve(rows) as Query;
      query.leftJoin = () => query;
      query.orderBy = () => query;
      query.limit = () => query;
      query.where = (condition) => {
        parameterCounts.push(new PgDialect().sqlToQuery(condition).params.length);
        return query;
      };
      return query;
    }
    const transaction = {
      select: () => ({
        from: (table: unknown) => queryFor(table === boardSessions ? sessions : table === appWorkouts ? workouts : []),
      }),
    } as unknown as FeedTransaction;
    // 200 sessions * 12 valid blocks * 40 climbs = 96,000 distinct ids.
    const exported = await readPartnerSessions(
      transaction,
      OWNER,
      sessions.map(({ session }) => session.exportId),
    );
    expect(exported.size).toBe(200);
    expect(parameterCounts.every((count) => count < 65_535)).toBe(true);
    expect([...exported.values()][0].workout?.stages).toHaveLength(12);
  }, 30_000);
});
