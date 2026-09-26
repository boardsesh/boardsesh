import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { BackgroundJobStatus, BackgroundWorkerRole } from '../../background-jobs';

/** Durable lifecycle only. Payloads, credentials and provider responses never belong here. */
export const backgroundJobRuns = pgTable(
  'background_job_runs',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    role: text('role').$type<BackgroundWorkerRole>().notNull(),
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
  (table) => [index('background_job_runs_status_created_idx').on(table.status, table.createdAt)],
);
