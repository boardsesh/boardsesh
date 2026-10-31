/**
 * Supporter resolvers against real PostgreSQL; only Stripe's API is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../db/client';

const { sessionsList, customersList, subscriptionsList } = vi.hoisted(() => ({
  sessionsList: vi.fn(),
  customersList: vi.fn(),
  subscriptionsList: vi.fn(),
}));

vi.mock('../../services/stripe-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/stripe-support')>()),
  getStripeClient: () => ({
    checkout: { sessions: { list: sessionsList } },
    customers: { list: customersList },
    subscriptions: { list: subscriptionsList },
  }),
}));

import { resolveProfileSupporterTag, supportMutations, supportQueries, UNUSED_CLAIM_TTL_MS } from './support';
import { socialFollowQueries } from './social/follows';
import { extendCredit } from '../../services/supporter-status';

const SUPPORTER = 'support-resolver-supporter';
const OTHER = 'support-resolver-other';
const ADMIN = 'support-resolver-admin';
const VIEWER = 'support-resolver-viewer';
const ALL_USERS = [SUPPORTER, OTHER, ADMIN, VIEWER];
const DAY_MS = 86_400_000;

function ctx(userId?: string): ConnectionContext {
  return {
    connectionId: `support-${userId ?? 'anon'}`,
    isAuthenticated: Boolean(userId),
    userId,
  } as ConnectionContext;
}

async function supporterRow(userId = SUPPORTER) {
  const [row] = await db.select().from(dbSchema.stripeSupporters).where(eq(dbSchema.stripeSupporters.userId, userId));
  return row ?? null;
}

function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_email_one',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    currency: 'usd',
    amount_total: 3000,
    customer: 'cus_email',
    client_reference_id: 'web-support',
    created: Math.floor(Date.now() / 1000) - 3600,
    expires_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_resolvers');
  sessionsList.mockResolvedValue({ data: [], has_more: false });
  customersList.mockResolvedValue({ data: [] });
  subscriptionsList.mockResolvedValue({ data: [] });
  await db.delete(dbSchema.users).where(inArray(dbSchema.users.id, ALL_USERS));
  await db
    .insert(dbSchema.users)
    .values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: id, emailVerified: new Date() })));
  await db.insert(dbSchema.communityRoles).values({ userId: ADMIN, role: 'admin', boardType: null });
});

describe('mySupporterStatus', () => {
  it('is null when signed out', async () => {
    expect(await supportQueries.mySupporterStatus({}, {}, ctx())).toBeNull();
  });

  it('reports no support for a fresh account', async () => {
    expect(await supportQueries.mySupporterStatus({}, {}, ctx(SUPPORTER))).toEqual({
      isSupporter: false,
      showPublicly: false,
      source: null,
      creditUntil: null,
      hasSubscription: false,
      cancelAtPeriodEnd: false,
    });
  });

  it('reports a live subscription and its period-end cancellation', async () => {
    await db.insert(dbSchema.stripeSupporters).values({
      userId: SUPPORTER,
      stripeSubscriptionId: 'sub_status',
      subscriptionStatus: 'trialing',
      cancelAtPeriodEnd: true,
      supportedAt: new Date(),
    });
    expect(await supportQueries.mySupporterStatus({}, {}, ctx(SUPPORTER))).toMatchObject({
      isSupporter: true,
      source: 'stripe',
      hasSubscription: true,
      cancelAtPeriodEnd: true,
    });
  });
});

describe('createSupportClaim', () => {
  it('requires sign-in', async () => {
    await expect(
      supportMutations.createSupportClaim({}, { cadence: 'monthly', currency: 'aud' }, ctx()),
    ).rejects.toThrow('Authentication required');
  });

  it('returns an opaque sc_ id and stores the cadence, currency and cleaned src', async () => {
    const claimId = await supportMutations.createSupportClaim(
      {},
      { cadence: 'one_time', currency: 'USD', src: 'Mobile_Settings!!' },
      ctx(SUPPORTER),
    );
    expect(claimId).toMatch(/^sc_[0-9a-f]{32}$/);
    const [claim] = await db
      .select()
      .from(dbSchema.stripeSupportClaims)
      .where(eq(dbSchema.stripeSupportClaims.id, claimId));
    expect(claim).toMatchObject({
      userId: SUPPORTER,
      cadence: 'one_time',
      currency: 'usd',
      src: 'mobilesettings',
      checkoutSessionId: null,
    });
  });

  it.each([
    [{ cadence: 'weekly', currency: 'aud' }, 'cadence'],
    [{ cadence: 'monthly', currency: 'eur' }, 'currency'],
  ])('rejects %o', async (input, field) => {
    await expect(supportMutations.createSupportClaim({}, input, ctx(SUPPORTER))).rejects.toThrow(field);
  });

  it('prunes unused claims older than the TTL but keeps ledgered ones', async () => {
    const old = new Date(Date.now() - UNUSED_CLAIM_TTL_MS - DAY_MS);
    await db.insert(dbSchema.stripeSupportClaims).values([
      { id: 'sc_unused_old', userId: SUPPORTER, cadence: 'monthly', createdAt: old },
      { id: 'sc_ledgered_old', userId: SUPPORTER, cadence: 'one_time', createdAt: old, checkoutSessionId: 'cs_kept' },
      { id: 'sc_unused_recent', userId: SUPPORTER, cadence: 'monthly' },
    ]);
    const claimId = await supportMutations.createSupportClaim(
      {},
      { cadence: 'monthly', currency: 'aud' },
      ctx(SUPPORTER),
    );
    const ids = (
      await db
        .select({ id: dbSchema.stripeSupportClaims.id })
        .from(dbSchema.stripeSupportClaims)
        .where(eq(dbSchema.stripeSupportClaims.userId, SUPPORTER))
    )
      .map((row) => row.id)
      .sort();
    expect(ids).toEqual([claimId, 'sc_ledgered_old', 'sc_unused_recent'].sort());
  });
});

describe('updateSupporterVisibility and publicSupporters', () => {
  it('stores the choice before any payment, without making anyone a supporter', async () => {
    const status = await supportMutations.updateSupporterVisibility({}, { showPublicly: true }, ctx(SUPPORTER));
    expect(status).toMatchObject({ showPublicly: true, isSupporter: false, source: null });
    expect(await supportQueries.publicSupporters({}, {}, ctx())).toEqual([]);
  });

  it('lists only current supporters who opted in', async () => {
    const future = new Date(Date.now() + 30 * DAY_MS);
    await db.insert(dbSchema.stripeSupporters).values([
      { userId: SUPPORTER, showPublicly: true, creditUntil: future, supportedAt: new Date() },
      // Opted out.
      { userId: OTHER, showPublicly: false, creditUntil: future, supportedAt: new Date() },
      // Opted in but the credit ran out.
      { userId: VIEWER, showPublicly: true, creditUntil: new Date(Date.now() - DAY_MS), supportedAt: new Date() },
      // Opted in with a live subscription.
      {
        userId: ADMIN,
        showPublicly: true,
        stripeSubscriptionId: 'sub_listed',
        subscriptionStatus: 'past_due',
        supportedAt: new Date(Date.now() - DAY_MS),
      },
    ]);
    const listed = await supportQueries.publicSupporters({}, { limit: 10 }, ctx());
    expect(listed.map((supporter) => supporter.userId)).toEqual([SUPPORTER, ADMIN]);
    expect(listed[0]).toEqual({ userId: SUPPORTER, displayName: SUPPORTER, avatarUrl: null });

    await supportMutations.updateSupporterVisibility({}, { showPublicly: false }, ctx(SUPPORTER));
    const after = await supportQueries.publicSupporters({}, {}, ctx());
    expect(after.map((supporter) => supporter.userId)).toEqual([ADMIN]);
  });
});

describe('PublicUserProfile.isSupporter', () => {
  async function profileTag(viewer?: string) {
    const profile = await socialFollowQueries.publicProfile({}, { userId: SUPPORTER }, ctx(viewer));
    return profile?.isSupporter;
  }

  it('is true only while current and opted in', async () => {
    expect(await profileTag(VIEWER)).toBe(false);
    await db.insert(dbSchema.stripeSupporters).values({
      userId: SUPPORTER,
      showPublicly: false,
      creditUntil: new Date(Date.now() + DAY_MS),
      supportedAt: new Date(),
    });
    expect(await profileTag(VIEWER)).toBe(false);
    await db
      .update(dbSchema.stripeSupporters)
      .set({ showPublicly: true })
      .where(eq(dbSchema.stripeSupporters.userId, SUPPORTER));
    expect(await profileTag(VIEWER)).toBe(true);
    expect(await profileTag()).toBe(true);
    await db
      .update(dbSchema.stripeSupporters)
      .set({ creditUntil: new Date(Date.now() - 1000) })
      .where(eq(dbSchema.stripeSupporters.userId, SUPPORTER));
    expect(await profileTag(VIEWER)).toBe(false);
  });

  it('is false when the viewer cannot see the profile activity', async () => {
    await db.insert(dbSchema.stripeSupporters).values({
      userId: SUPPORTER,
      showPublicly: true,
      creditUntil: new Date(Date.now() + DAY_MS),
      supportedAt: new Date(),
    });
    await db.insert(dbSchema.userProfiles).values({ userId: SUPPORTER, isPrivate: true });
    expect(await profileTag(VIEWER)).toBe(false);
    // The supporter still sees their own tag.
    expect(await profileTag(SUPPORTER)).toBe(true);
  });

  it('is false, and logged, when the lookup fails', async () => {
    const select = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database gone');
    });
    expect(await resolveProfileSupporterTag(SUPPORTER, true)).toBe(false);
    select.mockRestore();
  });
});

describe('grantSupporter', () => {
  const until = new Date(Date.now() + 90 * DAY_MS).toISOString();

  it('is admin only', async () => {
    await expect(
      supportMutations.grantSupporter({}, { userId: SUPPORTER, source: 'admin', creditUntil: until }, ctx(OTHER)),
    ).rejects.toThrow('Admin role required');
    expect(await supporterRow()).toBeNull();
  });

  it('records a GitHub Sponsors grant until the given date', async () => {
    const status = await supportMutations.grantSupporter(
      {},
      { userId: SUPPORTER, source: 'github_sponsors', creditUntil: until },
      ctx(ADMIN),
    );
    expect(status).toMatchObject({ isSupporter: true, source: 'github_sponsors', creditUntil: until });
  });

  it('never shortens tag time the climber already has from gifts', async () => {
    const longer = new Date(Date.now() + 200 * DAY_MS);
    await db
      .insert(dbSchema.stripeSupporters)
      .values({ userId: SUPPORTER, creditUntil: longer, supportedAt: new Date() });
    const status = await supportMutations.grantSupporter(
      {},
      { userId: SUPPORTER, source: 'github_sponsors', creditUntil: until },
      ctx(ADMIN),
    );
    expect(status).toMatchObject({ isSupporter: true, source: 'stripe', creditUntil: longer.toISOString() });
  });

  it('ends the credit when given a past date', async () => {
    await supportMutations.grantSupporter({}, { userId: SUPPORTER, source: 'admin', creditUntil: until }, ctx(ADMIN));
    const past = new Date(Date.now() - DAY_MS).toISOString();
    const status = await supportMutations.grantSupporter(
      {},
      { userId: SUPPORTER, source: 'admin', creditUntil: past },
      ctx(ADMIN),
    );
    expect(status).toMatchObject({ isSupporter: false, creditUntil: past });
  });

  it.each([
    [{ source: 'stripe', creditUntil: until }, 'source'],
    [{ source: 'admin', creditUntil: 'not a date' }, 'creditUntil'],
  ])('rejects %o', async (input, field) => {
    await expect(supportMutations.grantSupporter({}, { userId: SUPPORTER, ...input }, ctx(ADMIN))).rejects.toThrow(
      field,
    );
  });

  it('answers NOT_FOUND for an unknown account', async () => {
    await expect(
      supportMutations.grantSupporter({}, { userId: 'nobody-here', source: 'admin', creditUntil: until }, ctx(ADMIN)),
    ).rejects.toThrow('No account');
  });
});

describe('claimSupporterByEmail', () => {
  it('rejects an unverified email', async () => {
    await db.update(dbSchema.users).set({ emailVerified: null }).where(eq(dbSchema.users.id, SUPPORTER));
    await expect(supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER))).rejects.toThrow('Verify your email');
    expect(sessionsList).not.toHaveBeenCalled();
  });

  it('fails closed without STRIPE_SECRET_KEY', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    await expect(supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER))).rejects.toThrow('unavailable');
  });

  it('credits each paid session once, however often it is claimed', async () => {
    sessionsList.mockResolvedValue({ data: [paidSession()], has_more: false });
    const first = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(first.isSupporter).toBe(true);
    expect(sessionsList).toHaveBeenCalledWith(
      expect.objectContaining({ customer_details: { email: `${SUPPORTER}@test.com` }, status: 'complete' }),
    );
    const second = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(second.creditUntil).toBe(first.creditUntil);
    const ledger = await db
      .select()
      .from(dbSchema.stripeSupportClaims)
      .where(eq(dbSchema.stripeSupportClaims.checkoutSessionId, 'cs_email_one'));
    expect(ledger).toHaveLength(1);
  });

  it('adds nothing for a gift whose months already ran out', async () => {
    const twoYearsAgo = Math.floor((Date.now() - 730 * DAY_MS) / 1000);
    sessionsList.mockResolvedValue({ data: [paidSession({ created: twoYearsAgo })], has_more: false });
    const status = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(status.isSupporter).toBe(false);
    expect((await supporterRow())?.supportedAt).not.toBeNull();
  });

  it('adds nothing for a session the webhook already counted', async () => {
    const webhookCreditUntil = new Date(Date.now() + 30 * DAY_MS);
    await db.insert(dbSchema.stripeSupportClaims).values({
      id: `sc_${'c'.repeat(32)}`,
      userId: SUPPORTER,
      cadence: 'one_time',
      currency: 'usd',
      checkoutSessionId: 'cs_email_one',
    });
    await db
      .insert(dbSchema.stripeSupporters)
      .values({ userId: SUPPORTER, creditUntil: webhookCreditUntil, supportedAt: new Date() });
    sessionsList.mockResolvedValue({ data: [paidSession()], has_more: false });
    const status = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(status.creditUntil).toBe(webhookCreditUntil.toISOString());
  });

  it('adds only the unused part of a found gift, even on top of newer credit', async () => {
    const now = Date.now();
    // US$60 paid 5 months ago buys 6 months, so about 1 month is left.
    const fiveMonthsAgo = new Date(now - 152 * DAY_MS);
    const leftMs = extendCredit(null, 6, fiveMonthsAgo).getTime() - now;
    // Newer credit (a gift the webhook linked today) runs 30 more days.
    const newerCreditUntil = new Date(now + 30 * DAY_MS);
    await db
      .insert(dbSchema.stripeSupporters)
      .values({ userId: SUPPORTER, creditUntil: newerCreditUntil, supportedAt: new Date() });
    sessionsList.mockResolvedValue({
      data: [paidSession({ amount_total: 6000, created: Math.floor(fiveMonthsAgo.getTime() / 1000) })],
      has_more: false,
    });
    await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    const creditUntil = (await supporterRow())!.creditUntil!.getTime();
    // Newer credit plus what was left, not newer credit plus six fresh months.
    expect(Math.abs(creditUntil - (newerCreditUntil.getTime() + leftMs))).toBeLessThan(60_000);
  });

  it('stacks several found gifts in payment order from their own dates', async () => {
    const now = Date.now();
    // Two US$10 gifts paid 20 and 10 days ago: the second starts when the first ends.
    const first = Math.floor((now - 20 * DAY_MS) / 1000);
    const second = Math.floor((now - 10 * DAY_MS) / 1000);
    sessionsList.mockResolvedValue({
      data: [
        paidSession({ id: 'cs_second', amount_total: 1000, created: second }),
        paidSession({ id: 'cs_first', amount_total: 1000, created: first }),
      ],
      has_more: false,
    });
    await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    const firstEnds = extendCredit(null, 1, new Date(first * 1000));
    const expected = extendCredit(firstEnds, 1, new Date(second * 1000));
    const creditUntil = (await supporterRow())!.creditUntil!.getTime();
    // Remaining time is measured from a clock read inside the resolver.
    expect(Math.abs(creditUntil - expected.getTime())).toBeLessThan(60_000);
  });

  it('does not link a subscription another account started with its own claim', async () => {
    await db
      .insert(dbSchema.stripeSupportClaims)
      .values({ id: `sc_${'d'.repeat(32)}`, userId: OTHER, cadence: 'monthly' });
    sessionsList.mockResolvedValue({
      data: [
        paidSession({
          id: 'cs_others_monthly',
          mode: 'subscription',
          subscription: 'sub_others',
          client_reference_id: `sc_${'d'.repeat(32)}`,
        }),
      ],
      has_more: false,
    });
    customersList.mockResolvedValue({ data: [{ id: 'cus_shared' }] });
    subscriptionsList.mockResolvedValue({
      data: [{ id: 'sub_others', customer: 'cus_shared', status: 'active', cancel_at_period_end: false, created: 1 }],
    });
    const status = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(status.hasSubscription).toBe(false);
    expect(await supporterRow()).toBeNull();
  });

  it('skips sessions in other currencies and sessions another account claimed', async () => {
    await db
      .insert(dbSchema.stripeSupportClaims)
      .values({ id: `sc_${'b'.repeat(32)}`, userId: OTHER, cadence: 'one_time' });
    sessionsList.mockResolvedValue({
      data: [
        paidSession({ id: 'cs_eur', currency: 'eur' }),
        paidSession({ id: 'cs_others', client_reference_id: `sc_${'b'.repeat(32)}` }),
      ],
      has_more: false,
    });
    const status = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(status.isSupporter).toBe(false);
    expect(await supporterRow()).toBeNull();
  });

  it('links a live subscription found under the email', async () => {
    customersList.mockResolvedValue({ data: [{ id: 'cus_monthly' }] });
    subscriptionsList.mockResolvedValue({
      data: [
        { id: 'sub_old', customer: 'cus_monthly', status: 'canceled', cancel_at_period_end: false, created: 1 },
        { id: 'sub_live', customer: 'cus_monthly', status: 'active', cancel_at_period_end: false, created: 2 },
      ],
    });
    const status = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(status).toMatchObject({ isSupporter: true, hasSubscription: true });
    expect((await supporterRow())?.stripeSubscriptionId).toBe('sub_live');
  });

  it('does not take a subscription already linked to another account', async () => {
    await db.insert(dbSchema.stripeSupporters).values({
      userId: OTHER,
      stripeSubscriptionId: 'sub_taken',
      subscriptionStatus: 'active',
      supportedAt: new Date(),
    });
    customersList.mockResolvedValue({ data: [{ id: 'cus_shared' }] });
    subscriptionsList.mockResolvedValue({
      data: [{ id: 'sub_taken', customer: 'cus_shared', status: 'active', cancel_at_period_end: false, created: 1 }],
    });
    const status = await supportMutations.claimSupporterByEmail({}, {}, ctx(SUPPORTER));
    expect(status.hasSubscription).toBe(false);
    expect((await supporterRow(OTHER))?.stripeSubscriptionId).toBe('sub_taken');
  });
});
