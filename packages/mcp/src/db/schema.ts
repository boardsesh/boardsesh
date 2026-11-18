import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { CreateWorkout } from '@boardsesh/public-api';
import type { Profile } from '../types';

export const localSettings = sqliteTable('local_settings', {
  key: text('key').primaryKey(),
  profile: text('profile', { mode: 'json' }).$type<Profile>().notNull(),
});

export const logbookStates = sqliteTable('logbook_states', {
  accountId: text('account_id').primaryKey(),
  activeVersion: text('active_version'),
  stagingVersion: text('staging_version'),
  stagingOwner: text('staging_owner'),
  cursor: text('cursor'),
  fullSyncRequired: integer('full_sync_required', { mode: 'boolean' }).notNull().default(true),
  catchingUp: integer('catching_up', { mode: 'boolean' }).notNull().default(false),
  inFlight: integer('in_flight', { mode: 'boolean' }).notNull().default(true),
  lastSyncedAt: text('last_synced_at'),
});

export const logbookTicks = sqliteTable(
  'logbook_ticks',
  {
    accountId: text('account_id').notNull(),
    version: text('version').notNull(),
    tickId: text('tick_id').notNull(),
    climbedAt: integer('climbed_at').notNull(),
    board: text('board').notNull(),
    layout: text('layout').notNull(),
    angle: integer('angle').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    climbId: text('climb_id').notNull(),
    climbName: text('climb_name'),
    comment: text('comment'),
    gradeLabel: text('grade_label'),
    gradeV: integer('grade_v'),
    gradeFont: text('grade_font'),
    tick: text('tick', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.version, table.tickId] }),
    index('logbook_ticks_date').on(table.accountId, table.version, table.climbedAt, table.tickId),
    index('logbook_ticks_board').on(table.accountId, table.version, table.board, table.angle, table.status),
    index('logbook_ticks_climb').on(table.accountId, table.version, table.climbId),
  ],
);

export const workoutDrafts = sqliteTable(
  'workout_drafts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    generation: text('generation').notNull(),
    body: text('body', { mode: 'json' }).$type<CreateWorkout>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: integer('expires_at').notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>(),
  },
  (table) => [index('workout_drafts_cleanup').on(table.result, table.expiresAt, table.id)],
);
