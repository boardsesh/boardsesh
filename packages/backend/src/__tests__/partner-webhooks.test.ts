import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { oauthAccessToken, oauthConnections, users } from '@boardsesh/db/schema/auth';
import {
  appWorkouts,
  boardSessions,
  boardseshTicks,
  oauthClientWebhooks,
  partnerWebhookDebounce,
  partnerWebhookFeedState,
  partnerWebhookOutbox,
  partnerWorkoutResultDebounce,
  webhookDeliveries,
} from '@boardsesh/db/schema/app';
import { db } from '../db/client';
import { createApp, createUser, attachPartnerState } from '../auth/partner/__tests__/revocation-fixtures';
import { encryptWebhookSecret } from '../services/partner-webhooks/crypto';
import { enqueuePartnerWebhookEvent } from '../services/partner-webhooks/events';
import {
  deliverPartnerWebhook,
  disableFailingPartnerWebhooks,
  prunePartnerWebhookHistory,
  reconcilePartnerWebhookJobs,
  relayPartnerWebhookEvents,
  startPartnerWebhooks,
  webhookResponseAction,
} from '../services/partner-webhooks/worker';
import { rotateOwnedWebhookSecret, updateOwnedWebhook } from '../services/partner-webhooks/settings';
import type { PartnerDatabase } from '../auth/partner/tables';
import { produceLogbookWebhookEvents } from '../services/partner-webhooks/logbook';
import { readLogbookFeedState } from '../services/logbook-feed';
import { completeSessionAppWorkouts } from '../services/public-api/workout-lifecycle';
import { buildWorkoutResults } from '../services/public-api/workout-results';
import { markSessionWorkoutResultsChanged } from '../services/partner-webhooks/workout-results-changed';
import type { PgBoss } from 'pg-boss';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { sessionWorkoutMutations } from '../graphql/resolvers/sessions/session-workouts';

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

const RESOURCE = 'https://api.boardsesh.com/v1';
async function fixture() {
  const owner = await createUser('webhook-owner');
  const climber = await createUser('webhook-climber');
  const clientId = await createApp(owner);
  const connection = await attachPartnerState(climber, clientId);
  await db
    .update(oauthAccessToken)
    .set({ scopes: ['logbook:read', 'workouts:read'], resources: [RESOURCE] })
    .where(eq(oauthAccessToken.id, connection.accessTokenId));
  await db.insert(oauthClientWebhooks).values({
    clientId,
    url: 'https://hooks.example.com/events',
    events: ['logbook.changed', 'workout.completed', 'connection.revoked'],
    secret: encryptWebhookSecret('signing-secret'),
  });
  return { owner, climber, ...connection };
}
async function pendingDelivery(
  state: Awaited<ReturnType<typeof fixture>>,
  event = 'logbook.changed',
  endpointVersion = 1,
) {
  const id = randomUUID();
  await db.insert(webhookDeliveries).values({
    id,
    eventId: randomUUID(),
    clientId: state.clientId,
    connectionId: state.connectionId,
    connectionGeneration: 0,
    endpointVersion,
    event,
    rawBody: JSON.stringify({ id: `evt_${randomUUID()}`, type: event, user: 'usr_test' }),
  });
  return id;
}

