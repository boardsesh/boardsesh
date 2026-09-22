import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { randomUUID } from 'node:crypto';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { applyRateLimit, requireAuthenticated } from './shared/helpers';
import {
  getStripeClient,
  isLiveStripeSubscription,
  isStripeSupportConfigured,
  SUPPORT_CURRENCY,
  SUPPORT_MAXIMUM_AMOUNT,
  SUPPORT_MINIMUM_AMOUNT,
  supportReturnUrl,
} from '../../services/stripe-support';

type CheckoutInput = {
  amount: number;
  cadence: 'MONTHLY' | 'ONE_TIME';
  publicCredit: boolean;
  locale?: string | null;
};

function supporterStatus(row?: typeof dbSchema.stripeSupporters.$inferSelect) {
  const active = isLiveStripeSubscription(row?.subscriptionStatus);
  return {
    linked: Boolean(row),
    hasSupported: Boolean(row?.supportedAt),
    showPublicly: Boolean(row?.showPublicly && row?.supportedAt),
    hasActiveSubscription: Boolean(row?.stripeSubscriptionId && active),
    cancelAtPeriodEnd: Boolean(row?.cancelAtPeriodEnd),
  };
}

async function loadSupporter(userId: string) {
  const [row] = await db
    .select()
    .from(dbSchema.stripeSupporters)
    .where(eq(dbSchema.stripeSupporters.userId, userId))
    .limit(1);
  return row;
}

export const supportQueries = {
  supportConfiguration: () => ({
    enabled: isStripeSupportConfigured(),
    currency: SUPPORT_CURRENCY.toUpperCase(),
    minimumAmount: SUPPORT_MINIMUM_AMOUNT,
    maximumAmount: SUPPORT_MAXIMUM_AMOUNT,
    legacyDonateUrl: (() => {
      try {
        const donateUrl = new URL(process.env.STRIPE_DONATE_URL?.trim() || '');
        return donateUrl.protocol === 'https:' ? donateUrl.toString() : null;
      } catch {
        return null;
      }
    })(),
  }),
  publicSupporters: async (_: unknown, { limit, offset }: { limit: number; offset: number }) => {
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const pageOffset = Math.max(Math.trunc(offset), 0);
    const rows = await db
      .select({
        userId: dbSchema.users.id,
        accountName: dbSchema.users.name,
        accountImage: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        supportedAt: dbSchema.stripeSupporters.supportedAt,
      })
      .from(dbSchema.stripeSupporters)
      .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.stripeSupporters.userId))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
      .where(and(eq(dbSchema.stripeSupporters.showPublicly, true), isNotNull(dbSchema.stripeSupporters.supportedAt)))
      .orderBy(desc(dbSchema.stripeSupporters.supportedAt))
      .limit(pageLimit)
      .offset(pageOffset);
    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.displayName || row.accountName || 'Boardsesh supporter',
      avatarUrl: row.avatarUrl || row.accountImage || null,
      supportedAt: row.supportedAt!.toISOString(),
    }));
  },
  mySupporterStatus: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    if (!ctx.isAuthenticated || !ctx.userId) return supporterStatus();
    return supporterStatus(await loadSupporter(ctx.userId));
  },
};

export const supportMutations = {
  createSupportCheckoutSession: async (_: unknown, { input }: { input: CheckoutInput }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 10, 'createSupportCheckoutSession');
    if (
      !Number.isInteger(input.amount) ||
      input.amount < SUPPORT_MINIMUM_AMOUNT ||
      input.amount > SUPPORT_MAXIMUM_AMOUNT
    ) {
      throw new GraphQLError('Choose an amount from $1 to $500.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    if (!['MONTHLY', 'ONE_TIME'].includes(input.cadence)) {
      throw new GraphQLError('Choose monthly or one-time support.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    if (input.publicCredit && (!ctx.isAuthenticated || !ctx.userId)) {
      throw new GraphQLError('Sign in to receive public supporter credit.', {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }

    const stripe = getStripeClient();
    const userId = ctx.isAuthenticated ? ctx.userId : null;
    const [existing, account] = await Promise.all([
      userId ? loadSupporter(userId) : undefined,
      userId
        ? db
            .select({ email: dbSchema.users.email })
            .from(dbSchema.users)
            .where(eq(dbSchema.users.id, userId))
            .limit(1)
            .then((rows) => rows[0])
        : undefined,
    ]);
    if (
      input.cadence === 'MONTHLY' &&
      existing?.stripeSubscriptionId &&
      isLiveStripeSubscription(existing.subscriptionStatus)
    ) {
      throw new GraphQLError('Manage your existing monthly support in the billing portal.', {
        extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' },
      });
    }

    const claimId = userId ? randomUUID() : null;
    if (userId) {
      await db.delete(dbSchema.stripeSupportClaims).where(
        and(
          eq(dbSchema.stripeSupportClaims.userId, userId),
          // Checkout can remain valid for a full day, and delayed-payment
          // webhooks can arrive later. Keep a week of delivery grace.
          lt(dbSchema.stripeSupportClaims.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        ),
      );
      await db.insert(dbSchema.stripeSupportClaims).values({
        id: claimId!,
        userId,
        cadence: input.cadence === 'MONTHLY' ? 'monthly' : 'one_time',
        showPublicly: input.publicCredit,
      });
    }

    const returnUrl = supportReturnUrl(input.locale);
    const session = await stripe.checkout.sessions.create({
      mode: input.cadence === 'MONTHLY' ? 'subscription' : 'payment',
      client_reference_id: claimId ?? undefined,
      customer: existing?.stripeCustomerId || undefined,
      customer_email: existing?.stripeCustomerId ? undefined : account?.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: SUPPORT_CURRENCY,
            unit_amount: input.amount,
            product_data: { name: 'Support Boardsesh' },
            recurring: input.cadence === 'MONTHLY' ? { interval: 'month' } : undefined,
          },
        },
      ],
      success_url: `${returnUrl}?support=thanks`,
      cancel_url: `${returnUrl}?support=cancelled`,
    });
    if (!session.url) throw new Error('Stripe Checkout did not return a URL');
    if (userId) {
      await db
        .update(dbSchema.stripeSupportClaims)
        .set({ checkoutSessionId: session.id })
        .where(and(eq(dbSchema.stripeSupportClaims.userId, userId), eq(dbSchema.stripeSupportClaims.id, claimId!)));
    }
    return { url: session.url };
  },

  updateSupporterVisibility: async (
    _: unknown,
    { showPublicly }: { showPublicly: boolean },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const [row] = await db
      .update(dbSchema.stripeSupporters)
      .set({ showPublicly, updatedAt: new Date() })
      .where(eq(dbSchema.stripeSupporters.userId, ctx.userId!))
      .returning();
    if (!row?.supportedAt) {
      throw new GraphQLError('No completed linked Stripe support was found.', { extensions: { code: 'NOT_FOUND' } });
    }
    return supporterStatus(row);
  },

  createSupportBillingPortalSession: async (
    _: unknown,
    { locale }: { locale?: string | null },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const row = await loadSupporter(ctx.userId!);
    if (!row?.stripeCustomerId) {
      throw new GraphQLError('No linked Stripe billing account was found.', { extensions: { code: 'NOT_FOUND' } });
    }
    const session = await getStripeClient().billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: supportReturnUrl(locale),
    });
    return { url: session.url };
  },
};
