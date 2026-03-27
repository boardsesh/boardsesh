import {
  pgTable,
  bigserial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

export const importJobStatusEnum = pgEnum('import_job_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

export const importJobs = pgTable(
  'import_jobs',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(), // 'kilter' | 'tension'
    s3Key: text('s3_key').notNull(), // S3 object key for the uploaded JSON
    status: importJobStatusEnum('status').notNull().default('pending'),

    // Progress tracking
    totalItems: integer('total_items').default(0),
    processedItems: integer('processed_items').default(0),
    failedItems: integer('failed_items').default(0),

    // Error details (array of error messages)
    errors: jsonb('errors').$type<string[]>().default([]),

    // Processing result summary
    result: jsonb('result').$type<{
      followsImported?: number;
      circuitsImported?: number;
      likesImported?: number;
      attemptsImported?: number;
      ascentsImported?: number;
      climbsImported?: number;
      skipped?: number;
    }>(),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    userIdx: index('import_jobs_user_idx').on(table.userId),
    statusIdx: index('import_jobs_status_idx').on(table.status),
  }),
);

export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;
export type ImportJobStatus = 'pending' | 'processing' | 'completed' | 'failed';