describe('durable partner webhook lifecycle', () => {
  beforeEach(async () => {
    vi.stubEnv('PARTNER_OAUTH_SECRETS', '1:partner-webhooks-test-secret-with-more-than-32-bytes');
    await db.delete(partnerWebhookOutbox);
    await db.delete(webhookDeliveries);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [204, 'delivered'],
    [410, 'disable'],
    [408, 'retry'],
    [429, 'retry'],
    [503, 'retry'],
    [401, 'failed'],
    [302, 'failed'],
  ] as const)('classifies HTTP %s', (status, action) => expect(webhookResponseAction(status)).toBe(action));

  it('sends stable bytes and delivery ids across transient retries', async () => {
    const state = await fixture();
    const id = await pendingDelivery(state);
    const send = vi.fn().mockResolvedValueOnce(503).mockResolvedValue(204);
    await expect(deliverPartnerWebhook(id, db, send)).rejects.toThrow('retry');
    await deliverPartnerWebhook(id, db, send);
    expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
    expect(send.mock.calls[0][2]['Boardsesh-Delivery-Id']).toBe(id);
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 2, lastStatusCode: 204 });
  });
  it('suppresses retired generations and preserves their advisory revocation after reconnect', async () => {
    const state = await fixture();
    const ordinary = await pendingDelivery(state);
    const revoked = await pendingDelivery(state, 'connection.revoked');
    await db
      .update(oauthConnections)
      .set({ generation: 1, revokedAt: new Date() })
      .where(eq(oauthConnections.id, state.connectionId));
    await db.update(oauthConnections).set({ revokedAt: null }).where(eq(oauthConnections.id, state.connectionId));
    const send = vi.fn().mockResolvedValue(204);
    await deliverPartnerWebhook(ordinary, db, send);
    await deliverPartnerWebhook(revoked, db, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]['Boardsesh-Event']).toBe('connection.revoked');
  });
  it('atomically revokes workouts and records password-reset events, including rollback', async () => {
    const state = await fixture();
    const workoutId = `wk_${randomUUID()}`;
    await db.insert(appWorkouts).values({
      id: workoutId,
      clientId: state.clientId,
      userId: state.climber,
      connectionId: state.connectionId,
      connectionGeneration: 0,
      externalRef: workoutId,
      title: 'Private plan',
      spec: {},
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`select public.partner_revoke_user(${state.climber})`);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    let [workout] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workoutId));
    expect(workout.status).toBe('created');
    await db.execute(sql`select public.partner_revoke_user(${state.climber})`);
    [workout] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, workoutId));
    expect(workout.status).toBe('revoked');
    const [event] = await db
      .select()
      .from(partnerWebhookOutbox)
      .where(eq(partnerWebhookOutbox.connectionId, state.connectionId));
    expect(event).toMatchObject({ type: 'connection.revoked', endpointVersion: 1, connectionGeneration: 0 });
    expect(event).not.toHaveProperty('spec');
  });
  it('keeps revocation after deleting the climber without retaining their account id', async () => {
    const state = await fixture();
    await db.delete(users).where(eq(users.id, state.climber));
    const [event] = await db
      .select()
      .from(partnerWebhookOutbox)
      .where(eq(partnerWebhookOutbox.connectionId, state.connectionId));
    expect(event.type).toBe('connection.revoked');
    expect(event.subject).toMatch(/^usr_/);
    expect(JSON.stringify(event)).not.toContain(state.climber);
  });
  it('does not let a stale 410 response disable a newer endpoint or cancel its jobs', async () => {
    const state = await fixture();
    const oldId = await pendingDelivery(state);
    let newId = '';
    await deliverPartnerWebhook(oldId, db, async () => {
      await db
        .update(oauthClientWebhooks)
        .set({ version: 2, url: 'https://new.example.com/events' })
        .where(eq(oauthClientWebhooks.clientId, state.clientId));
      newId = await pendingDelivery(state, 'logbook.changed', 2);
      return 410;
    });
    const [settings] = await db
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, newId));
    expect(settings.enabled).toBe(true);
    expect(delivery.status).toBe('pending');
  });
  it('does not blame the endpoint for a missing local signing key', async () => {
    const state = await fixture();
    const id = await pendingDelivery(state);
    vi.stubEnv('PARTNER_OAUTH_SECRETS', '2:different-key-with-at-least-thirty-two-bytes');
    const send = vi.fn();
    await expect(deliverPartnerWebhook(id, db, send)).rejects.toThrow('signing unavailable');
    const [settings] = await db
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    expect(settings.failingSince).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it('settles the tenth signing failure without blaming the partner, then lets its owner recover', async () => {
    const state = await fixture();
    const id = await pendingDelivery(state);
    await db.update(webhookDeliveries).set({ attempts: 9 }).where(eq(webhookDeliveries.id, id));
    await db
      .update(oauthClientWebhooks)
      .set({ previousSecretExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    vi.stubEnv('PARTNER_OAUTH_SECRETS', '2:different-key-with-at-least-thirty-two-bytes');
    const send = vi.fn().mockResolvedValue(204);
    await deliverPartnerWebhook(id, db, send);
    const [failed] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(failed).toMatchObject({
      attempts: 10,
      status: 'failed',
      lastError: 'signing_unavailable',
      settledAt: expect.any(Date),
    });
    await rotateOwnedWebhookSecret(db as unknown as PartnerDatabase, state.owner, state.clientId, {
      authenticatedAtMs: Date.now(),
      linkGuarded: true,
    });
    await deliverPartnerWebhook(await pendingDelivery(state), db, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('reseals a readable current key and signs when the overlap key is unavailable', async () => {
    const state = await fixture();
    await db
      .update(oauthClientWebhooks)
      .set({ previousSecret: 'unavailable', previousSecretExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    vi.stubEnv(
      'PARTNER_OAUTH_SECRETS',
      '2:different-key-with-at-least-thirty-two-bytes,1:partner-webhooks-test-secret-with-more-than-32-bytes',
    );
    const send = vi.fn().mockResolvedValue(204);
    await deliverPartnerWebhook(await pendingDelivery(state), db, send);
    expect(send.mock.calls[0][2]['Boardsesh-Signature'].split(',')).toHaveLength(2);
    const [config] = await db
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    expect(config.secret).toMatch(/^wh1\.2\./);
  });
  it('preserves all 24 hours of the previous secret and rejects repeated rotation', async () => {
    const state = await fixture();
    const database = db as unknown as PartnerDatabase;
    const proof = { authenticatedAtMs: Date.now(), linkGuarded: true };
    const first = await rotateOwnedWebhookSecret(database, state.owner, state.clientId, proof);
    expect(first.secret).toBeTruthy();
    await expect(rotateOwnedWebhookSecret(database, state.owner, state.clientId, proof)).rejects.toThrow(
      'Rotate again after',
    );
    const [settings] = await db
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    expect(settings.previousSecretExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
  it('keeps queued events when Save is a semantic no-op', async () => {
    const state = await fixture();
    await db
      .update(oauthClientWebhooks)
      .set({ url: 'https://8.8.8.8/events' })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    const id = await pendingDelivery(state);
    const result = await updateOwnedWebhook(
      db as unknown as PartnerDatabase,
      state.owner,
      {
        clientId: state.clientId,
        url: 'https://8.8.8.8/events',
        enabled: true,
        events: ['connection.revoked', 'workout.completed', 'logbook.changed'],
      },
      { authenticatedAtMs: Date.now(), linkGuarded: true },
    );
    expect(result.secret).toBeNull();
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    const [settings] = await db
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    expect(delivery.status).toBe('pending');
    expect(settings.version).toBe(1);
  });
  it('lets the owner disable an unreachable endpoint without DNS', async () => {
    const state = await fixture();
    await db
      .update(oauthClientWebhooks)
      .set({ url: 'https://unreachable.example.invalid/hook' })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    const result = await updateOwnedWebhook(
      db as unknown as PartnerDatabase,
      state.owner,
      {
        clientId: state.clientId,
        url: 'https://unreachable.example.invalid/hook',
        enabled: false,
        events: ['logbook.changed', 'workout.completed', 'connection.revoked'],
      },
      { authenticatedAtMs: Date.now(), linkGuarded: true },
    );
    expect(result.settings.enabled).toBe(false);
  });
  it.each(['off', 'hold'])('does not claim jobs in %s mode', async (mode) => {
    vi.stubEnv('PARTNER_OAUTH_MODE', mode);
    const work = vi.fn();
    await startPartnerWebhooks({ work, schedule: vi.fn() } as unknown as PgBoss);
    expect(work).not.toHaveBeenCalled();
  });
  it('derives logbook permission from live credentials, not the empty connection scope cache', async () => {
    const state = await fixture();
    await db.delete(partnerWebhookFeedState);
    await db.delete(partnerWebhookDebounce);
    await produceLogbookWebhookEvents();
    const events = await db
      .select()
      .from(partnerWebhookOutbox)
      .where(and(eq(partnerWebhookOutbox.clientId, state.clientId), eq(partnerWebhookOutbox.type, 'logbook.changed')));
    expect(events).toHaveLength(1);
    await produceLogbookWebhookEvents();
    const again = await db
      .select()
      .from(partnerWebhookOutbox)
      .where(and(eq(partnerWebhookOutbox.clientId, state.clientId), eq(partnerWebhookOutbox.type, 'logbook.changed')));
    expect(again).toHaveLength(1);
    await db.update(oauthAccessToken).set({ revoked: new Date() }).where(eq(oauthAccessToken.id, state.accessTokenId));
    const id = await pendingDelivery(state);
    const send = vi.fn();
    await deliverPartnerWebhook(id, db, send);
    expect(send).not.toHaveBeenCalled();
  });
  it('reaches the next climber after a 3,000-change import in one producer invocation', async () => {
    const first = await fixture();
    const second = await fixture();
    await db.delete(partnerWebhookFeedState);
    await produceLogbookWebhookEvents();
    await db.delete(partnerWebhookDebounce);
    await db.delete(partnerWebhookOutbox);
    await db.execute(
      sql`insert into logbook_changes (user_id, tick_uuid) select ${first.climber}, tick::text from generate_series(1,3000) tick`,
    );
    const [secondChange] = await db.execute<{ txid: string }>(
      sql`insert into logbook_changes (user_id, tick_uuid) values (${second.climber}, 'next-tick') returning txid::text as txid`,
    );
    // Other workers can hold PostgreSQL's cluster-wide horizon below these committed changes.
    const deadline = Date.now() + 5000;
    for (;;) {
      const { horizon } = await db.transaction(readLogbookFeedState);
      if (BigInt(horizon) > BigInt(secondChange.txid)) break;
      if (Date.now() >= deadline)
        throw new Error(`Logbook horizon ${horizon} did not pass inserted change ${secondChange.txid}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await produceLogbookWebhookEvents();
    const events = await db.select().from(partnerWebhookOutbox);
    expect(events.map((event) => event.clientId).sort()).toEqual([first.clientId, second.clientId].sort());
  });

  it('relays queued jobs even when the producer cursor cannot be read', async () => {
    const state = await fixture();
    await db.delete(partnerWebhookFeedState);
    await produceLogbookWebhookEvents();
    await db.update(partnerWebhookFeedState).set({ txid: 'unreadable' });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
    const work = vi.fn();
    const insert = vi.fn();
    await startPartnerWebhooks({ work, insert, schedule: vi.fn() } as unknown as PgBoss);
    const maintain = work.mock.calls[0][1] as () => Promise<void>;
    try {
      await expect(maintain()).rejects.toThrow('Partner webhook maintenance failed');
      expect(insert).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ group: { id: state.clientId } })]),
        expect.anything(),
      );
    } finally {
      await db.delete(partnerWebhookFeedState);
    }
  });
  it('discards pre-edit outbox events and keeps enqueue rollback atomic', async () => {
    const state = await fixture();
    await db.transaction((transaction) =>
      enqueuePartnerWebhookEvent(transaction, {
        clientId: state.clientId,
        connectionId: state.connectionId,
        connectionGeneration: 0,
        type: 'logbook.changed',
      }),
    );
    await db.update(oauthClientWebhooks).set({ version: 2 }).where(eq(oauthClientWebhooks.clientId, state.clientId));
    const insert = vi.fn();
    await relayPartnerWebhookEvents({ insert } as unknown as PgBoss);
    expect(insert).not.toHaveBeenCalled();
    const count = (
      await db.select().from(partnerWebhookOutbox).where(eq(partnerWebhookOutbox.clientId, state.clientId))
    ).length;
    await expect(
      db.transaction(async (transaction) => {
        await enqueuePartnerWebhookEvent(transaction, {
          clientId: state.clientId,
          connectionId: state.connectionId,
          connectionGeneration: 0,
          type: 'logbook.changed',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect(
      (await db.select().from(partnerWebhookOutbox).where(eq(partnerWebhookOutbox.clientId, state.clientId))).length,
    ).toBe(count);
  });
  it('replaces an exhausted queue job with the same id, partner group and capped backoff', async () => {
    const state = await fixture();
    const id = await pendingDelivery(state);
    await db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 120_000), attempts: 5 })
      .where(eq(webhookDeliveries.id, id));
    const boss = {
      getJobById: vi.fn().mockResolvedValue({ state: 'failed', data: {}, retryCount: 9 }),
      deleteJob: vi.fn(),
      send: vi.fn(),
    };
    await reconcilePartnerWebhookJobs(boss as unknown as PgBoss);
    expect(boss.deleteJob).toHaveBeenCalledOnce();
    expect(boss.send).toHaveBeenCalledWith(
      expect.any(String),
      { deliveryId: id, recoveryAttempt: 10 },
      expect.objectContaining({
        id,
        group: { id: state.clientId },
        startAfter: 32_000,
        retryLimit: 0,
      }),
    );
  });

  it('disables after three failing days and prunes only terminal history', async () => {
    const state = await fixture();
    await db
      .update(oauthClientWebhooks)
      .set({ failingSince: new Date(Date.now() - 4 * 86_400_000) })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    const notify = vi.fn().mockResolvedValue(undefined);
    await disableFailingPartnerWebhooks(db, notify);
    expect(notify).not.toHaveBeenCalled();
    await db
      .update(oauthClientWebhooks)
      .set({ lastFailureAt: new Date() })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    await disableFailingPartnerWebhooks(db, notify);
    expect(notify).toHaveBeenCalled();
    const pending = await pendingDelivery(state);
    const terminal = await pendingDelivery(state);
    await db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(inArrayIds([pending, terminal]));
    await db
      .update(webhookDeliveries)
      .set({ status: 'failed', settledAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(webhookDeliveries.id, terminal));
    await prunePartnerWebhookHistory();
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, pending))).toHaveLength(1);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, terminal))).toHaveLength(0);
  });
});

/** Waits until the feed horizon passes every committed change, as the producer requires. */
async function waitForCommittedChanges() {
  const [latest] = await db.execute<{ txid: string }>(
    sql`select txid::text as txid from logbook_changes order by seq desc limit 1`,
  );
  // Other workers can hold PostgreSQL's cluster-wide horizon below these committed changes.
  const deadline = Date.now() + 5000;
  while (latest) {
    const { horizon } = await db.transaction(readLogbookFeedState);
    if (BigInt(horizon) > BigInt(latest.txid)) break;
    if (Date.now() >= deadline) throw new Error(`Logbook horizon ${horizon} did not pass change ${latest.txid}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function produceAfterCommittedChanges() {
  await waitForCommittedChanges();
  await produceLogbookWebhookEvents();
}

describe('workout.completed after results change', () => {
  beforeEach(async () => {
    vi.stubEnv('PARTNER_OAUTH_SECRETS', '1:partner-webhooks-test-secret-with-more-than-32-bytes');
    // Start the shared cursor at the current horizon so earlier tests' changes stay behind it.
    await db.delete(partnerWebhookFeedState);
    await produceLogbookWebhookEvents();
  });
  afterEach(() => vi.unstubAllEnvs());

  /** A workouts-only app (Sequence's shape) whose climber pressed End two minutes ago. */
  async function finishedWorkout(options: { endedMsAgo?: number } = {}) {
    const state = await fixture();
    await db
      .update(oauthClientWebhooks)
      .set({ events: ['workout.completed'] })
      .where(eq(oauthClientWebhooks.clientId, state.clientId));
    const sessionId = randomUUID();
    const endedAt = new Date(Date.now() - (options.endedMsAgo ?? 120_000));
    await db.insert(boardSessions).values({
      id: sessionId,
      boardPath: 'kilter/1/1/1/40',
      createdByUserId: state.climber,
      startedAt: new Date(endedAt.getTime() - 3_600_000),
    });
    const workoutId = `wk_${randomUUID()}`;
    const [workout] = await db
      .insert(appWorkouts)
      .values({
        id: workoutId,
        clientId: state.clientId,
        userId: state.climber,
        connectionId: state.connectionId,
        connectionGeneration: 0,
        externalRef: workoutId,
        title: 'Volume',
        spec: {
          externalRef: workoutId,
          title: 'Volume',
          blocks: [{ type: 'volume', climbCount: 4, targetGrade: { scale: 'v', value: 3 } }],
        },
        status: 'started',
        sessionId,
        startedAt: new Date(endedAt.getTime() - 3_600_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    return { ...state, sessionId, workoutId, workout, endedAt };
  }
  async function end(finished: Awaited<ReturnType<typeof finishedWorkout>>, sendEndEvent = true) {
    await db.transaction(async (transaction) => {
      await transaction
        .update(boardSessions)
        .set({ status: 'ended', endedAt: finished.endedAt })
        .where(eq(boardSessions.id, finished.sessionId));
      await completeSessionAppWorkouts(
        transaction as unknown as PartnerDatabase,
        [finished.workout],
        'completed',
        finished.endedAt,
      );
    });
    // The maintenance relay has handed End's event to the delivery queue, so the app has read.
    if (sendEndEvent)
      await db
        .update(partnerWebhookOutbox)
        .set({ relayedAt: new Date() })
        .where(eq(partnerWebhookOutbox.workoutId, finished.workoutId));
  }
  async function logTick(userId: string, sessionId: string | null) {
    const uuid = randomUUID();
    await db.insert(boardseshTicks).values({
      uuid,
      userId,
      boardType: 'kilter',
      climbUuid: randomUUID(),
      angle: 40,
      status: 'send',
      climbedAt: new Date().toISOString(),
      sessionId,
    });
    return uuid;
  }
  const completionEvents = (workoutId: string) =>
    db
      .select()
      .from(partnerWebhookOutbox)
      .where(and(eq(partnerWebhookOutbox.workoutId, workoutId), eq(partnerWebhookOutbox.type, 'workout.completed')))
      .orderBy(partnerWebhookOutbox.occurredAt);
  const sendQueued = (workoutId: string) =>
    db.update(partnerWebhookOutbox).set({ relayedAt: new Date() }).where(eq(partnerWebhookOutbox.workoutId, workoutId));
  const ageLastSend = (workoutId: string) =>
    db
      .update(partnerWorkoutResultDebounce)
      .set({ lastEnqueuedAt: new Date(Date.now() - 61_000) })
      .where(eq(partnerWorkoutResultDebounce.workoutId, workoutId));

  it('sends workout.completed again, with a new event id, when a tick lands after End', async () => {
    const finished = await finishedWorkout();
    await end(finished);
    const late = await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    const events = await completionEvents(finished.workoutId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ workoutId: finished.workoutId, relayedAt: null, connectionGeneration: 0 });
    expect(events[1].id).not.toBe(events[0].id);
    const [workout] = await db.select().from(appWorkouts).where(eq(appWorkouts.id, finished.workoutId));
    const results = await buildWorkoutResults(db as unknown as PartnerDatabase, workout);
    expect(results?.ticks.map((tick) => tick.id)).toEqual([late]);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(2);
  });
  it('sends once for several ticks inside a minute, then again for the trailing one', async () => {
    const finished = await finishedWorkout();
    await end(finished);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    await sendQueued(finished.workoutId);
    await logTick(finished.climber, finished.sessionId);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(2);
    const [debounce] = await db
      .select()
      .from(partnerWorkoutResultDebounce)
      .where(eq(partnerWorkoutResultDebounce.workoutId, finished.workoutId));
    expect(debounce.pending).toBe(true);
    await ageLastSend(finished.workoutId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(3);
  });
  it("adds nothing for a tick saved before End's own event is sent", async () => {
    const finished = await finishedWorkout();
    await end(finished, false);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(1);
    // Nothing is held back for later either: End's event already covers the tick.
    expect(
      await db
        .select()
        .from(partnerWorkoutResultDebounce)
        .where(eq(partnerWorkoutResultDebounce.workoutId, finished.workoutId)),
    ).toHaveLength(0);
  });
  it('stays quiet once End is more than seven days old', async () => {
    const finished = await finishedWorkout({ endedMsAgo: 8 * 86_400_000 });
    await end(finished);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(1);
  });
  it("ignores another climber's tick in the same session and the climber's tick elsewhere", async () => {
    const finished = await finishedWorkout();
    await end(finished);
    const crewmate = await createUser('webhook-crewmate');
    await logTick(crewmate, finished.sessionId);
    await logTick(finished.climber, null);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(1);
  });
  it('sends again when a tick in the results is edited, and again when it is deleted', async () => {
    const finished = await finishedWorkout();
    const tick = await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    await end(finished);
    await db.update(boardseshTicks).set({ comment: 'Edited after End' }).where(eq(boardseshTicks.uuid, tick));
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(2);
    await sendQueued(finished.workoutId);
    await ageLastSend(finished.workoutId);
    await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, tick));
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(3);
  });
  it("sends again when the climber's tick map places a tick on a block after End", async () => {
    const finished = await finishedWorkout();
    const tick = await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    await end(finished);
    // A tick-map write changes no tick, so it adds no logbook_changes row.
    await sessionWorkoutMutations.recordSessionWorkout(
      null,
      {
        input: {
          sessionId: finished.sessionId,
          revision: 1,
          stages: [
            {
              id: `${finished.workoutId}:0`,
              kind: 'volume',
              items: [{ queueItemUuid: 'qi-late', climbUuid: randomUUID(), angle: 40 }],
            },
          ],
          ticks: [{ tickUuid: tick, queueItemUuid: 'qi-late' }],
        },
      },
      {
        connectionId: `webhooks-${randomUUID()}`,
        isAuthenticated: true,
        userId: finished.climber,
      } as ConnectionContext,
    );
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(2);
  });
  it('never deadlocks a tick-map write that holds the workout row against the producer', async () => {
    const finished = await finishedWorkout();
    await end(finished);
    await logTick(finished.climber, finished.sessionId);
    await waitForCommittedChanges();
    // recordSessionWorkout's order: the workout row FOR UPDATE (recoverAppWorkoutPlan), then the debounce row.
    let workoutLocked!: () => void;
    let producerWaiting!: () => void;
    const locked = new Promise<void>((resolve) => (workoutLocked = resolve));
    const waiting = new Promise<void>((resolve) => (producerWaiting = resolve));
    const tickMapWrite = db.transaction(async (transaction) => {
      await transaction
        .select({ id: appWorkouts.id })
        .from(appWorkouts)
        .where(eq(appWorkouts.id, finished.workoutId))
        .for('update');
      workoutLocked();
      await waiting;
      await markSessionWorkoutResultsChanged(transaction, finished.sessionId, finished.climber);
    });
    await locked;
    const producer = produceLogbookWebhookEvents();
    const deadline = Date.now() + 5000;
    for (;;) {
      const [blocked] = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      );
      if (blocked.count > 0) break;
      if (Date.now() >= deadline) throw new Error('The producer never waited on the workout row');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    producerWaiting();
    const [write, produce] = await Promise.allSettled([tickMapWrite, producer]);
    const sqlState = (outcome: PromiseSettledResult<unknown>) => {
      if (outcome.status === 'fulfilled') return null;
      const error = outcome.reason as { code?: string; cause?: { code?: string } };
      return error.code ?? error.cause?.code ?? String(outcome.reason);
    };
    // The climber's write always wins. The producer may lose its repeatable-read
    // snapshot to the row the write inserted (40001); its next run retries.
    expect(sqlState(write)).toBeNull();
    expect([null, '40001']).toContain(sqlState(produce));
  });
  it('keeps a minute between sends when prune clears a settled row and a change recreates it', async () => {
    const finished = await finishedWorkout();
    await end(finished);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    await sendQueued(finished.workoutId);
    const debounceRows = () =>
      db
        .select()
        .from(partnerWorkoutResultDebounce)
        .where(eq(partnerWorkoutResultDebounce.workoutId, finished.workoutId));
    // A settled row is kept for its minute.
    await prunePartnerWebhookHistory();
    expect(await debounceRows()).toHaveLength(1);
    // After the minute prune removes it, and the next change sends at once.
    await ageLastSend(finished.workoutId);
    await prunePartnerWebhookHistory();
    expect(await debounceRows()).toHaveLength(0);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(3);
    // The recreated row spaces the one after it again.
    await sendQueued(finished.workoutId);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(3);
    expect((await debounceRows())[0].pending).toBe(true);
  });
  it.each([
    ['without a workout.completed subscription', true, 'connection.revoked'],
    ['with webhooks switched off', false, 'workout.completed'],
  ])('sends nothing, as before, to an app %s', async (_label, enabled, event) => {
    const finished = await finishedWorkout();
    await db
      .update(oauthClientWebhooks)
      .set({ enabled, events: [event] })
      .where(eq(oauthClientWebhooks.clientId, finished.clientId));
    await end(finished);
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(partnerWorkoutResultDebounce)
        .where(eq(partnerWorkoutResultDebounce.workoutId, finished.workoutId)),
    ).toHaveLength(0);
  });
  it('sends nothing after the climber disconnects the app', async () => {
    const finished = await finishedWorkout();
    await end(finished);
    await db
      .update(oauthConnections)
      .set({ revokedAt: new Date() })
      .where(eq(oauthConnections.id, finished.connectionId));
    await logTick(finished.climber, finished.sessionId);
    await produceAfterCommittedChanges();
    expect(await completionEvents(finished.workoutId)).toHaveLength(1);
  });
});

const inArrayIds = (ids: string[]) =>
  sql`${webhookDeliveries.id} in (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
