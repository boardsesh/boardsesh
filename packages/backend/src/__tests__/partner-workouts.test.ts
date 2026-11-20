import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import * as Sentry from '@sentry/node';
import * as workoutResults from '../services/public-api/workout-results';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { appWorkoutMutations } from '../graphql/resolvers/app-workouts';
import { roomManager } from '../services/room-manager';
import { getQueueState } from '../services/room-manager/queue-state';
import { parseAppWorkoutSeed } from '../services/public-api/workout-seed';
import { CreateWorkoutSchema, WorkoutResponseSchema } from '@boardsesh/public-api';
import {
  appWorkouts,
  appWorkoutRequests,
  boardSessions,
  boardSessionParticipants,
  boardseshTicks,
  boardSessionQueues,
  boardClimbs,
  boardClimbAliases,
  sessionWorkouts,
  userBoards,
} from '@boardsesh/db/schema';
import { oauthAccessToken, oauthClient, oauthResource, oauthConnections } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { findPartnerApiPrincipal, type PartnerApiPrincipal } from '../auth/partner/bearer';
import type { PartnerDatabase } from '../auth/partner/tables';
import { runInPartnerTransaction } from '../auth/partner/transaction';
import { disconnectPartnerConnection } from '../auth/partner/connection';
import {
  createPartnerTestEnvironment,
  TEST_CONFIGURATION,
  TEST_RESOURCE,
  type PartnerTestEnvironment,
} from '../auth/partner/__tests__/partner-fixture';
import { createPartnerAuthorityRuntime } from '../auth/partner/authority';
import { createPublicApiHandler } from '../handlers/public-api/router';
import { sendTo } from './helpers/partner-launch-harness';
import { redisClientManager } from '../redis/client';
import {
  createPartnerWorkout,
  readPartnerWorkout,
  listPartnerWorkouts,
  cancelPartnerWorkout,
  lockAppWorkoutForUser,
  lockAppWorkoutSession,
  attachLockedAppWorkout,
  recordAppWorkoutPlan,
  recoverAppWorkoutPlan,
  workoutExpiresAt,
} from '../services/public-api/workouts';
import {
  completeSessionAppWorkouts,
  expireAppWorkouts,
  lockSessionAppWorkouts,
} from '../services/public-api/workout-lifecycle';
import { inferWorkoutBlockIndex } from '../services/public-api/workout-results';

vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  captureException: vi.fn(),
}));

let environment: PartnerTestEnvironment;
beforeAll(async () => {
  environment = await createPartnerTestEnvironment();
  await redisClientManager.connect();
});
afterAll(async () => {
  await environment.close();
  await redisClientManager.disconnect();
});
const spec = () =>
  CreateWorkoutSchema.parse({
    externalRef: randomUUID(),
    title: 'Volume then easy climbing',
    blocks: [
      { type: 'volume', climbCount: 4, targetGrade: { scale: 'v', value: 3 } },
      { type: 'freeClimbing', durationSeconds: 300 },
    ],
  });
async function connected(scopes = ['workouts:read', 'workouts:write', 'offline_access']) {
  const client = await environment.createClient();
  const issued = await environment.issueTokens(client, scopes);
  const [token] = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId));
  const found = await findPartnerApiPrincipal(environment.database, {
    accessTokenHash: token.token,
    resource: TEST_RESOURCE,
  });
  if (!found.principal) throw new Error('Fixture token did not authenticate');
  return { client, principal: found.principal, accessToken: issued.access_token };
}
function create(principal: PartnerApiPrincipal, input = spec(), key = randomUUID(), now = new Date()) {
  return createPartnerWorkout(environment.database, principal, input, key, now, TEST_RESOURCE);
}
function read(principal: PartnerApiPrincipal, id: string) {
  return readPartnerWorkout(environment.database, principal, id, TEST_RESOURCE);
}
async function start(userId: string, id: string, sessionId = randomUUID()) {
  await db.transaction(async (tx) => {
    const transaction = tx as unknown as PartnerDatabase;
    await lockAppWorkoutSession(transaction, sessionId);
    const workout = await lockAppWorkoutForUser(transaction, userId, id);
    await tx
      .insert(boardSessions)
      .values({
        id: sessionId,
        boardPath: 'kilter/1/1/1/40',
        createdByUserId: userId,
        startedAt: new Date(Date.now() - 3600_000),
      })
      .onConflictDoNothing();
    await attachLockedAppWorkout(transaction, workout, sessionId);
  });
  return sessionId;
}

function initialSeed(workoutId: string) {
  const queueItem = { uuid: randomUUID(), climb: { uuid: randomUUID(), angle: 40 } };
  return {
    queue: [queueItem],
    currentClimbQueueItem: queueItem,
    historyCount: 0,
    plan: [
      { index: 0, climbUuids: [queueItem.climb.uuid] },
      { index: 1, climbUuids: [] },
    ],
    sessionPlan: {
      version: 1,
      stages: [
        {
          id: `${workoutId}:0`,
          kind: 'volume',
          items: [{ queueItemUuid: queueItem.uuid, climbUuid: queueItem.climb.uuid, angle: 40 }],
        },
      ],
    },
  };
}

