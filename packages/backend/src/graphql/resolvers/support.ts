import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import type { SupporterSource } from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { claimSupporterByEmail } from '../../services/claim-supporter-by-email';
import { isStripeSupportConfigured, newSupportClaimId, supportedCurrency } from '../../services/stripe-support';
import { lockSupportAccount } from '../../services/stripe-support-lock';
import { loadSupporterRow, type SupporterRow } from '../../services/stripe-supporter-sync';
import {
  isCurrentSupporter,
  isLiveSubscriptionStatus,
  LIVE_SUBSCRIPTION_STATUSES,
} from '../../services/supporter-status';
import { logger } from '../../utils/logger';
import { applyRateLimit, requireAuthenticated } from './shared/helpers';
import { requireAdmin } from './social/roles';

export type MySupporterStatus = {
  isSupporter: boolean;
  showPublicly: boolean;
  source: string | null;
  creditUntil: string | null;
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
};

/** Unused claims older than this are pruned; the climber's next support starts a new one. */
export const UNUSED_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SRC_LENGTH = 40;
const DEFAULT_PUBLIC_SUPPORTERS_LIMIT = 100;
const MAX_PUBLIC_SUPPORTERS_LIMIT = 500;
const GRANTABLE_SOURCES: readonly SupporterSource[] = ['github_sponsors', 'admin'];

export function toMySupporterStatus(row: SupporterRow | null | undefined, now: Date): MySupporterStatus {
  const hasSubscription = Boolean(row?.stripeSubscriptionId && isLiveSubscriptionStatus(row.subscriptionStatus));
  return {
    isSupporter: isCurrentSupporter(row, now),
    showPublicly: row?.showPublicly ?? false,
    // A row that only holds a visibility choice made before any support has no source yet.
    source: row?.supportedAt ? row.source : null,
    creditUntil: row?.creditUntil?.toISOString() ?? null,
    hasSubscription,
    cancelAtPeriodEnd: hasSubscription && Boolean(row?.cancelAtPeriodEnd),
  };
}

async function loadSupporter(userId: string): Promise<SupporterRow | null> {
  const [row] = await db
    .select()
    .from(dbSchema.stripeSupporters)
    .where(eq(dbSchema.stripeSupporters.userId, userId))
    .limit(1);
  return row ?? null;
}

/** SQL twin of `isCurrentSupporter`, for lists. */
function currentSupporterCondition(now: Date) {
  return or(
    gt(dbSchema.stripeSupporters.creditUntil, now),
    and(
      isNotNull(dbSchema.stripeSupporters.stripeSubscriptionId),
      inArray(dbSchema.stripeSupporters.subscriptionStatus, [...LIVE_SUBSCRIPTION_STATUSES]),
    ),
  );
}

/**
 * Whether a public profile shows the supporter tag: only while the climber is
 * currently a supporter and chose public credit, and only to a viewer who may
 * see the profile's activity. A lookup failure shows no tag.
 */
export async function resolveProfileSupporterTag(userId: string, canViewActivity: boolean): Promise<boolean> {
  if (!canViewActivity) return false;
  try {
    const row = await loadSupporter(userId);
    return Boolean(row?.showPublicly) && isCurrentSupporter(row, new Date());
  } catch (error) {
    logger.error('[support] supporter tag lookup failed', { userId, error });
    return false;
  }
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** The web's `sanitizeSupportSrc` rule: lowercase `[a-z0-9-]`, at most 40 characters. */
function sanitizeSrc(rawSrc: string | null | undefined): string | null {
  const cleaned = (rawSrc ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_SRC_LENGTH)
    .replace(/^-+|-+$/g, '');
  return cleaned || null;
}

export const supportQueries = {
  mySupporterStatus: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<MySupporterStatus | null> => {
    if (!ctx.isAuthenticated || !ctx.userId) return null;
    return toMySupporterStatus(await loadSupporter(ctx.userId), new Date());
  },

  publicSupporters: async (
    _: unknown,
    { limit, offset }: { limit?: number | null; offset?: number | null },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 120, 'publicSupporters');
    const pageLimit = Math.min(
      Math.max(Math.trunc(limit ?? DEFAULT_PUBLIC_SUPPORTERS_LIMIT), 1),
      MAX_PUBLIC_SUPPORTERS_LIMIT,
    );
    const pageOffset = Math.max(Math.trunc(offset ?? 0), 0);
    const rows = await db
      .select({
        userId: dbSchema.users.id,
        accountName: dbSchema.users.name,
        accountImage: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.stripeSupporters)
      .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.stripeSupporters.userId))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
      .where(and(eq(dbSchema.stripeSupporters.showPublicly, true), currentSupporterCondition(new Date())))
      .orderBy(desc(dbSchema.stripeSupporters.supportedAt), asc(dbSchema.stripeSupporters.userId))
      .limit(pageLimit)
      .offset(pageOffset);
    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.displayName || row.accountName || 'Climber',
      avatarUrl: row.avatarUrl || row.accountImage || null,
    }));
  },
};

