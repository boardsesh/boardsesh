import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { oauthAppPolicy, oauthClient, oauthConnections, users } from '@boardsesh/db/schema/auth';
import {
  oauthClientWebhooks,
  partnerWebhookDebounce,
  partnerWebhookOutbox,
  webhookDeliveries,
} from '@boardsesh/db/schema/app';
import { PARTNER_WEBHOOK_DELIVERY_QUEUE, PARTNER_WEBHOOK_MAINTENANCE_QUEUE } from '@boardsesh/db/job-queue-schema';
import { db, type Database } from '../../db/client';
import { enqueueOn } from '../job-queue';
import { readPartnerOAuthMode } from '../../auth/partner/mode';
import { logger } from '../../utils/logger';
import { decryptWebhookSecret, webhookSignature } from './crypto';
import { postWebhook, UnsafeWebhookUrlError } from './transport';
import { produceLogbookWebhookEvents } from './logbook';
import { sendPartnerWebhookDisabledEmail } from '../../email/partner-webhooks';
import { reportPartnerFeedHealth } from './feed-health';
import { liveWebhookScopeCondition } from './authorization';

export const PARTNER_WEBHOOK_JOB_OPTIONS = {
  retryLimit: 9,
  retryDelay: 120,
  retryBackoff: true,
  retryDelayMax: 32_000,
  expireInSeconds: 30,
} as const;

export async function relayPartnerWebhookEvents(boss: PgBoss, database: Database = db): Promise<number> {
  return database.transaction(async (transaction) => {
    const pending = await transaction
      .select()
      .from(partnerWebhookOutbox)
      .where(isNull(partnerWebhookOutbox.relayedAt))
      .orderBy(asc(partnerWebhookOutbox.occurredAt), asc(partnerWebhookOutbox.id))
      .limit(100)
      .for('update', { skipLocked: true });
    for (const event of pending) {
      const [settings] = await transaction
        .select()
        .from(oauthClientWebhooks)
        .where(eq(oauthClientWebhooks.clientId, event.clientId));
      if (
        settings?.enabled &&
        settings.version === event.endpointVersion &&
        (event.type === 'webhook.test' || settings.events.includes(event.type))
      ) {
        const deliveryId = randomUUID();
        const [created] = await transaction
          .insert(webhookDeliveries)
          .values({
            id: deliveryId,
            eventId: event.id,
            clientId: event.clientId,
            connectionId: event.connectionId,
            connectionGeneration: event.connectionGeneration,
            endpointVersion: settings.version,
            event: event.type,
            rawBody: JSON.stringify({
              id: `evt_${event.id}`,
              type: event.type,
              occurredAt: event.occurredAt.toISOString(),
              user: event.subject,
              ...(event.workoutId ? { workoutId: event.workoutId } : {}),
            }),
          })
          .onConflictDoNothing()
          .returning({ id: webhookDeliveries.id });
        if (created)
          await boss.send(
            PARTNER_WEBHOOK_DELIVERY_QUEUE,
            { deliveryId },
            {
              ...PARTNER_WEBHOOK_JOB_OPTIONS,
              id: deliveryId,
              singletonKey: deliveryId,
              db: enqueueOn(transaction),
            },
          );
      }
      await transaction
        .update(partnerWebhookOutbox)
        .set({ relayedAt: new Date() })
        .where(eq(partnerWebhookOutbox.id, event.id));
    }
    return pending.length;
  });
}

export function webhookResponseAction(status: number): 'delivered' | 'disable' | 'retry' | 'failed' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 410) return 'disable';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}

