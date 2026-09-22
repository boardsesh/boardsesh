import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * Minimal link between a Boardsesh account and Stripe. Stripe remains the
 * source of truth for money and billing details; this table stores only the
 * identifiers needed for attribution and self-service subscription handling.
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    customerIdx: index('stripe_supporters_customer_idx').on(table.stripeCustomerId),
    subscriptionUnique: uniqueIndex('stripe_supporters_subscription_unique').on(table.stripeSubscriptionId),
    publicIdx: index('stripe_supporters_public_idx').on(table.showPublicly, table.supportedAt),
  }),
);

/** A short-lived, opaque binding used to accept a specific Checkout webhook. */
export const stripeSupportClaims = pgTable(
  'stripe_support_claims',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    checkoutSessionId: text('checkout_session_id'),
    cadence: text('cadence').notNull(),
    showPublicly: boolean('show_publicly').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    checkoutUnique: uniqueIndex('stripe_support_claims_checkout_unique').on(table.checkoutSessionId),
    userIdx: index('stripe_support_claims_user_idx').on(table.userId),
  }),
);
