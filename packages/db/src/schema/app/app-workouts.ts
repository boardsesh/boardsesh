import { pgTable, text, timestamp, jsonb, integer, boolean, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { oauthClient, oauthConnections } from '../auth/partner-oauth';
import { users } from '../auth/users';
import { boardSessions } from './sessions';

/** A partner's plan and its connection generation, one workout per climber/session. */
export const appWorkouts = pgTable(
  'app_workouts',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => oauthConnections.id, { onDelete: 'cascade' }),
    connectionGeneration: integer('connection_generation').notNull(),
    externalRef: text('external_ref').notNull(),
    title: text('title').notNull(),
    spec: jsonb('spec').notNull(),
    planSnapshot: jsonb('plan_snapshot'),
    status: text('status').notNull().default('created'),
    sessionId: text('session_id').references(() => boardSessions.id, { onDelete: 'restrict' }),
    openedByMismatch: boolean('opened_by_mismatch').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('app_workouts_external_ref_idx').on(table.clientId, table.userId, table.externalRef),
    uniqueIndex('app_workouts_session_user_idx').on(table.sessionId, table.userId),
    index('app_workouts_connection_status_idx').on(table.connectionId, table.status),
    index('app_workouts_app_user_status_idx').on(table.clientId, table.userId, table.status),
    index('app_workouts_expiry_idx').on(table.status, table.expiresAt),
  ],
);

/** Independent retention lets a key be reused after its documented 24-hour lifetime. */
export const appWorkoutRequests = pgTable(
  'app_workout_requests',
  {
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    bodyHash: text('body_hash').notNull(),
    response: jsonb('response').notNull(),
    connectionGeneration: integer('connection_generation').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId, table.key] }),
    index('app_workout_requests_expiry_idx').on(table.expiresAt),
  ],
);
