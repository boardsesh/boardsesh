import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/** How a supporter row got its current status. */
export const SUPPORTER_SOURCES = ['stripe', 'github_sponsors', 'admin'] as const;
export type SupporterSource = (typeof SUPPORTER_SOURCES)[number];

/** Currencies the Payment Links charge in. Anything else is logged and ignored. */
export const SUPPORT_CLAIM_CURRENCIES = ['aud', 'usd'] as const;
export type SupportClaimCurrency = (typeof SUPPORT_CLAIM_CURRENCIES)[number];

/**
 * Link between a Boardsesh account and its support. Stripe remains the source
 * of truth for money and billing details; this table stores only what the tag
 * rule needs (docs/supporters.md): the live subscription, if any, and how long
 * one-off gifts or a hand grant keep the tag on (`credit_until`).
 */
export const stripeSupporters = pgTable(
  'stripe_supporters',
  {
    userId: text('user_id')
      .primaryKey()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    subscriptionStatus: text('subscription_status'),
    stripeEventCreatedAt: timestamp('stripe_event_created_at'),
    showPublicly: boolean('show_publicly').notNull().default(false),
    supportedAt: timestamp('supported_at'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    source: text('source').$type<SupporterSource>().notNull().default('stripe'),
    creditUntil: timestamp('credit_until'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('stripe_supporters_customer_idx').on(table.stripeCustomerId),
    uniqueIndex('stripe_supporters_subscription_unique').on(table.stripeSubscriptionId),
    index('stripe_supporters_public_idx').on(table.showPublicly, table.supportedAt),
    check('stripe_supporters_source_check', sql`${table.source} IN ('stripe', 'github_sponsors', 'admin')`),
  ],
);

/**
 * An opaque `sc_` id a signed-in climber carries to a Payment Link as
 * `client_reference_id`. The webhook fills `checkout_session_id` when the
 * payment lands, and the unique index on it makes this table the ledger of
 * sessions already counted: a session is credited once, whichever path
 * (webhook or claim-by-email) reaches it first.
 */
export const stripeSupportClaims = pgTable(
  'stripe_support_claims',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    checkoutSessionId: text('checkout_session_id'),
    checkoutExpiresAt: timestamp('checkout_expires_at'),
    cadence: text('cadence').$type<'monthly' | 'one_time'>().notNull(),
    showPublicly: boolean('show_publicly').notNull().default(false),
    currency: text('currency').$type<SupportClaimCurrency>(),
    src: text('src'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('stripe_support_claims_checkout_unique')
      .on(table.checkoutSessionId)
      .where(sql`${table.checkoutSessionId} IS NOT NULL`),
    index('stripe_support_claims_user_idx').on(table.userId),
    check('stripe_support_claims_cadence_check', sql`${table.cadence} IN ('monthly', 'one_time')`),
    check(
      'stripe_support_claims_currency_check',
      sql`${table.currency} IS NULL OR ${table.currency} IN ('aud', 'usd')`,
    ),
    check('stripe_support_claims_id_prefix_check', sql`left(${table.id}, 3) = 'sc_'`),
  ],
);

export type SupportDeletionIntent = { subscriptionId: string | null; removeSetterName: boolean };

/** Recoverable per-account billing lease; external Stripe calls never hold DB locks. */
export const stripeSupportOperations = pgTable('stripe_support_operations', {
  userId: text('user_id')
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  state: text('state')
    .$type<'idle' | 'checking_checkout' | 'accepting' | 'subscription' | 'deleting' | 'reconciling'>()
    .notNull()
    .default('idle'),
  operationId: text('operation_id'),
  ownerToken: text('owner_token'),
  leaseExpiresAt: timestamp('lease_expires_at'),
  deletionIntent: jsonb('deletion_intent').$type<SupportDeletionIntent>(),
});
