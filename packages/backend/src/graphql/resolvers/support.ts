import Stripe from 'stripe';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { randomUUID } from 'node:crypto';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';
import { reconcileExpiredSupportClaims } from '../../services/reconcile-support-claims';
import { withSupportOperation } from '../../services/stripe-support-operation';
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
  publicSupporters: async (
    _: unknown,
    { limit, offset }: { limit: number; offset: number },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 120, 'publicSupporters');
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
      .orderBy(desc(dbSchema.stripeSupporters.supportedAt), asc(dbSchema.stripeSupporters.userId))
      .limit(pageLimit)
      .offset(pageOffset);
    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.displayName || row.accountName || row.userId,
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
    if (!isStripeSupportConfigured()) {
      throw new GraphQLError('Stripe support is temporarily unavailable.', {
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }

    const stripe = getStripeClient();
    const userId = ctx.isAuthenticated ? ctx.userId : null;
    if (userId) await reconcileExpiredSupportClaims(userId);
    const claimId = userId ? randomUUID() : null;
    const checkoutExpiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 23 * 60 * 60 * 1000);
    const linkedAccount = userId
      ? await withSupportOperation(
          userId,
          'checking_checkout',
          async (transaction) => {
            const [account] = await transaction
              .select({ email: dbSchema.users.email })
              .from(dbSchema.users)
              .where(eq(dbSchema.users.id, userId))
              .limit(1);
            const [existing] = await transaction
              .select()
              .from(dbSchema.stripeSupporters)
              .where(eq(dbSchema.stripeSupporters.userId, userId))
              .limit(1);
            if (input.cadence === 'MONTHLY') {
              const [pendingClaim] = await transaction
                .select({ id: dbSchema.stripeSupportClaims.id })
                .from(dbSchema.stripeSupportClaims)
                .where(
                  and(
                    eq(dbSchema.stripeSupportClaims.userId, userId),
                    eq(dbSchema.stripeSupportClaims.cadence, 'monthly'),
                  ),
                )
                .limit(1);
              if (pendingClaim) {
                throw new GraphQLError('Finish your pending monthly Checkout or wait for it to expire.', {
                  extensions: { code: 'PENDING_CHECKOUT_EXISTS' },
                });
              }
            }
            return { existing, account };
          },
          async ({ existing }) => {
            if (input.cadence === 'MONTHLY' && existing?.stripeSubscriptionId) {
              const subscription = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
              if (!['canceled', 'incomplete_expired'].includes(subscription.status)) {
                throw new GraphQLError('Manage your existing monthly support in the billing portal.', {
                  extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' },
                });
              }
            }
          },
          async (transaction, prepared) => {
            // The fenced operation prevents changes to the billing snapshot.
            // Commit the claim before asking Stripe to create a payable session.
            await transaction.insert(dbSchema.stripeSupportClaims).values({
              id: claimId!,
              userId,
              cadence: input.cadence === 'MONTHLY' ? 'monthly' : 'one_time',
              showPublicly: input.publicCredit,
              checkoutExpiresAt,
            });
            return prepared;
          },
        )
      : undefined;
    if (userId && !linkedAccount) {
      throw new GraphQLError('Your account was not found. Sign in again.', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    const existing = linkedAccount?.existing;
    const account = linkedAccount?.account;

    const returnUrl = supportReturnUrl(input.locale);
    let session;
    try {
      session = await stripe.checkout.sessions.create(
        {
          expires_at: Math.floor(checkoutExpiresAt.getTime() / 1000),
          mode: input.cadence === 'MONTHLY' ? 'subscription' : 'payment',
          customer_creation: input.cadence === 'ONE_TIME' && !existing?.stripeCustomerId ? 'always' : undefined,
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
        },
        claimId ? { idempotencyKey: claimId } : undefined,
      );
    } catch (error) {
      // A connection/5xx failure can hide a successfully created session.
      // Retain its claim so a retry or deletion cannot orphan recurring billing.
      const definitelyRejected =
        error instanceof Stripe.errors.StripeInvalidRequestError ||
        error instanceof Stripe.errors.StripeAuthenticationError ||
        error instanceof Stripe.errors.StripePermissionError;
      if (claimId && definitelyRejected) {
        await db.delete(dbSchema.stripeSupportClaims).where(eq(dbSchema.stripeSupportClaims.id, claimId));
      }
      if (claimId && !definitelyRejected)
        logger.error('[stripe-support] Checkout outcome requires reconciliation', { claimId, error });
      throw error;
    }
    if (!session.url) throw new Error('Stripe Checkout did not return a URL');
    if (userId) {
      try {
        await db
          .update(dbSchema.stripeSupportClaims)
          .set({ checkoutSessionId: session.id })
          .where(eq(dbSchema.stripeSupportClaims.id, claimId!));
      } catch (error) {
        logger.error('[stripe-support] failed to record Checkout session ID', {
          claimId,
          sessionId: session.id,
          error,
        });
      }
    }
    return { url: session.url };
  },

  updateSupporterVisibility: async (
    _: unknown,
    { showPublicly }: { showPublicly: boolean },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'updateSupporterVisibility');
    const [row] = await db
      .update(dbSchema.stripeSupporters)
      .set({ showPublicly, updatedAt: new Date() })
      .where(and(eq(dbSchema.stripeSupporters.userId, ctx.userId!), isNotNull(dbSchema.stripeSupporters.supportedAt)))
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
    await applyRateLimit(ctx, 10, 'createSupportBillingPortalSession');
    if (!isStripeSupportConfigured()) {
      throw new GraphQLError('Stripe support is temporarily unavailable.', {
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
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
