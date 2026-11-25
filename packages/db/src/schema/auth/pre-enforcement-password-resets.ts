import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** Immutable reset evidence before enforcement, never an enforced projection receipt. */
export const authPreEnforcementPasswordResetEvents = pgTable(
  'auth_pre_enforcement_password_reset_events',
  {
    operationId: uuid('operation_id').primaryKey(),
    // No users FK: revocation evidence must survive account deletion.
    userId: text('user_id').notNull(),
    previousGeneration: integer('previous_generation').notNull(),
    generation: integer('generation').notNull(),
    kind: text('kind').$type<'password-reset'>().notNull(),
    domains: text('domains').array().$type<('first-party' | 'partner')[]>().notNull(),
    contextPhase: text('context_phase').$type<'absent' | 'prepared'>().notNull(),
    preparedProjectionId: text('prepared_projection_id'),
    preparedWriterEpoch: integer('prepared_writer_epoch'),
    revokedThrough: timestamp('revoked_through', { withTimezone: true }).notNull(),
    // Supplied from the database clock after the real mutation, never auth age.
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('auth_pre_enforcement_password_reset_events_generation_idx').on(table.userId, table.generation),
    check(
      'auth_pre_enforcement_password_reset_events_generation',
      sql`${table.previousGeneration} >= 0 AND ${table.generation} = ${table.previousGeneration} + 1`,
    ),
    check('auth_pre_enforcement_password_reset_events_kind', sql`${table.kind} = 'password-reset'`),
    check(
      'auth_pre_enforcement_password_reset_events_domains',
      sql`${table.domains} = ARRAY['first-party', 'partner']::text[]`,
    ),
    check(
      'auth_pre_enforcement_password_reset_events_context',
      sql`(${table.contextPhase} = 'absent' AND ${table.preparedProjectionId} IS NULL AND ${table.preparedWriterEpoch} IS NULL) OR (${table.contextPhase} = 'prepared' AND ${table.preparedProjectionId} IS NOT NULL AND length(${table.preparedProjectionId}) > 0 AND ${table.preparedWriterEpoch} IS NOT NULL AND ${table.preparedWriterEpoch} > 0)`,
    ),
  ],
);
