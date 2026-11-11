import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Additive, unmounted preparation metadata. An enforced marker is not a role fence. */
export const authEmailProjection = pgTable(
  'auth_email_projection',
  {
    projectionId: text('projection_id').primaryKey(),
    isCurrent: boolean('is_current').notNull().default(true),
    normalizerVersion: text('normalizer_version').notNull(),
    phase: text('phase').$type<'preparing' | 'prepared' | 'enforced'>().notNull(),
    writerEpoch: integer('writer_epoch').notNull(),
    sourceUserCount: integer('source_user_count').notNull().default(0),
    keyCount: integer('key_count').notNull().default(0),
    ambiguousKeyCount: integer('ambiguous_key_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('auth_email_projection_current_idx')
      .on(table.isCurrent)
      .where(sql`${table.isCurrent} = true`),
    check('auth_email_projection_phase', sql`${table.phase} IN ('preparing', 'prepared', 'enforced')`),
    check('auth_email_projection_epoch', sql`${table.writerEpoch} > 0`),
    check(
      'auth_email_projection_counts',
      sql`${table.sourceUserCount} >= 0 AND ${table.keyCount} >= 0 AND ${table.ambiguousKeyCount} >= 0 AND ${table.ambiguousKeyCount} <= ${table.keyCount}`,
    ),
    check(
      'auth_email_projection_completion',
      sql`(${table.phase} = 'preparing' AND ${table.preparedAt} IS NULL) OR (${table.phase} IN ('prepared', 'enforced') AND ${table.preparedAt} IS NOT NULL)`,
    ),
  ],
);

/** No users FK: deletion must not make a formerly held address available. */
export const authEmailReservations = pgTable(
  'auth_email_reservations',
  {
    normalizedEmail: text('normalized_email').primaryKey(),
    basisProjectionId: text('basis_projection_id')
      .notNull()
      .references(() => authEmailProjection.projectionId, { onDelete: 'restrict' }),
    state: text('state').$type<'owned' | 'blocked_ambiguous' | 'blocked_deleted' | 'blocked_invalid'>().notNull(),
    ownerUserId: text('owner_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'auth_email_reservations_state',
      sql`${table.state} IN ('owned', 'blocked_ambiguous', 'blocked_deleted', 'blocked_invalid')`,
    ),
    check(
      'auth_email_reservations_owner',
      sql`(${table.state} = 'owned' AND ${table.ownerUserId} IS NOT NULL) OR (${table.state} <> 'owned' AND ${table.ownerUserId} IS NULL)`,
    ),
    index('auth_email_reservations_owner_idx').on(table.ownerUserId),
  ],
);

/** Historical membership is retained when one collision member is deleted. */
export const authEmailReservationMembers = pgTable(
  'auth_email_reservation_members',
  {
    normalizedEmail: text('normalized_email')
      .notNull()
      .references(() => authEmailReservations.normalizedEmail, { onDelete: 'restrict' }),
    userId: text('user_id').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.normalizedEmail, table.userId] }),
    index('auth_email_reservation_members_user_idx').on(table.userId),
  ],
);

/**
 * Durable revocation state intentionally survives deletion of users.id.
 * No row means generation 0 and native generation 0.
 */
export const authSubjectCutoffs = pgTable(
  'auth_subject_cutoffs',
  {
    userId: text('user_id').primaryKey(),
    generation: integer('generation').notNull(),
    // Moves alone when the climber signs out of the app, so it ends native
    // credentials (app, watch) and leaves the website signed in.
    nativeGeneration: integer('native_generation').notNull().default(0),
    revokedThrough: timestamp('revoked_through', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    lastOperationId: text('last_operation_id').notNull(),
  },
  (table) => [
    check('auth_subject_cutoffs_generation', sql`${table.generation} >= 0`),
    check('auth_subject_cutoffs_native_generation', sql`${table.nativeGeneration} >= 0`),
  ],
);

/** Immutable mutation receipt and authority-neutral outbox; no credential material. */
export const authSecurityMutationEvents = pgTable(
  'auth_security_mutation_events',
  {
    operationId: text('operation_id').primaryKey(),
    userId: text('user_id').notNull(),
    generation: integer('generation').notNull(),
    previousGeneration: integer('previous_generation').notNull(),
    kind: text('kind').$type<'password-set' | 'password-change' | 'password-reset' | 'account-deletion'>().notNull(),
    domains: text('domains').array().$type<('first-party' | 'partner')[]>().notNull(),
    revokedThrough: timestamp('revoked_through', { withTimezone: true }).notNull(),
    writerEpoch: integer('writer_epoch').notNull(),
    projectionId: text('projection_id').notNull(),
    payloadVersion: integer('payload_version').notNull().default(1),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_security_mutation_events_generation_idx').on(table.userId, table.generation),
    check(
      'auth_security_mutation_events_generation',
      sql`${table.previousGeneration} >= 0 AND ${table.generation} = ${table.previousGeneration} + 1`,
    ),
    check(
      'auth_security_mutation_events_kind',
      sql`${table.kind} IN ('password-set', 'password-change', 'password-reset', 'account-deletion')`,
    ),
    check('auth_security_mutation_events_domains', sql`${table.domains} = ARRAY['first-party', 'partner']::text[]`),
    check('auth_security_mutation_events_epoch', sql`${table.writerEpoch} > 0 AND ${table.payloadVersion} = 1`),
  ],
);
