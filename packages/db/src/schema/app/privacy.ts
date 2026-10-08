import { pgTable, text, integer, boolean, timestamp, primaryKey, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

/** Existing user_follows rows remain accepted; requests never grant access. */
export const userFollowRequests = pgTable(
  'user_follow_requests',
  {
    requesterId: text('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.requesterId, table.recipientId] }),
    index('user_follow_requests_recipient_idx').on(table.recipientId, table.createdAt),
    check('user_follow_requests_not_self', sql`${table.requesterId} <> ${table.recipientId}`),
  ],
);

export const contentPrivacy = pgTable(
  'content_privacy',
  {
    entityType: text('entity_type').$type<'tick' | 'session' | 'comment' | 'climb' | 'playlist' | 'beta'>().notNull(),
    entityId: text('entity_id').notNull(),
    // Deleted-account policies remain as ownerless deny tombstones. Otherwise
    // SET NULL on a climb/beta author would misclassify it as external catalogue.
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    audience: text('audience').$type<'public' | 'followers' | 'only_me'>().notNull(),
    publicConsentRevision: integer('public_consent_revision'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityType, table.entityId] }),
    index('content_privacy_owner_idx').on(table.ownerId),
    check('content_privacy_audience_check', sql`${table.audience} IN ('public', 'followers', 'only_me')`),
    check(
      'content_privacy_type_check',
      sql`${table.entityType} IN ('tick', 'session', 'comment', 'climb', 'playlist', 'beta')`,
    ),
  ],
);

export const resourcePrivacy = pgTable(
  'resource_privacy',
  {
    kind: text('kind').$type<'board' | 'session'>().notNull(),
    resourceId: text('resource_id').notNull(),
    // Preserve explicit denials after a session's creator is deleted; dropping
    // the override would reactivate legacy participant access.
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    audience: text('audience').$type<'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me'>().notNull(),
    locationAudience: text('location_audience')
      .$type<'public' | 'followers' | 'members' | 'only_me'>()
      .default('only_me')
      .notNull(),
    inheritFollowers: boolean('inherit_followers').default(false).notNull(),
    revision: integer('revision').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.resourceId] }),
    index('resource_privacy_owner_idx').on(table.ownerId),
    check('resource_privacy_kind_check', sql`${table.kind} IN ('board', 'session')`),
    check(
      'resource_privacy_audience_check',
      sql`${table.audience} IN ('public', 'unlisted', 'followers', 'invite_only', 'only_me')`,
    ),
    check(
      'resource_privacy_location_check',
      sql`${table.locationAudience} IN ('public', 'followers', 'members', 'only_me')`,
    ),
  ],
);

/** Grants are bound to an account. Retained revocations override old participation. */
export const resourceGrants = pgTable(
  'resource_grants',
  {
    kind: text('kind').$type<'board' | 'session'>().notNull(),
    resourceId: text('resource_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<'pending' | 'approved' | 'revoked'>().default('pending').notNull(),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.resourceId, table.userId] }),
    index('resource_grants_user_idx').on(table.userId, table.status),
    check('resource_grants_kind_check', sql`${table.kind} IN ('board', 'session')`),
    check('resource_grants_status_check', sql`${table.status} IN ('pending', 'approved', 'revoked')`),
  ],
);
