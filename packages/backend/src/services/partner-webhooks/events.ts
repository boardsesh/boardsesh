import { and, eq, isNull } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { oauthConnections } from '@boardsesh/db/schema/auth';
import { oauthClientWebhooks, partnerWebhookOutbox } from '@boardsesh/db/schema/app';
import { ensurePartnerSubject } from '../../auth/partner/api-access';
import type { PartnerDatabase } from '../../auth/partner/tables';

export const PARTNER_WEBHOOK_EVENTS = ['logbook.changed', 'workout.completed', 'connection.revoked'] as const;
export type PartnerWebhookEvent = (typeof PARTNER_WEBHOOK_EVENTS)[number];
export type WebhookTransaction = Pick<DbInstance, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/** State and notification commit together. No network or queue access inside a lifecycle transaction. */
export async function enqueuePartnerWebhookEvent(
  transaction: WebhookTransaction,
  event: {
    clientId: string;
    connectionId: string;
    connectionGeneration: number;
    type: PartnerWebhookEvent;
    workoutId?: string;
    occurredAt?: Date;
  },
): Promise<void> {
  const [settings] = await transaction
    .select({
      enabled: oauthClientWebhooks.enabled,
      events: oauthClientWebhooks.events,
      version: oauthClientWebhooks.version,
    })
    .from(oauthClientWebhooks)
    .where(eq(oauthClientWebhooks.clientId, event.clientId));
  if (!settings?.enabled || !settings.events.includes(event.type)) return;
  const [connection] = await transaction
    .select({ userId: oauthConnections.userId })
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.id, event.connectionId),
        eq(oauthConnections.clientId, event.clientId),
        eq(oauthConnections.generation, event.connectionGeneration),
        isNull(oauthConnections.revokedAt),
      ),
    );
  if (!connection) return;
  const subject = await ensurePartnerSubject(
    transaction as unknown as PartnerDatabase,
    connection.userId,
    event.clientId,
  );
  await transaction
    .insert(partnerWebhookOutbox)
    .values({
      clientId: event.clientId,
      connectionId: event.connectionId,
      connectionGeneration: event.connectionGeneration,
      endpointVersion: settings.version,
      type: event.type,
      subject,
      workoutId: event.workoutId,
      occurredAt: event.occurredAt ?? new Date(),
    })
    .onConflictDoNothing();
}