/** Each retry uses the same raw bytes and delivery id, but a fresh signing timestamp. */
export async function deliverPartnerWebhook(
  deliveryId: string,
  database: Database = db,
  send: typeof postWebhook = postWebhook,
): Promise<void> {
  const [delivery] = await database.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  if (!delivery || !['pending', 'retrying'].includes(delivery.status)) return;
  const [settings] = await database
    .select({ settings: oauthClientWebhooks, disabled: oauthClient.disabled, suspendedAt: oauthAppPolicy.suspendedAt })
    .from(oauthClientWebhooks)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthClientWebhooks.clientId))
    .innerJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthClientWebhooks.clientId))
    .where(eq(oauthClientWebhooks.clientId, delivery.clientId));
  const config = settings?.settings;
  let permitted = Boolean(
    config?.enabled &&
    !settings?.disabled &&
    !settings?.suspendedAt &&
    config.version === delivery.endpointVersion &&
    (delivery.event === 'webhook.test' || config.events.includes(delivery.event)),
  );
  if (permitted && delivery.event !== 'connection.revoked' && delivery.event !== 'webhook.test') {
    const [connection] = await database
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.id, delivery.connectionId),
          eq(oauthConnections.generation, delivery.connectionGeneration),
          isNull(oauthConnections.revokedAt),
          liveWebhookScopeCondition(delivery.event === 'logbook.changed' ? 'logbook:read' : 'workouts:read'),
        ),
      );
    permitted = Boolean(connection);
  }
  if (!permitted || !config) {
    await database
      .update(webhookDeliveries)
      .set({ status: 'cancelled', lastError: 'authorization_or_endpoint_changed', settledAt: new Date() })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  }
  let status: number | null = null;
  let failure: string | null = null;
  let action: ReturnType<typeof webhookResponseAction> = 'retry';
  let secrets: string[];
  try {
    secrets = [decryptWebhookSecret(config.secret)];
    if (
      config.previousSecret &&
      config.previousSecretExpiresAt &&
      config.previousSecretExpiresAt.getTime() > Date.now()
    )
      secrets.push(decryptWebhookSecret(config.previousSecret));
  } catch {
    await database
      .update(webhookDeliveries)
      .set({ lastError: 'signing_unavailable' })
      .where(eq(webhookDeliveries.id, deliveryId));
    throw new Error('Partner webhook signing unavailable');
  }
  try {
    status = await send(config.url, delivery.rawBody, {
      'Boardsesh-Event': delivery.event,
      'Boardsesh-Delivery-Id': delivery.id,
      'Boardsesh-Signature': webhookSignature(delivery.rawBody, secrets),
    });
    action = webhookResponseAction(status);
  } catch (error) {
    // Fixed categories only: transport and TLS messages may contain URL secrets.
    failure = error instanceof UnsafeWebhookUrlError ? 'unsafe_destination' : 'transport_error';
    if (error instanceof UnsafeWebhookUrlError) action = 'failed';
  }
  const attempts = delivery.attempts + 1;
  const retry = action === 'retry' && attempts < 10;
  await database.transaction(async (transaction) => {
    await transaction
      .update(webhookDeliveries)
      .set({
        attempts,
        status: action === 'delivered' ? 'delivered' : retry ? 'retrying' : 'failed',
        lastStatusCode: status,
        lastError: failure,
        deliveredAt: action === 'delivered' ? new Date() : null,
        settledAt: retry ? null : new Date(),
      })
      .where(and(eq(webhookDeliveries.id, deliveryId), inArray(webhookDeliveries.status, ['pending', 'retrying'])));
    const endpoint = and(
      eq(oauthClientWebhooks.clientId, delivery.clientId),
      eq(oauthClientWebhooks.version, delivery.endpointVersion),
    );
    if (action === 'delivered') {
      await transaction.update(oauthClientWebhooks).set({ failingSince: null }).where(endpoint);
    } else {
      await transaction
        .update(oauthClientWebhooks)
        .set({ failingSince: sql`coalesce(${oauthClientWebhooks.failingSince}, now())` })
        .where(endpoint);
    }
    if (action === 'disable') {
      const disabled = await transaction
        .update(oauthClientWebhooks)
        .set({ enabled: false, disabledReason: 'endpoint_gone', updatedAt: new Date() })
        .where(endpoint)
        .returning({ clientId: oauthClientWebhooks.clientId });
      if (disabled.length)
        await transaction
          .update(webhookDeliveries)
          .set({ status: 'cancelled', lastError: 'endpoint_gone', settledAt: new Date() })
          .where(
            and(
              eq(webhookDeliveries.clientId, delivery.clientId),
              eq(webhookDeliveries.endpointVersion, delivery.endpointVersion),
              inArray(webhookDeliveries.status, ['pending', 'retrying']),
            ),
          );
    }
  });
  if (retry) throw new Error('Partner webhook needs a retry');
}

export async function disableFailingPartnerWebhooks(
  database: Database = db,
  notify = sendPartnerWebhookDisabledEmail,
): Promise<void> {
  await database
    .update(oauthClientWebhooks)
    .set({ enabled: false, disabledReason: 'three_days_failing', failureEmailPending: true, updatedAt: new Date() })
    .where(
      and(
        eq(oauthClientWebhooks.enabled, true),
        lt(oauthClientWebhooks.failingSince, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
      ),
    );
  const pending = await database
    .select({ clientId: oauthClientWebhooks.clientId, email: users.email, name: oauthClient.name })
    .from(oauthClientWebhooks)
    .innerJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthClientWebhooks.clientId))
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthClientWebhooks.clientId))
    .innerJoin(users, eq(users.id, oauthAppPolicy.ownerUserId))
    .where(eq(oauthClientWebhooks.failureEmailPending, true))
    .limit(20);
  for (const app of pending) {
    try {
      await notify(app.email, app.name ?? 'Your app');
      await database
        .update(oauthClientWebhooks)
        .set({ failureEmailPending: false })
        .where(eq(oauthClientWebhooks.clientId, app.clientId));
    } catch {
      logger.warn('[PartnerWebhooks] Failure notification will retry');
    }
  }
  // Ledger cancellation is authoritative; cancelling queued jobs also avoids pointless wakeups.
  await database
    .update(webhookDeliveries)
    .set({ status: 'cancelled', lastError: 'endpoint_disabled', settledAt: new Date() })
    .where(
      and(
        inArray(webhookDeliveries.status, ['pending', 'retrying']),
        inArray(
          webhookDeliveries.clientId,
          database
            .select({ clientId: oauthClientWebhooks.clientId })
            .from(oauthClientWebhooks)
            .where(eq(oauthClientWebhooks.enabled, false)),
        ),
      ),
    );
}