describe('partner workouts', () => {
  it('rejects attaching round workouts before marking them started', async () => {
    const { principal } = await connected();
    const workout = await create(principal, {
      ...spec(),
      blocks: [
        {
          type: 'fourByFour',
          climbCount: 4,
          rounds: 4,
          targetGrade: { scale: 'v', value: 4 },
          restBetweenClimbsSeconds: 0,
          restBetweenRoundsSeconds: 180,
        },
      ],
    });
    const previousMode = process.env.PARTNER_OAUTH_MODE;
    process.env.PARTNER_OAUTH_MODE = 'allowlist';
    try {
      await expect(
        appWorkoutMutations.attachAppWorkout(null, { workoutId: workout.id, sessionId: randomUUID() }, {
          userId: principal.userId,
          isAuthenticated: true,
          connectionId: randomUUID(),
          transport: 'http',
        } as ConnectionContext),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT', reason: 'APP_WORKOUT_NEW_SESSION_REQUIRED' } });
      const [stored] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
      expect(stored.status).toBe('created');
      expect(stored.sessionId).toBeNull();
      expect(stored.planSnapshot).toBeNull();
    } finally {
      if (previousMode === undefined) delete process.env.PARTNER_OAUTH_MODE;
      else process.env.PARTNER_OAUTH_MODE = previousMode;
    }
  });

  it('echoes block references across create, read, replay and separate workouts', async () => {
    const { principal } = await connected();
    const input = spec();
    input.blocks[0].externalRef = 'planned-exercise';
    const key = randomUUID();
    const created = await create(principal, input, key);
    expect(created.blocks[0].externalRef).toBe('planned-exercise');
    expect(await create(principal, input, key)).toEqual(created);
    expect((await read(principal, created.id)).spec.blocks[0].externalRef).toBe('planned-exercise');
    const otherWorkout = await create(principal, { ...input, externalRef: randomUUID() });
    expect(otherWorkout.blocks[0].externalRef).toBe('planned-exercise');
    await expect(
      create(principal, { ...input, blocks: [{ ...input.blocks[0], externalRef: 'changed' }] }, key),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  });

  it('preserves a solo History line on first Start and replay, then ignores the initial hint after edits', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const previousMode = process.env.PARTNER_OAUTH_MODE;
    process.env.PARTNER_OAUTH_MODE = 'allowlist';
    const context = {
      userId: principal.userId,
      isAuthenticated: true,
      connectionId: randomUUID(),
      transport: 'http',
    } as ConnectionContext;
    const seed = initialSeed(workout.id);
    const history = [0, 1].map(() => ({ uuid: randomUUID(), climb: { uuid: randomUUID(), angle: 40 } }));
    const input = {
      boardPath: 'kilter/1/1/1/40',
      latitude: 0,
      longitude: 0,
      discoverable: false,
      appWorkoutId: workout.id,
      appWorkoutSeed: { ...seed, queue: [...history, ...seed.queue], currentClimbQueueItem: null, historyCount: 2 },
    };
    try {
      const first = await sessionMutations.createSession(null, { input }, context);
      expect(first.queueState?.historyCount).toBe(2);
      expect(first.queueState?.currentClimbQueueItem).toBeNull();
      roomManager.reset();
      const replay = await sessionMutations.createSession(null, { input }, context);
      expect(replay.id).toBe(first.id);
      expect(replay.queueState?.historyCount).toBe(2);
      expect((await getQueueState(first.id, null)).historyCount).toBe(2);
      await db.update(boardSessionQueues).set({ version: 2 }).where(eq(boardSessionQueues.sessionId, first.id));
      expect((await getQueueState(first.id, null)).historyCount).toBe(0);
    } finally {
      if (previousMode === undefined) delete process.env.PARTNER_OAUTH_MODE;
      else process.env.PARTNER_OAUTH_MODE = previousMode;
    }
  });

  it('normalizes an orphan solo Now at the history boundary and keeps the plan cap', () => {
    const seed = initialSeed(randomUUID());
    const solo = { uuid: randomUUID(), climb: { uuid: randomUUID(), angle: 40 } };
    const orphan = { uuid: randomUUID(), climb: { uuid: randomUUID(), angle: 40 } };
    const parsed = parseAppWorkoutSeed({
      ...seed,
      queue: [solo, ...seed.queue],
      currentClimbQueueItem: orphan,
      historyCount: 1,
    });
    expect(parsed.queue.map((item) => item.uuid)).toEqual([solo.uuid, orphan.uuid, seed.queue[0].uuid]);
    expect(parsed.historyCount).toBe(1);
    expect(parsed.currentClimbQueueItem?.uuid).toBe(orphan.uuid);
    const oversizedItems = Array.from({ length: 501 }, () => ({
      queueItemUuid: randomUUID(),
      climbUuid: randomUUID(),
      angle: 40,
    }));
    expect(() =>
      parseAppWorkoutSeed({
        ...seed,
        sessionPlan: { version: 1, stages: [{ ...seed.sessionPlan.stages[0], items: oversizedItems }] },
      }),
    ).toThrow('Invalid initial workout stages.');
  });

  it('commits exactly one winning preview when two phones start the same workout', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const previousMode = process.env.PARTNER_OAUTH_MODE;
    process.env.PARTNER_OAUTH_MODE = 'allowlist';
    const context = {
      userId: principal.userId,
      isAuthenticated: true,
      connectionId: randomUUID(),
      transport: 'http',
    } as ConnectionContext;
    const firstSeed = initialSeed(workout.id);
    const secondSeed = initialSeed(workout.id);
    const input = {
      boardPath: 'kilter/1/1/1/40',
      latitude: 0,
      longitude: 0,
      discoverable: false,
      appWorkoutId: workout.id,
    };
    try {
      const [first, second] = await Promise.all([
        sessionMutations.createSession(null, { input: { ...input, appWorkoutSeed: firstSeed } }, context),
        sessionMutations.createSession(null, { input: { ...input, appWorkoutSeed: secondSeed } }, context),
      ]);
      expect(first.id).toBe(second.id);
      expect(await db.$count(boardSessions, eq(boardSessions.createdByUserId, principal.userId))).toBe(1);
      const [queue] = await db.select().from(boardSessionQueues).where(eq(boardSessionQueues.sessionId, first.id));
      expect([firstSeed.queue[0].uuid, secondSeed.queue[0].uuid]).toContain(queue.queue[0].uuid);
      const [recorded] = await db.select().from(sessionWorkouts).where(eq(sessionWorkouts.sessionId, first.id));
      const winner = queue.queue[0].uuid === firstSeed.queue[0].uuid ? firstSeed : secondSeed;
      expect(recorded.plan).toEqual(winner.sessionPlan);
    } finally {
      if (previousMode === undefined) delete process.env.PARTNER_OAUTH_MODE;
      else process.env.PARTNER_OAUTH_MODE = previousMode;
    }
  });

  it('rolls back Start when the initial queue, stages or block snapshot disagree', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const previousMode = process.env.PARTNER_OAUTH_MODE;
    process.env.PARTNER_OAUTH_MODE = 'allowlist';
    const context = {
      userId: principal.userId,
      isAuthenticated: true,
      connectionId: randomUUID(),
      transport: 'http',
    } as ConnectionContext;
    const seed = initialSeed(workout.id);
    const input = {
      boardPath: 'kilter/1/1/1/40',
      latitude: 0,
      longitude: 0,
      discoverable: false,
      appWorkoutId: workout.id,
    };
    try {
      const wrongStage = structuredClone(seed);
      wrongStage.sessionPlan.stages[0].items[0].angle = 45;
      const wrongSnapshot = structuredClone(seed);
      wrongSnapshot.plan[0].climbUuids = [randomUUID()];
      const historyStage = { ...seed, currentClimbQueueItem: null, historyCount: 1 };
      for (const appWorkoutSeed of [wrongStage, wrongSnapshot, historyStage])
        await expect(
          sessionMutations.createSession(null, { input: { ...input, appWorkoutSeed } }, context),
        ).rejects.toThrow();
      expect(await db.$count(boardSessions, eq(boardSessions.createdByUserId, principal.userId))).toBe(0);
      const [stored] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
      expect(stored.status).toBe('created');
      expect(stored.sessionId).toBeNull();
      expect(stored.planSnapshot).toBeNull();
    } finally {
      if (previousMode === undefined) delete process.env.PARTNER_OAUTH_MODE;
      else process.env.PARTNER_OAUTH_MODE = previousMode;
    }
  });

  it('upgrades an existing managed M1 app without widening an issued token', async () => {
    const client = await environment.createClient();
    const originalScopes = ['logbook:read', 'profile:read', 'offline_access'];
    await db.update(oauthClient).set({ scopes: originalScopes }).where(eq(oauthClient.clientId, client.clientId));
    await db
      .update(oauthResource)
      .set({ allowedScopes: originalScopes })
      .where(eq(oauthResource.identifier, TEST_RESOURCE));
    await environment.issueTokens(client, ['profile:read', 'offline_access']);
    const before = await environment.authorize(client, { scopes: ['workouts:write'] });
    expect(new URL(before.location!).searchParams.get('error')).toBe('invalid_scope');
    const migration = readFileSync(
      new URL('../../../db/drizzle/0322_partner_webhook_event_generations.sql', import.meta.url),
      'utf8',
    );
    const backfill = migration
      .slice(migration.indexOf('-- Publish new capabilities'))
      .replaceAll('https://api.boardsesh.com/v1', TEST_RESOURCE);
    await db.execute(sql.raw(backfill));
    const after = await environment.authorize(client, { scopes: ['workouts:write'] });
    const exchanged = await environment.exchange(client, after);
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.body.scope).toBe('workouts:write');
    const oldTokens = await db
      .select({ scopes: oauthAccessToken.scopes })
      .from(oauthAccessToken)
      .where(and(eq(oauthAccessToken.clientId, client.clientId), eq(oauthAccessToken.userId, client.owner.userId)));
    expect(oldTokens.some((token) => token.scopes.join(' ') === 'profile:read offline_access')).toBe(true);
  });

  it('removes expired idempotency receipts while preserving live receipts', async () => {
    const { principal } = await connected();
    const expiredKey = randomUUID();
    const liveKey = randomUUID();
    await create(principal, spec(), expiredKey);
    await create(principal, spec(), liveKey);
    await db
      .update(appWorkoutRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(appWorkoutRequests.clientId, principal.clientId), eq(appWorkoutRequests.key, expiredKey)));
    await db.transaction((tx) => expireAppWorkouts(tx as unknown as PartnerDatabase));
    const remaining = await db
      .select({ key: appWorkoutRequests.key })
      .from(appWorkoutRequests)
      .where(eq(appWorkoutRequests.clientId, principal.clientId));
    expect(remaining).toEqual([{ key: liveKey }]);
  });

  it('drains expired receipts in bounded batches while retaining live receipts', async () => {
    const { principal } = await connected();
    await create(principal);
    const [template] = await db
      .select()
      .from(appWorkoutRequests)
      .where(eq(appWorkoutRequests.clientId, principal.clientId));
    await db.insert(appWorkoutRequests).values(
      Array.from({ length: 1001 }, () => ({
        ...template,
        key: randomUUID(),
        expiresAt: new Date(Date.now() - 1000),
      })),
    );
    await db.transaction((tx) => expireAppWorkouts(tx as unknown as PartnerDatabase));
    expect(await db.$count(appWorkoutRequests, eq(appWorkoutRequests.clientId, principal.clientId))).toBe(2);
    await db.transaction((tx) => expireAppWorkouts(tx as unknown as PartnerDatabase));
    expect(await db.$count(appWorkoutRequests, eq(appWorkoutRequests.clientId, principal.clientId))).toBe(1);
  });

  it('returns the original session when Start is retried after its response was lost', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const previousMode = process.env.PARTNER_OAUTH_MODE;
    process.env.PARTNER_OAUTH_MODE = 'allowlist';
    const context = {
      userId: principal.userId,
      isAuthenticated: true,
      connectionId: randomUUID(),
      transport: 'http',
    } as ConnectionContext;
    const input = {
      boardPath: 'kilter/1/1/1/40',
      latitude: 0,
      longitude: 0,
      discoverable: false,
      appWorkoutId: workout.id,
      appWorkoutSeed: initialSeed(workout.id),
    };
    try {
      const first = await sessionMutations.createSession(null, { input }, context);
      roomManager.reset();
      const second = await sessionMutations.createSession(
        null,
        { input: { ...input, appWorkoutSeed: initialSeed(workout.id) } },
        context,
      );
      expect(second.id).toBe(first.id);
      await expect(
        sessionMutations.createSession(null, { input: { ...input, boardPath: 'kilter/1/1/1/45' } }, context),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      expect(await db.$count(boardSessions, eq(boardSessions.createdByUserId, principal.userId))).toBe(1);
      const [stored] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
      expect(stored.sessionId).toBe(first.id);
      expect(stored.status).toBe('started');
      const [queue] = await db.select().from(boardSessionQueues).where(eq(boardSessionQueues.sessionId, first.id));
      expect(queue.queue[0].uuid).toBe(input.appWorkoutSeed.queue[0].uuid);
      expect(second.queueState?.queue[0].uuid).toBe(input.appWorkoutSeed.queue[0].uuid);
      const [recorded] = await db.select().from(sessionWorkouts).where(eq(sessionWorkouts.sessionId, first.id));
      expect(recorded.plan).toEqual(input.appWorkoutSeed.sessionPlan);
    } finally {
      if (previousMode === undefined) delete process.env.PARTNER_OAUTH_MODE;
      else process.env.PARTNER_OAUTH_MODE = previousMode;
    }
  });

  it('refuses permanent session attachment and reports expected Start conflicts without Sentry', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = randomUUID();
    await db
      .insert(boardSessions)
      .values({ id: sessionId, createdByUserId: principal.userId, boardPath: 'kilter/1/1/1/40', isPermanent: true });
    await expect(start(principal.userId, workout.id, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'APP_WORKOUT_PERMANENT_SESSION',
    });
    expect((await read(principal, workout.id)).status).toBe('created');
    const capture = vi.mocked(Sentry.captureException);
    capture.mockClear();
    const previousMode = process.env.PARTNER_OAUTH_MODE;
    process.env.PARTNER_OAUTH_MODE = 'allowlist';
    try {
      await cancelPartnerWorkout(environment.database, principal, workout.id, TEST_RESOURCE);
      await expect(
        sessionMutations.createSession(
          null,
          {
            input: {
              boardPath: 'kilter/1/1/1/40',
              latitude: 0,
              longitude: 0,
              discoverable: false,
              appWorkoutId: workout.id,
            },
          },
          {
            userId: principal.userId,
            isAuthenticated: true,
            connectionId: randomUUID(),
            transport: 'http',
          } as ConnectionContext,
        ),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      expect(capture).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.PARTNER_OAUTH_MODE;
      else process.env.PARTNER_OAUTH_MODE = previousMode;
    }
  });

  it('preserves partner timeouts in a read-only repeatable-read results snapshot', async () => {
    const settings = await runInPartnerTransaction(
      environment.database,
      (transaction) =>
        transaction.execute(sql`
      select current_setting('transaction_isolation') as isolation,
             current_setting('transaction_read_only') as read_only,
             current_setting('lock_timeout') as lock_timeout,
             current_setting('statement_timeout') as statement_timeout,
             current_setting('idle_in_transaction_session_timeout') as idle_timeout
    `),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(settings[0]).toMatchObject({
      isolation: 'repeatable read',
      read_only: 'on',
      lock_timeout: '2s',
      statement_timeout: '5s',
      idle_timeout: '10s',
    });
  });

  it('releases the connection during list results and refuses a concurrent Disconnect', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = await start(principal.userId, workout.id);
    await db.update(boardSessions).set({ endedAt: new Date(), status: 'ended' }).where(eq(boardSessions.id, sessionId));
    await db.update(appWorkouts).set({ status: 'completed' }).where(eq(appWorkouts.id, workout.id));
    let reportBuilding!: () => void;
    const building = new Promise<void>((resolve) => {
      reportBuilding = resolve;
    });
    let releaseBuilder!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      releaseBuilder = resolve;
    });
    const original = workoutResults.buildWorkoutResults;
    const builder = vi.spyOn(workoutResults, 'buildWorkoutResults').mockImplementation(async (transaction, row) => {
      reportBuilding();
      await mayFinish;
      return original(transaction, row);
    });
    const listing = listPartnerWorkouts(environment.database, principal, { limit: 100 }, TEST_RESOURCE);
    const refusal = expect(listing).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    try {
      await building;
      // This must finish while result construction is paused: the old implementation deadlocked here.
      await disconnectPartnerConnection(environment.database, {
        userId: principal.userId,
        clientId: principal.clientId,
        reason: 'climber_disconnect',
      });
    } finally {
      releaseBuilder();
      await refusal;
      builder.mockRestore();
    }
  });

  it('lets different party members run their own workouts in the same session', async () => {
    const first = await connected();
    const second = await connected();
    const firstWorkout = await create(first.principal);
    const secondWorkout = await create(second.principal);
    const sessionId = await start(first.principal.userId, firstWorkout.id);
    const [privateBoard] = await db
      .insert(userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: first.principal.userId,
        name: 'Secret garage',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        angle: 40,
      })
      .returning();
    await db
      .update(boardSessions)
      .set({ boardId: privateBoard.id, notes: 'Private recap', timezone: 'America/Los_Angeles' })
      .where(eq(boardSessions.id, sessionId));
    await db.insert(boardSessionParticipants).values({ sessionId, userId: second.principal.userId });
    await start(second.principal.userId, secondWorkout.id, sessionId);
    await db.transaction(async (tx) => {
      const transaction = tx as unknown as PartnerDatabase;
      const workouts = await lockSessionAppWorkouts(transaction, sessionId);
      expect(workouts).toHaveLength(2);
      await tx
        .update(boardSessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(eq(boardSessions.id, sessionId));
      await completeSessionAppWorkouts(transaction, workouts, 'completed', new Date());
    });
    expect((await read(first.principal, firstWorkout.id)).status).toBe('completed');
    const ownResults = (await read(first.principal, firstWorkout.id)).results;
    expect(ownResults?.session).toMatchObject({
      notes: 'Private recap',
      timezone: 'America/Los_Angeles',
      board: { name: 'Secret garage' },
    });
    const guestResults = await read(second.principal, secondWorkout.id);
    expect(guestResults.status).toBe('completed');
    expect(guestResults.results?.session).toMatchObject({
      notes: null,
      timezone: null,
      board: { name: null, type: 'kilter', angle: 40 },
    });
    await expect(read(second.principal, firstWorkout.id)).rejects.toMatchObject({ status: 404 });
  });

  it('starts a freeform-only workout without generated climbs', async () => {
    const { principal } = await connected();
    const input = CreateWorkoutSchema.parse({
      externalRef: randomUUID(),
      title: 'Easy climbing',
      blocks: [{ type: 'freeClimbing', instructions: 'Climb easily for ten minutes.', durationSeconds: 600 }],
    });
    const workout = await create(principal, input);
    await start(principal.userId, workout.id);
    await db.transaction((tx) =>
      recordAppWorkoutPlan(tx as unknown as PartnerDatabase, principal.userId, workout.id, [
        { index: 0, climbUuids: [] },
      ]),
    );
    expect((await read(principal, workout.id)).status).toBe('started');
  });
  it('serializes a new attachment against an End that already enumerated the session', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = randomUUID();
    await db.insert(boardSessions).values({
      id: sessionId,
      boardPath: 'kilter/1/1/1/40',
      createdByUserId: principal.userId,
      startedAt: new Date(),
    });
    let releaseEnd!: () => void;
    const endMayCommit = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let reportEnumerated!: () => void;
    const enumerated = new Promise<void>((resolve) => {
      reportEnumerated = resolve;
    });
    const ending = db.transaction(async (tx) => {
      const transaction = tx as unknown as PartnerDatabase;
      const workouts = await lockSessionAppWorkouts(transaction, sessionId);
      expect(workouts).toHaveLength(0);
      reportEnumerated();
      await endMayCommit;
      await tx
        .update(boardSessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(eq(boardSessions.id, sessionId));
      await completeSessionAppWorkouts(transaction, workouts, 'completed', new Date());
    });
    await enumerated;
    const attaching = start(principal.userId, workout.id, sessionId).then(
      () => 'started',
      () => 'refused',
    );
    releaseEnd();
    await ending;
    expect(await attaching).toBe('refused');
    const [row] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
    expect(row.status).toBe('created');
  });

  it('serves create, get, list and cancel through the authenticated HTTP router', async () => {
    const owner = await connected();
    const runtime = await createPartnerAuthorityRuntime(environment.database, TEST_CONFIGURATION, {
      logbook: { feed: db, snapshots: db },
      close: async () => {},
    });
    const handler = createPublicApiHandler({ mode: 'allowlist', loadRuntime: async () => runtime });
    const server = createServer((request, response) => {
      void handler(request, response)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404);
            response.end();
          }
        })
        .catch(() => {
          response.writeHead(500);
          response.end();
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const headers = {
      authorization: `Bearer ${owner.accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    };
    try {
      // Deliberately never send the declared body: anonymous callers must be
      // refused before occupying a body slot or waiting for its five-second timeout.
      const anonymousStatus = await new Promise<number>((resolve, reject) => {
        const pending = request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/workouts',
            method: 'POST',
            headers: {
              host: 'api.boardsesh.com',
              'content-type': 'application/json',
              'content-length': '100',
            },
          },
          (response) => {
            response.resume();
            response.on('end', () => {
              pending.destroy();
              resolve(response.statusCode ?? 0);
            });
          },
        );
        pending.on('error', reject);
        pending.flushHeaders();
      });
      expect(anonymousStatus).toBe(401);
      const invalidToken = await sendTo(port, 'POST', '/v1/workouts', {
        headers: { ...headers, authorization: 'Bearer junk-token' },
        body: '{',
      });
      expect(invalidToken.status).toBe(401);
      const input = spec();
      const created = await sendTo(port, 'POST', '/v1/workouts', { headers, body: JSON.stringify(input) });
      expect(created.status).toBe(201);
      const body = JSON.parse(created.body) as { id: string };
      const detail = await sendTo(port, 'GET', `/v1/workouts/${body.id}`, { headers });
      expect(detail.status).toBe(200);
      expect(WorkoutResponseSchema.parse(JSON.parse(detail.body)).externalRef).toBe(input.externalRef);
      const list = await sendTo(port, 'GET', `/v1/workouts?externalRef=${input.externalRef}`, { headers });
      expect(list.status).toBe(200);
      expect((JSON.parse(list.body) as { workouts: unknown[] }).workouts).toHaveLength(1);
      const replay = await sendTo(port, 'POST', '/v1/workouts', { headers, body: JSON.stringify(input) });
      expect(replay.status).toBe(201);
      expect(replay.body).toBe(created.body);
      const cancelled = await sendTo(port, 'DELETE', `/v1/workouts/${body.id}`, { headers });
      expect(cancelled.status).toBe(204);
      expect((await read(owner.principal, body.id)).status).toBe('cancelled');
      const malformed = await sendTo(port, 'POST', '/v1/workouts', { headers, body: '{' });
      expect(malformed.status).toBe(400);
      const oversized = await sendTo(port, 'POST', '/v1/workouts', {
        headers,
        body: JSON.stringify({ notes: 'x'.repeat(65_536) }),
      });
      expect(oversized.status).toBe(413);
      const narrow = await connected(['workouts:read']);
      const refused = await sendTo(port, 'POST', '/v1/workouts', {
        headers: { ...headers, authorization: `Bearer ${narrow.accessToken}` },
        body: JSON.stringify(spec()),
      });
      expect(refused.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await runtime.close();
    }
  });

  it('refuses attachment to an inferred session even if it is accidentally active', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = randomUUID();
    await db
      .insert(boardSessions)
      .values({ id: sessionId, origin: 'inferred', status: 'active', createdByUserId: principal.userId });
    await expect(
      db.transaction(async (tx) => {
        const transaction = tx as unknown as PartnerDatabase;
        const row = await lockAppWorkoutForUser(transaction, principal.userId, workout.id);
        await attachLockedAppWorkout(transaction, row, sessionId);
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('replays idempotency exactly, rejects mismatches and keeps cancelled references reserved', async () => {
    const { principal } = await connected();
    const input = spec();
    const key = randomUUID();
    const [first, retry] = await Promise.all([create(principal, input, key), create(principal, input, key)]);
    expect(first).toEqual(retry);
    await expect(create(principal, { ...input, title: 'Another title' }, key)).rejects.toMatchObject({
      status: 422,
      code: 'idempotency_mismatch',
    });
    await cancelPartnerWorkout(environment.database, principal, first.id, TEST_RESOURCE);
    await expect(create(principal, input)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      existing: { id: first.id },
    });
  });

  it('enforces the unfinished cap even when two writers race for the last slot', async () => {
    const { principal } = await connected();
    for (let index = 0; index < 19; index++) await create(principal);
    const results = await Promise.allSettled([create(principal), create(principal)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'workout_limit' },
    });
  });

  it('keeps token scopes and app/climber ownership separate', async () => {
    const owner = await connected();
    const outsider = await connected();
    const workout = await create(owner.principal);
    await expect(read(outsider.principal, workout.id)).rejects.toMatchObject({ status: 404 });
    const narrow = await connected(['workouts:read']);
    await expect(create(narrow.principal)).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
  });

  it('starts once per climber/session, accepts a retry and refuses a second workout', async () => {
    const { principal } = await connected();
    const first = await create(principal);
    const second = await create(principal);
    const sessionId = await start(principal.userId, first.id);
    await expect(start(principal.userId, first.id, sessionId)).resolves.toBe(sessionId);
    await expect(start(principal.userId, second.id, sessionId)).rejects.toMatchObject({ status: 409 });
    await expect(cancelPartnerWorkout(environment.database, principal, first.id, TEST_RESOURCE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('returns only the owner ticks, conservatively attributes duplicate climbs and reflects edits/deletions', async () => {
    const { principal } = await connected();
    const other = await environment.createClimber();
    const workout = await create(principal);
    const sessionId = await start(principal.userId, workout.id);
    const climbUuid = randomUUID();
    const ownUuid = randomUUID();
    await db.transaction((tx) =>
      recordAppWorkoutPlan(tx as unknown as PartnerDatabase, principal.userId, workout.id, [
        { index: 0, climbUuids: [climbUuid] },
        { index: 1, climbUuids: [climbUuid] },
      ]),
    );
    await db.insert(boardseshTicks).values([
      {
        uuid: ownUuid,
        userId: principal.userId,
        boardType: 'kilter',
        climbUuid,
        angle: 40,
        status: 'send',
        climbedAt: new Date().toISOString(),
        sessionId,
      },
      {
        uuid: randomUUID(),
        userId: other.userId,
        boardType: 'kilter',
        climbUuid,
        angle: 40,
        status: 'send',
        climbedAt: new Date().toISOString(),
        sessionId,
      },
    ]);
    await db.transaction(async (tx) => {
      const transaction = tx as unknown as PartnerDatabase;
      const workouts = await lockSessionAppWorkouts(transaction, sessionId);
      await tx
        .update(boardSessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(eq(boardSessions.id, sessionId));
      await completeSessionAppWorkouts(transaction, workouts, 'completed', new Date());
    });
    const result = await read(principal, workout.id);
    expect(WorkoutResponseSchema.safeParse(result).success).toBe(true);
    expect(result.results?.ticks).toHaveLength(1);
    expect(result.results?.ticks[0]).toMatchObject({ id: ownUuid, blockIndex: null });
    expect(JSON.stringify(result)).not.toContain(sessionId);
    await db.update(boardseshTicks).set({ comment: 'Edited after End' }).where(eq(boardseshTicks.uuid, ownUuid));
    expect((await read(principal, workout.id)).results?.ticks[0].comment).toBe('Edited after End');
    await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, ownUuid));
    expect((await read(principal, workout.id)).results?.ticks).toHaveLength(0);
  });

  it('recovers the original plan from the durable session-workout write', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = await start(principal.userId, workout.id);
    const climbUuid = randomUUID();
    await db.transaction((tx) =>
      recoverAppWorkoutPlan(tx as unknown as PartnerDatabase, principal.userId, sessionId, {
        stages: [{ id: `${workout.id}:0`, items: [{ climbUuid }] }],
      }),
    );
    const [row] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
    expect(row.planSnapshot).toEqual([
      { index: 0, climbUuids: [climbUuid] },
      { index: 1, climbUuids: [] },
    ]);
    await expect(
      db.transaction((tx) =>
        recordAppWorkoutPlan(tx as unknown as PartnerDatabase, principal.userId, workout.id, [
          { index: 0, climbUuids: [climbUuid, climbUuid] },
          { index: 1, climbUuids: [] },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it('expires opened workouts and completes inactivity-closed ones without session identifiers', async () => {
    const { principal } = await connected();
    const expired = await create(principal);
    const running = await create(principal);
    await db
      .update(appWorkouts)
      .set({ status: 'opened', expiresAt: new Date(Date.now() - 1000) })
      .where(eq(appWorkouts.id, expired.id));
    await db.transaction((tx) => expireAppWorkouts(tx as unknown as PartnerDatabase));
    expect((await read(principal, expired.id)).status).toBe('expired');
    const sessionId = await start(principal.userId, running.id);
    await db.transaction(async (tx) => {
      const transaction = tx as unknown as PartnerDatabase;
      const workouts = await lockSessionAppWorkouts(transaction, sessionId);
      await tx
        .update(boardSessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(eq(boardSessions.id, sessionId));
      await completeSessionAppWorkouts(transaction, workouts, 'auto_closed', new Date());
    });
    expect((await read(principal, running.id)).results?.completion).toBe('auto_closed');
  });

  it('leaves workouts alive after token-only revoke but revokes them on Disconnect and security revocation', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    await db
      .update(oauthAccessToken)
      .set({ revoked: new Date() })
      .where(eq(oauthAccessToken.token, principal.accessTokenHash));
    await expect(start(principal.userId, workout.id)).resolves.toBeTypeOf('string');
    await disconnectPartnerConnection(environment.database, {
      userId: principal.userId,
      clientId: principal.clientId,
      reason: 'climber_disconnect',
    });
    const [revoked] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
    expect(revoked.status).toBe('revoked');
    await expect(start(principal.userId, workout.id)).rejects.toMatchObject({ status: 409 });
    const next = await connected();
    const pending = await create(next.principal);
    await db.execute(sql`select public.partner_revoke_user(${next.principal.userId})`);
    const [secured] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, pending.id));
    expect(secured.status).toBe('revoked');
  });

  it('serializes Start and Disconnect without leaving a live workout behind', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    await Promise.allSettled([
      start(principal.userId, workout.id),
      disconnectPartnerConnection(environment.database, {
        userId: principal.userId,
        clientId: principal.clientId,
        reason: 'climber_disconnect',
      }),
    ]);
    const [row] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workout.id));
    expect(row.status).toBe('revoked');
    const [connection] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.clientId, principal.clientId), eq(oauthConnections.userId, principal.userId)));
    expect(connection.revokedAt).not.toBeNull();
  });
});

describe('partner workout results', () => {
  it.each([
    { boardType: 'kilter', path: '/b/named-kilter/25/list', angle: 25 },
    { boardType: 'tension', path: '/b/named-tension/25/list', angle: 25 },
    { boardType: 'kilter', path: 'kilter/1/1/1/45', angle: 45 },
    { boardType: 'tension', path: '/es/tension/1/1/1/35/list', angle: 35 },
  ])('uses actual session angle instead of the saved board default for $path', async ({ boardType, path, angle }) => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = await start(principal.userId, workout.id);
    const [board] = await db
      .insert(userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: principal.userId,
        name: 'Configured wall',
        boardType,
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        angle: 40,
      })
      .returning();
    await db.update(boardSessions).set({ boardId: board.id, boardPath: path }).where(eq(boardSessions.id, sessionId));
    await endSession(sessionId);
    expect((await read(principal, workout.id)).results?.session.board).toMatchObject({
      type: boardType,
      angle,
      name: 'Configured wall',
    });
  });

  it.each([false, true])(
    'resolves pinned alias visits and follows later alias reassignment (original row: %s)',
    async (originalRow) => {
      const { principal } = await connected();
      const input = CreateWorkoutSchema.parse({
        externalRef: randomUUID(),
        title: 'Alias round',
        blocks: [
          {
            type: 'fourByFour',
            climbCount: 1,
            rounds: 1,
            targetGrade: { scale: 'v', value: 4 },
            restBetweenClimbsSeconds: 0,
            restBetweenRoundsSeconds: 0,
          },
        ],
      });
      const workout = await create(principal, input);
      const sessionId = await start(principal.userId, workout.id);
      const aliasUuid = randomUUID();
      const canonicalUuid = randomUUID();
      const replacementUuid = randomUUID();
      await db
        .insert(boardClimbs)
        .values([
          { uuid: canonicalUuid, boardType: 'kilter', layoutId: 1, name: 'Canonical' },
          { uuid: replacementUuid, boardType: 'kilter', layoutId: 1, name: 'Replacement' },
          ...(originalRow ? [{ uuid: aliasUuid, boardType: 'kilter', layoutId: 1, name: 'Original' }] : []),
        ]);
      await db.insert(boardClimbAliases).values({ boardType: 'kilter', aliasUuid, canonicalUuid, source: 'test' });
      // A live original catalog row identifies the board even if another board
      // happens to use the same alias. Never select that board's mapping.
      if (originalRow)
        await db.insert(boardClimbAliases).values({
          boardType: 'tension',
          aliasUuid,
          canonicalUuid: replacementUuid,
          source: 'test',
        });
      const tickUuid = await logTick(principal.userId, sessionId, canonicalUuid, new Date());
      const queueItemUuid = randomUUID();
      await db.insert(sessionWorkouts).values({
        sessionId,
        userId: principal.userId,
        revision: 1,
        plan: {
          version: 1,
          stages: [
            {
              id: `${workout.id}:0`,
              kind: 'fourByFour',
              items: [{ queueItemUuid, climbUuid: aliasUuid, angle: 40, position: 0 }],
              pacing: {
                mode: 'afterTick',
                advanceOn: 'round',
                restSeconds: 0,
                roundCount: 1,
                climbsPerRound: 1,
                restBetweenRoundsSeconds: 0,
              },
            },
          ],
        },
        tickMap: [{ tickUuid, queueItemUuid }],
      });
      await endSession(sessionId);
      const completed = (await read(principal, workout.id)).results;
      expect(completed?.blocks[0].progress).toMatchObject({ status: 'completed', completedRounds: 1, sends: 1 });
      expect(completed?.ticks[0]).toMatchObject({ id: tickUuid, position: { roundIndex: 0, climbIndex: 0 } });
      await db
        .update(boardClimbAliases)
        .set({ canonicalUuid: replacementUuid })
        .where(and(eq(boardClimbAliases.aliasUuid, aliasUuid), eq(boardClimbAliases.boardType, 'kilter')));
      const changed = (await read(principal, workout.id)).results;
      expect(changed?.blocks[0].progress).toBeNull();
      expect(changed?.ticks[0]).not.toHaveProperty('position');
      // A tick still carrying the alias resolves to the new survivor on read too.
      await db.update(boardseshTicks).set({ climbUuid: aliasUuid }).where(eq(boardseshTicks.uuid, tickUuid));
      expect((await read(principal, workout.id)).results?.blocks[0].progress).toMatchObject({
        status: 'completed',
        completedRounds: 1,
        sends: 1,
      });
    },
  );

  it('returns mapped round progress and block references, then updates it after deletion', async () => {
    const { principal } = await connected();
    const input = CreateWorkoutSchema.parse({
      externalRef: randomUUID(),
      title: 'Four rounds',
      blocks: [
        {
          externalRef: 'today-four',
          type: 'fourByFour',
          climbCount: 4,
          rounds: 4,
          targetGrade: { scale: 'v', value: 4 },
          restBetweenClimbsSeconds: 0,
          restBetweenRoundsSeconds: 180,
        },
      ],
    });
    const workout = await create(principal, input);
    const sessionId = await start(principal.userId, workout.id);
    const climbs = Array.from({ length: 4 }, () => randomUUID());
    const items = Array.from({ length: 16 }, (_, position) => ({
      queueItemUuid: randomUUID(),
      climbUuid: climbs[position % 4],
      angle: 40,
      position,
    }));
    const tickUuids: string[] = [];
    for (const item of items) tickUuids.push(await logTick(principal.userId, sessionId, item.climbUuid, new Date()));
    for (const uuid of tickUuids.slice(0, 2))
      await db.update(boardseshTicks).set({ status: 'attempt' }).where(eq(boardseshTicks.uuid, uuid));
    await db.insert(sessionWorkouts).values({
      sessionId,
      userId: principal.userId,
      revision: 1,
      plan: {
        version: 1,
        stages: [
          {
            id: `${workout.id}:0`,
            kind: 'fourByFour',
            items,
            pacing: {
              mode: 'afterTick',
              advanceOn: 'round',
              restSeconds: 0,
              roundCount: 4,
              climbsPerRound: 4,
              restBetweenRoundsSeconds: 180,
            },
          },
        ],
      },
      tickMap: tickUuids.map((tickUuid, index) => ({ tickUuid, queueItemUuid: items[index].queueItemUuid })),
    });
    await endSession(sessionId);
    const completed = (await read(principal, workout.id)).results;
    expect(completed?.blocks[0]).toMatchObject({
      externalRef: 'today-four',
      support: 'native',
      progress: { status: 'completed', completedRounds: 4, plannedRounds: 4, sends: 14, falls: 2 },
    });
    expect(completed?.ticks.find((tick) => tick.id === tickUuids[15])).toMatchObject({
      blockIndex: 0,
      position: { roundIndex: 3, climbIndex: 3 },
    });
    await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, tickUuids[15]));
    expect((await read(principal, workout.id)).results?.blocks[0].progress).toMatchObject({
      status: 'partial',
      completedRounds: 3,
      sends: 13,
      falls: 2,
    });
  });

  const minutes = (count: number) => count * 60_000;
  const twoVolumeBlocks = () =>
    CreateWorkoutSchema.parse({
      externalRef: randomUUID(),
      title: 'Two volume blocks',
      blocks: [
        { type: 'volume', climbCount: 2, targetGrade: { scale: 'v', value: 3 } },
        { type: 'volume', climbCount: 2, targetGrade: { scale: 'v', value: 4 } },
      ],
    });

  /** A workout added to a session that has run for an hour; the workout started 20 minutes ago. */
  async function addToRunningSession(principal: PartnerApiPrincipal, input = spec()) {
    const workout = await create(principal, input);
    const sessionId = await start(principal.userId, workout.id);
    const workoutStartedAt = new Date(Date.now() - minutes(20));
    await db.update(appWorkouts).set({ startedAt: workoutStartedAt }).where(eq(appWorkouts.id, workout.id));
    return { workout, sessionId, workoutStartedAt };
  }
  async function logTick(userId: string, sessionId: string, climbUuid: string, climbedAt: Date) {
    const uuid = randomUUID();
    await db.insert(boardseshTicks).values({
      uuid,
      userId,
      boardType: 'kilter',
      climbUuid,
      angle: 40,
      status: 'send',
      climbedAt: climbedAt.toISOString(),
      sessionId,
    });
    return uuid;
  }
  async function storeSessionWorkout(
    sessionId: string,
    userId: string,
    stages: Array<{ id: string; items: Array<{ queueItemUuid: string; climbUuid: string }> }>,
    tickMap: Array<{ tickUuid: string; queueItemUuid: string }> = [],
  ) {
    await db.insert(sessionWorkouts).values({
      sessionId,
      userId,
      plan: {
        version: 1,
        stages: stages.map((stage) => ({
          id: stage.id,
          kind: 'volume',
          items: stage.items.map((item) => ({ ...item, angle: 40 })),
        })),
      },
      tickMap,
      revision: 1,
    });
  }
  async function endSession(sessionId: string, endedAt = new Date()) {
    await db.transaction(async (tx) => {
      const transaction = tx as unknown as PartnerDatabase;
      const workouts = await lockSessionAppWorkouts(transaction, sessionId);
      await tx.update(boardSessions).set({ status: 'ended', endedAt }).where(eq(boardSessions.id, sessionId));
      await completeSessionAppWorkouts(transaction, workouts, 'completed', endedAt);
    });
  }
  const ticksById = (result: Awaited<ReturnType<typeof read>>) =>
    new Map((result.results?.ticks ?? []).map((tick) => [tick.id, tick.blockIndex]));

  it('leaves out the climbs from before "Add to this session"', async () => {
    const { principal } = await connected();
    const { workout, sessionId, workoutStartedAt } = await addToRunningSession(principal);
    const queuedClimb = randomUUID();
    await storeSessionWorkout(sessionId, principal.userId, [
      { id: `${workout.id}:0`, items: [{ queueItemUuid: randomUUID(), climbUuid: queuedClimb }] },
    ]);
    const beforeWorkout = await logTick(
      principal.userId,
      sessionId,
      randomUUID(),
      new Date(workoutStartedAt.getTime() - minutes(30)),
    );
    const duringWorkout = await logTick(
      principal.userId,
      sessionId,
      randomUUID(),
      new Date(workoutStartedAt.getTime() + minutes(5)),
    );
    await endSession(sessionId);
    const result = await read(principal, workout.id);
    expect(WorkoutResponseSchema.safeParse(result).success).toBe(true);
    const ticks = ticksById(result);
    expect(ticks.has(beforeWorkout)).toBe(false);
    expect(ticks.get(duringWorkout)).toBeNull();
    expect(ticks.size).toBe(1);
  });

  it('places repeated climbs on the blocks the tick map names, not by guessing from the climb', async () => {
    const { principal } = await connected();
    const { workout, sessionId, workoutStartedAt } = await addToRunningSession(principal, twoVolumeBlocks());
    const repeatedClimb = randomUUID();
    const sharedWithOwnBlock = randomUUID();
    const ownItem = randomUUID();
    const firstBlockItem = randomUUID();
    const secondBlockItem = randomUUID();
    await db
      .update(appWorkouts)
      .set({
        planSnapshot: [
          { index: 0, climbUuids: [repeatedClimb] },
          { index: 1, climbUuids: [repeatedClimb, sharedWithOwnBlock] },
        ],
      })
      .where(eq(appWorkouts.id, workout.id));
    const at = (offsetMinutes: number) => new Date(workoutStartedAt.getTime() + minutes(offsetMinutes));
    const onOwnBlock = await logTick(principal.userId, sessionId, sharedWithOwnBlock, at(1));
    // A phone clock a few seconds behind the server: the tick map still puts it on the block.
    const onFirstBlock = await logTick(principal.userId, sessionId, repeatedClimb, at(-0.1));
    const onSecondBlock = await logTick(principal.userId, sessionId, repeatedClimb, at(3));
    await storeSessionWorkout(
      sessionId,
      principal.userId,
      [
        { id: 'own-grade-focus', items: [{ queueItemUuid: ownItem, climbUuid: sharedWithOwnBlock }] },
        { id: `${workout.id}:0`, items: [{ queueItemUuid: firstBlockItem, climbUuid: repeatedClimb }] },
        {
          id: `${workout.id}:1`,
          items: [
            { queueItemUuid: secondBlockItem, climbUuid: repeatedClimb },
            { queueItemUuid: randomUUID(), climbUuid: sharedWithOwnBlock },
          ],
        },
      ],
      [
        { tickUuid: onOwnBlock, queueItemUuid: ownItem },
        { tickUuid: onFirstBlock, queueItemUuid: firstBlockItem },
        { tickUuid: onSecondBlock, queueItemUuid: secondBlockItem },
      ],
    );
    await endSession(sessionId);
    const ticks = ticksById(await read(principal, workout.id));
    expect(ticks.get(onOwnBlock)).toBeNull();
    expect(ticks.get(onFirstBlock)).toBe(0);
    expect(ticks.get(onSecondBlock)).toBe(1);
  });

  it('leaves out an earlier climb of a block climb that the tick map does not pin', async () => {
    const { principal } = await connected();
    const { workout, sessionId, workoutStartedAt } = await addToRunningSession(principal);
    const blockClimb = randomUUID();
    await storeSessionWorkout(sessionId, principal.userId, [
      { id: `${workout.id}:0`, items: [{ queueItemUuid: randomUUID(), climbUuid: blockClimb }] },
    ]);
    const beforeWorkout = await logTick(
      principal.userId,
      sessionId,
      blockClimb,
      new Date(workoutStartedAt.getTime() - minutes(15)),
    );
    const duringWorkout = await logTick(
      principal.userId,
      sessionId,
      blockClimb,
      new Date(workoutStartedAt.getTime() + minutes(4)),
    );
    await endSession(sessionId);
    const ticks = ticksById(await read(principal, workout.id));
    expect(ticks.has(beforeWorkout)).toBe(false);
    // With the earlier tick out of the derivation, the block's one slot goes to the workout's own tick.
    expect(ticks.get(duringWorkout)).toBe(0);
  });

  it('keeps every tick of a session the workout started itself, even from a phone clock running behind', async () => {
    const { principal } = await connected();
    const workout = await create(principal);
    const sessionId = await start(principal.userId, workout.id);
    const [session] = await db.select().from(boardSessions).where(eq(boardSessions.id, sessionId));
    // Start creates the session and attaches the workout in one transaction, a few ms apart.
    const workoutStartedAt = new Date(session.startedAt!.getTime() + 40);
    await db.update(appWorkouts).set({ startedAt: workoutStartedAt }).where(eq(appWorkouts.id, workout.id));
    await storeSessionWorkout(sessionId, principal.userId, [
      { id: `${workout.id}:0`, items: [{ queueItemUuid: randomUUID(), climbUuid: randomUUID() }] },
    ]);
    const behindClock = await logTick(
      principal.userId,
      sessionId,
      randomUUID(),
      new Date(workoutStartedAt.getTime() - 30_000),
    );
    await endSession(sessionId);
    const result = await read(principal, workout.id);
    expect(ticksById(result).get(behindClock)).toBeNull();
    expect(result.results?.session.startedAt).toBe(session.startedAt!.toISOString());
  });

  it('attributes a late tick by its kept tick-map entry once the tick lands', async () => {
    const { principal } = await connected();
    const { workout, sessionId, workoutStartedAt } = await addToRunningSession(principal, twoVolumeBlocks());
    const repeatedClimb = randomUUID();
    const secondBlockItem = randomUUID();
    const lateTick = randomUUID();
    await db
      .update(appWorkouts)
      .set({
        planSnapshot: [
          { index: 0, climbUuids: [repeatedClimb] },
          { index: 1, climbUuids: [repeatedClimb] },
        ],
      })
      .where(eq(appWorkouts.id, workout.id));
    await storeSessionWorkout(
      sessionId,
      principal.userId,
      [
        { id: `${workout.id}:0`, items: [{ queueItemUuid: randomUUID(), climbUuid: repeatedClimb }] },
        { id: `${workout.id}:1`, items: [{ queueItemUuid: secondBlockItem, climbUuid: repeatedClimb }] },
      ],
      [{ tickUuid: lateTick, queueItemUuid: secondBlockItem }],
    );
    await endSession(sessionId);
    expect((await read(principal, workout.id)).results?.ticks).toEqual([]);
    await db.insert(boardseshTicks).values({
      uuid: lateTick,
      userId: principal.userId,
      boardType: 'kilter',
      climbUuid: repeatedClimb,
      angle: 40,
      status: 'send',
      climbedAt: new Date(workoutStartedAt.getTime() + minutes(10)).toISOString(),
      sessionId,
    });
    // By climb alone it would fill block 0 first; the map says block 1.
    expect(ticksById(await read(principal, workout.id)).get(lateTick)).toBe(1);
  });

  it('times the session from the workout start, not the session start', async () => {
    const { principal } = await connected();
    const { workout, sessionId, workoutStartedAt } = await addToRunningSession(principal);
    await endSession(sessionId, new Date(workoutStartedAt.getTime() + minutes(10)));
    const session = (await read(principal, workout.id)).results?.session;
    expect(session?.startedAt).toBe(workoutStartedAt.toISOString());
    expect(session?.durationSeconds).toBe(600);
  });

  it('falls back to the plan snapshot without a stored plan and still leaves out earlier climbs', async () => {
    const { principal } = await connected();
    const { workout, sessionId, workoutStartedAt } = await addToRunningSession(principal);
    const queuedClimb = randomUUID();
    await db
      .update(appWorkouts)
      .set({
        planSnapshot: [
          { index: 0, climbUuids: [queuedClimb] },
          { index: 1, climbUuids: [] },
        ],
      })
      .where(eq(appWorkouts.id, workout.id));
    const beforeWorkout = await logTick(
      principal.userId,
      sessionId,
      queuedClimb,
      new Date(workoutStartedAt.getTime() - minutes(10)),
    );
    const duringWorkout = await logTick(
      principal.userId,
      sessionId,
      queuedClimb,
      new Date(workoutStartedAt.getTime() + minutes(2)),
    );
    await endSession(sessionId);
    const ticks = ticksById(await read(principal, workout.id));
    expect(ticks.has(beforeWorkout)).toBe(false);
    expect(ticks.get(duringWorkout)).toBe(0);
  });
});

describe('workout contract boundaries', () => {
  it('clamps lifetime to seven days or two UTC days after the scheduled date and rejects impossible blocks', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    expect(workoutExpiresAt(spec(), now).toISOString()).toBe('2026-11-24T12:00:00.000Z');
    expect(workoutExpiresAt({ ...spec(), scheduledFor: '2026-12-01' }, now).toISOString()).toBe(
      '2026-12-03T00:00:00.000Z',
    );
    expect(
      CreateWorkoutSchema.safeParse({
        ...spec(),
        blocks: [{ type: 'volume', climbCount: 41, targetGrade: { scale: 'v', value: 3 } }],
      }).success,
    ).toBe(false);
    expect(inferWorkoutBlockIndex('a', [{ index: 1, climbUuids: ['a', 'a'] }])).toBe(1);
    expect(
      inferWorkoutBlockIndex('a', [
        { index: 0, climbUuids: ['a'] },
        { index: 1, climbUuids: ['a'] },
      ]),
    ).toBeNull();
  });
});