export const supportMutations = {
  createSupportClaim: async (
    _: unknown,
    { cadence, currency, src }: { cadence: string; currency: string; src?: string | null },
    ctx: ConnectionContext,
  ): Promise<string> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'createSupportClaim');
    const normalizedCadence = cadence.trim().toLowerCase();
    if (normalizedCadence !== 'monthly' && normalizedCadence !== 'one_time') {
      throw badInput('cadence must be monthly or one_time');
    }
    const claimCurrency = supportedCurrency(currency.trim());
    if (!claimCurrency) throw badInput('currency must be aud or usd');

    const userId = ctx.userId!;
    const claimId = newSupportClaimId();
    await db.transaction(async (tx) => {
      // A claim nobody paid against is only a pointer; drop the stale ones so
      // abandoned clicks do not pile up. Ledgered claims (with a session) stay.
      await tx
        .delete(dbSchema.stripeSupportClaims)
        .where(
          and(
            eq(dbSchema.stripeSupportClaims.userId, userId),
            isNull(dbSchema.stripeSupportClaims.checkoutSessionId),
            lt(dbSchema.stripeSupportClaims.createdAt, new Date(Date.now() - UNUSED_CLAIM_TTL_MS)),
          ),
        );
      await tx.insert(dbSchema.stripeSupportClaims).values({
        id: claimId,
        userId,
        cadence: normalizedCadence,
        currency: claimCurrency,
        src: sanitizeSrc(src),
      });
    });
    return claimId;
  },

  updateSupporterVisibility: async (
    _: unknown,
    { showPublicly }: { showPublicly: boolean },
    ctx: ConnectionContext,
  ): Promise<MySupporterStatus> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'updateSupporterVisibility');
    // An upsert, so a climber can choose before their first payment lands.
    const [row] = await db
      .insert(dbSchema.stripeSupporters)
      .values({ userId: ctx.userId!, showPublicly })
      .onConflictDoUpdate({
        target: dbSchema.stripeSupporters.userId,
        set: { showPublicly, updatedAt: new Date() },
      })
      .returning();
    return toMySupporterStatus(row, new Date());
  },

  claimSupporterByEmail: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<MySupporterStatus> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'claimSupporterByEmail');
    if (!isStripeSupportConfigured()) {
      throw new GraphQLError('Supporter lookup is unavailable right now. Try again later.', {
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
    const [account] = await db
      .select({ emailVerified: dbSchema.users.emailVerified })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, ctx.userId!))
      .limit(1);
    if (!account) {
      throw new GraphQLError('Your account was not found. Sign in again.', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    if (!account.emailVerified) {
      throw new GraphQLError('Verify your email first, then try again.', {
        extensions: { code: 'EMAIL_NOT_VERIFIED' },
      });
    }
    const row = await claimSupporterByEmail(ctx.userId!);
    return toMySupporterStatus(row, new Date());
  },

  grantSupporter: async (
    _: unknown,
    { userId, source, creditUntil }: { userId: string; source: string; creditUntil: string },
    ctx: ConnectionContext,
  ): Promise<MySupporterStatus> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 30, 'grantSupporter');
    const grantSource = GRANTABLE_SOURCES.find((candidate) => candidate === source);
    if (!grantSource) {
      throw badInput('source must be github_sponsors or admin');
    }
    const until = new Date(creditUntil);
    if (Number.isNaN(until.getTime())) throw badInput('creditUntil must be an ISO 8601 date');

    const now = new Date();
    const row = await db.transaction(async (tx) => {
      if (!(await lockSupportAccount(tx, userId))) return null;
      const existing = await loadSupporterRow(tx, userId);
      // A future date only ever extends: a grant never cuts short tag time a
      // climber already has from their own gifts. A past date ends the credit,
      // which is how an admin revokes a grant. A Stripe supporter keeps the
      // 'stripe' source, so the grant does not hide where their support came from.
      const existingUntil = existing?.creditUntil ?? null;
      const creditUntil = until > now && existingUntil && existingUntil > until ? existingUntil : until;
      const values = {
        source: existing?.source === 'stripe' ? 'stripe' : grantSource,
        creditUntil,
        supportedAt: existing?.supportedAt ?? now,
        updatedAt: now,
      } as const;
      const [granted] = await tx
        .insert(dbSchema.stripeSupporters)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: dbSchema.stripeSupporters.userId, set: values })
        .returning();
      return granted;
    });
    if (!row) throw new GraphQLError('No account with that id.', { extensions: { code: 'NOT_FOUND' } });
    logger.info('[support] supporter granted by admin', { userId, source: grantSource, adminId: ctx.userId });
    return toMySupporterStatus(row, now);
  },
};