/** Repair jobs lost to a worker crash/lease failure without forgetting durable deliveries. */
export async function reconcilePartnerWebhookJobs(boss: PgBoss, database: Database = db): Promise<void> {
  await database.transaction(async (transaction) => {
    const deliveries = await transaction
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          inArray(webhookDeliveries.status, ['pending', 'retrying']),
          lte(webhookDeliveries.nextReconcileAt, new Date()),
          lt(webhookDeliveries.createdAt, new Date(Date.now() - 60_000)),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextReconcileAt), asc(webhookDeliveries.id))
      .limit(100)
      .for('update', { skipLocked: true });
    const adapter = enqueueOn(transaction);
    for (const delivery of deliveries) {
      await transaction
        .update(webhookDeliveries)
        .set({ nextReconcileAt: new Date(Date.now() + 60_000) })
        .where(eq(webhookDeliveries.id, delivery.id));
      const job = await boss.getJobById(PARTNER_WEBHOOK_DELIVERY_QUEUE, delivery.id, { db: adapter });
      if (job?.state === 'failed') {
        await boss.retry(PARTNER_WEBHOOK_DELIVERY_QUEUE, delivery.id, { db: adapter });
      } else if (!job || job.state === 'cancelled' || job.state === 'completed') {
        if (job) await boss.deleteJob(PARTNER_WEBHOOK_DELIVERY_QUEUE, delivery.id, { db: adapter });
        await boss.send(
          PARTNER_WEBHOOK_DELIVERY_QUEUE,
          { deliveryId: delivery.id },
          {
            ...PARTNER_WEBHOOK_JOB_OPTIONS,
            id: delivery.id,
            singletonKey: delivery.id,
            db: adapter,
          },
        );
      }
    }
  });
}

export async function prunePartnerWebhookHistory(database: Database = db): Promise<void> {
  const now = new Date();
  const settledCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const relayCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Bounded statements keep maintenance away from request transactions.
  await database.delete(webhookDeliveries).where(
    inArray(
      webhookDeliveries.id,
      database
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            inArray(webhookDeliveries.status, ['delivered', 'failed', 'cancelled']),
            sql`coalesce(${webhookDeliveries.settledAt}, ${webhookDeliveries.createdAt}) < ${settledCutoff.toISOString()}::timestamptz`,
          ),
        )
        .limit(500),
    ),
  );
  await database
    .delete(partnerWebhookOutbox)
    .where(
      inArray(
        partnerWebhookOutbox.id,
        database
          .select({ id: partnerWebhookOutbox.id })
          .from(partnerWebhookOutbox)
          .where(lt(partnerWebhookOutbox.relayedAt, relayCutoff))
          .limit(500),
      ),
    );
  await database
    .update(oauthClientWebhooks)
    .set({ previousSecret: null, previousSecretExpiresAt: null })
    .where(lt(oauthClientWebhooks.previousSecretExpiresAt, now));
  await database.delete(partnerWebhookDebounce).where(
    or(
      notExists(
        database
          .select({ id: oauthConnections.id })
          .from(oauthConnections)
          .where(
            and(
              eq(oauthConnections.id, partnerWebhookDebounce.connectionId),
              eq(oauthConnections.generation, partnerWebhookDebounce.connectionGeneration),
              isNull(oauthConnections.revokedAt),
            ),
          ),
      ),
      and(
        eq(partnerWebhookDebounce.pending, false),
        lt(partnerWebhookDebounce.lastEnqueuedAt, new Date(now.getTime() - 60_000)),
      ),
    ),
  );
}

export async function startPartnerWebhooks(boss: PgBoss): Promise<void> {
  if (readPartnerOAuthMode() === 'off' || readPartnerOAuthMode() === 'hold') return;
  await boss.schedule(PARTNER_WEBHOOK_MAINTENANCE_QUEUE, '* * * * *', null, { tz: 'UTC' });
  await boss.work(PARTNER_WEBHOOK_MAINTENANCE_QUEUE, async () => {
    try {
      if (readPartnerOAuthMode() === 'off' || readPartnerOAuthMode() === 'hold') return;
      await produceLogbookWebhookEvents();
      await relayPartnerWebhookEvents(boss);
      await disableFailingPartnerWebhooks();
      await reconcilePartnerWebhookJobs(boss);
      await prunePartnerWebhookHistory();
      await reportPartnerFeedHealth();
    } catch {
      // pg-boss persists thrown errors; Drizzle params may contain private bodies.
      throw new Error('Partner webhook maintenance failed');
    }
  });
  await boss.work<{ deliveryId: string }>(PARTNER_WEBHOOK_DELIVERY_QUEUE, { localConcurrency: 2 }, async (jobs) => {
    try {
      for (const job of jobs) {
        if (readPartnerOAuthMode() === 'off' || readPartnerOAuthMode() === 'hold')
          throw new Error('Partner webhooks paused');
        await deliverPartnerWebhook(job.data.deliveryId);
      }
    } catch {
      throw new Error('Partner webhook delivery failed');
    }
  });
}
