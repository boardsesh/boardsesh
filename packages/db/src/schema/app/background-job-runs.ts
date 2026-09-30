import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { BackgroundJobStatus, BackgroundWorkerRole } from '../../background-jobs';

/**
 * Durable lifecycle plus the family's validated request payload. Credentials,
 * provider URLs and provider responses never belong here: a payload names what
 * to work on (an ID, a board), never how to authenticate.
 */
export const backgroundJobRuns = pgTable(
  'background_job_runs',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    role: text('role').$type<BackgroundWorkerRole>().notNull(),
    // Plain text rather than an enum so a family can ship without a migration.
    family: text('family').default('worker-probe').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    // The family-level dedup key (pg-boss receives it prefixed with the family).
    singletonKey: text('singleton_key'),
    status: text('status').$type<BackgroundJobStatus>().default('queued').notNull(),
    attemptNumber: integer('attempt_number').default(-1).notNull(),
    attemptToken: uuid('attempt_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    errorCode: text('error_code'),
  },
  (table) => [
    index('background_job_runs_status_created_idx').on(table.status, table.createdAt),
    index('background_job_runs_family_status_created_idx').on(table.family, table.status, table.createdAt),
    index('background_job_runs_family_singleton_created_idx').on(table.family, table.singletonKey, table.createdAt),
  ],
);
