import {
  pgTable,
  bigserial,
  bigint,
  text,
  boolean,
  timestamp,
  doublePrecision,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

export const gymMemberRoleEnum = pgEnum('gym_member_role', ['admin', 'editor', 'member']);

export const gymClaimMethodEnum = pgEnum('gym_claim_method', ['domain', 'admin']);

export const gymClaimStatusEnum = pgEnum('gym_claim_status', ['pending', 'approved', 'denied', 'expired']);

/**
 * Gyms table — represents a physical gym location that can contain multiple boards.
 */
export const gyms = pgTable(
  'gyms',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: text('uuid').notNull().unique(),
    name: text('name').notNull(),
    slug: text('slug'),
    ownerId: text('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    address: text('address'),
    website: text('website'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    isPublic: boolean('is_public').default(true).notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    uniqueSlugIdx: uniqueIndex('gyms_unique_slug')
      .on(table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    uuidIdx: index('gyms_uuid_idx').on(table.uuid),
    ownerIdx: index('gyms_owner_idx')
      .on(table.ownerId)
      .where(sql`${table.deletedAt} IS NULL`),
    publicIdx: index('gyms_public_idx')
      .on(table.isPublic)
      .where(sql`${table.deletedAt} IS NULL`),
  }),
);

/**
 * Gym members table — tracks which users are members of which gyms.
 */
export const gymMembers = pgTable(
  'gym_members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gymId: bigint('gym_id', { mode: 'number' })
      .references(() => gyms.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: gymMemberRoleEnum('role').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueGymUser: uniqueIndex('gym_members_unique_gym_user').on(table.gymId, table.userId),
  }),
);

/**
 * Gym follows table — tracks which users follow which gyms.
 */
export const gymFollows = pgTable(
  'gym_follows',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gymId: bigint('gym_id', { mode: 'number' })
      .references(() => gyms.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueGymUser: uniqueIndex('gym_follows_unique_gym_user').on(table.gymId, table.userId),
  }),
);

/**
 * Gym claims table — tracks requests from users to take ownership of a gym.
 *
 * Two paths, distinguished by `method`:
 * - `domain`: the user proved control of an email at the gym's website domain.
 *   A verification token (hashed) is emailed to `claimEmail`; clicking the link
 *   transfers ownership automatically.
 * - `admin`: no usable domain on file, so the claim waits for a Boardsesh admin
 *   to approve/deny it from the `/admin/gym-claims` queue.
 */
export const gymClaims = pgTable(
  'gym_claims',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gymId: bigint('gym_id', { mode: 'number' })
      .references(() => gyms.id, { onDelete: 'cascade' })
      .notNull(),
    claimantUserId: text('claimant_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    method: gymClaimMethodEnum('method').notNull(),
    status: gymClaimStatusEnum('status').notNull().default('pending'),
    // Domain path: the address the verification email was sent to.
    claimEmail: text('claim_email'),
    // Admin path: an optional note from the claimant for the reviewer.
    message: text('message'),
    // Domain path: sha256 of the single-use verification token (raw token only
    // ever travels in the email link, never stored).
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at'),
    // Admin path: the admin who approved/denied.
    reviewedBy: text('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    gymIdx: index('gym_claims_gym_idx').on(table.gymId),
    claimantIdx: index('gym_claims_claimant_idx').on(table.claimantUserId),
    statusIdx: index('gym_claims_status_idx').on(table.status),
    tokenHashIdx: uniqueIndex('gym_claims_token_hash_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
    // At most one open (pending) claim per (gym, claimant).
    uniquePendingClaim: uniqueIndex('gym_claims_unique_pending')
      .on(table.gymId, table.claimantUserId)
      .where(sql`${table.status} = 'pending'`),
  }),
);

// Type exports
export type Gym = typeof gyms.$inferSelect;
export type NewGym = typeof gyms.$inferInsert;
export type GymMember = typeof gymMembers.$inferSelect;
export type NewGymMember = typeof gymMembers.$inferInsert;
export type GymFollow = typeof gymFollows.$inferSelect;
export type NewGymFollow = typeof gymFollows.$inferInsert;
export type GymClaim = typeof gymClaims.$inferSelect;
export type NewGymClaim = typeof gymClaims.$inferInsert;
