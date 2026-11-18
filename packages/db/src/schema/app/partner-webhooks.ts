import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { oauthClient } from '../auth/partner-oauth';
import { appWorkouts } from './app-workouts';

export const oauthClientWebhooks = pgTable('oauth_client_webhooks', {
  clientId: text('client_id')
    .primaryKey()
    .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  secret: text('secret').notNull(),
  previousSecret: text('previous_secret'),
  previousSecretExpiresAt: timestamp('previous_secret_expires_at', { withTimezone: true }),
  enabled: boolean('enabled').default(true).notNull(),
  version: integer('version').default(1).notNull(),
  failingSince: timestamp('failing_since', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  disabledReason: text('disabled_reason'),
  failureEmailPending: boolean('failure_email_pending').default(false).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** No connection/user FK: a revocation notification must survive account deletion. */
export const partnerWebhookOutbox = pgTable(
  'partner_webhook_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull(),
    connectionGeneration: integer('connection_generation').notNull(),
    endpointVersion: integer('endpoint_version').default(1).notNull(),
    type: text('type').notNull(),
    subject: text('subject').notNull(),
    workoutId: text('workout_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
  },
  (table) => [
    index('partner_webhook_outbox_pending_idx')
      .on(table.occurredAt)
      .where(sql`${table.relayedAt} IS NULL`),
    uniqueIndex('partner_webhook_revocation_generation_idx')
      .on(table.connectionId, table.connectionGeneration)
      .where(sql`${table.type} = 'connection.revoked'`),
    // At most one unsent completion per workout. A workout's results can change
    // after End, so a sent one may be followed by another (docs/partner-api.md
    // section 5); an unsent one already makes the app read the newest results.
    uniqueIndex('partner_webhook_workout_completion_pending_idx')
      .on(table.workoutId)
      .where(sql`${table.type} = 'workout.completed' AND ${table.relayedAt} IS NULL`),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull(),
    connectionGeneration: integer('connection_generation').notNull(),
    endpointVersion: integer('endpoint_version').notNull(),
    event: text('event').notNull(),
    rawBody: text('raw_body').notNull(),
    status: text('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    nextReconcileAt: timestamp('next_reconcile_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('webhook_deliveries_client_created_idx').on(table.clientId, table.createdAt),
    index('webhook_deliveries_reconcile_idx')
      .on(table.nextReconcileAt, table.id)
      .where(sql`${table.status} in ('pending', 'retrying')`),
  ],
);

export const partnerWebhookFeedState = pgTable('partner_webhook_feed_state', {
  id: integer('id').default(1).primaryKey(),
  feedGeneration: uuid('feed_generation').notNull(),
  txid: text('txid').default('0').notNull(),
  seq: text('seq').default('0').notNull(),
});

export const partnerWebhookDebounce = pgTable(
  'partner_webhook_debounce',
  {
    connectionId: text('connection_id').notNull(),
    connectionGeneration: integer('connection_generation').notNull(),
    lastEnqueuedAt: timestamp('last_enqueued_at', { withTimezone: true }).notNull(),
    pending: boolean('pending').default(false).notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.connectionGeneration] })],
);

/**
 * Re-sent `workout.completed` for results that change after End (a late tick,
 * an edit, a delete). One row per workout: `pending` holds the trailing change
 * and `lastEnqueuedAt` spaces sends at least a minute apart, across restarts
 * and backend replicas. A fresh row starts at the workout's `completed_at`,
 * which counts as the first send.
 */
export const partnerWorkoutResultDebounce = pgTable('partner_workout_result_debounce', {
  workoutId: text('workout_id')
    .primaryKey()
    .references(() => appWorkouts.id, { onDelete: 'cascade' }),
  lastEnqueuedAt: timestamp('last_enqueued_at', { withTimezone: true }).notNull(),
  pending: boolean('pending').default(false).notNull(),
});
