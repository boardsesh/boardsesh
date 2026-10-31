/**
 * POST /webhooks/stripe against real PostgreSQL. Stripe's own signature code
 * runs for real (a test header is generated with the shared secret); only the
 * API calls the handler makes back to Stripe are mocked.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

const { subscriptionRetrieve } = vi.hoisted(() => ({ subscriptionRetrieve: vi.fn() }));
const realStripe = new Stripe('sk_test_webhook_signatures');

vi.mock('../services/stripe-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stripe-support')>()),
  getStripeClient: () => ({
    webhooks: realStripe.webhooks,
    subscriptions: { retrieve: subscriptionRetrieve },
  }),
}));

import { handleStripeWebhook, MAX_STRIPE_WEBHOOK_BYTES } from './stripe-webhook';
import { isCurrentSupporter } from '../services/supporter-status';

const WEBHOOK_SECRET = 'whsec_test_supporters';
const USER_ID = 'stripe-webhook-user';
const CLAIM_ID = `sc_${'a'.repeat(32)}`;
let eventCounter = 0;

type CheckoutOverrides = Partial<{
  id: string;
  client_reference_id: string | null;
  mode: 'payment' | 'subscription';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  currency: string;
  amount_total: number;
  customer: string | null;
  subscription: string | null;
}>;

function checkoutSession(overrides: CheckoutOverrides = {}) {
  return {
    id: 'cs_test_one',
    object: 'checkout.session',
    client_reference_id: CLAIM_ID,
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    currency: 'usd',
    amount_total: 2500,
    customer: 'cus_one',
    subscription: null,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    created: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function stripeEvent(type: string, object: Record<string, unknown>, id?: string) {
  eventCounter += 1;
  return {
    id: id ?? `evt_test_${eventCounter}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

function request(body: Buffer | string, headers: Record<string, string>): IncomingMessage {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  // Two chunks, so the raw-body reader has to join them.
  const middle = Math.floor(bytes.length / 2);
  const incoming = Readable.from([bytes.subarray(0, middle), bytes.subarray(middle)]) as unknown as IncomingMessage;
  Object.defineProperty(incoming, 'headers', { value: headers });
  return incoming;
}

function response() {
  const captured = { statusCode: 0, body: '' };
  const res = {
    writeHead: vi.fn((status: number) => {
      captured.statusCode = status;
      return res;
    }),
    end: vi.fn((chunk?: string) => {
      captured.body = chunk ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, captured };
}

function signed(payload: string, secret = WEBHOOK_SECRET): Record<string, string> {
  return { 'stripe-signature': realStripe.webhooks.generateTestHeaderString({ payload, secret }) };
}

async function deliver(event: object, options: { payload?: string; secret?: string } = {}) {
  const payload = options.payload ?? JSON.stringify(event);
  const { res, captured } = response();
  await handleStripeWebhook(request(payload, signed(payload, options.secret)), res);
  return captured;
}

async function supporterRow() {
  const [row] = await db.select().from(dbSchema.stripeSupporters).where(eq(dbSchema.stripeSupporters.userId, USER_ID));
  return row ?? null;
}

async function claimRows() {
  return db.select().from(dbSchema.stripeSupportClaims).where(eq(dbSchema.stripeSupportClaims.userId, USER_ID));
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_webhook');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  await db.delete(dbSchema.users).where(eq(dbSchema.users.id, USER_ID));
  await db.insert(dbSchema.users).values({ id: USER_ID, email: 'webhook@test.com', name: 'Webhook tester' });
  await db.insert(dbSchema.stripeSupportClaims).values({
    id: CLAIM_ID,
    userId: USER_ID,
    cadence: 'one_time',
    currency: 'usd',
    src: 'web-support',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /webhooks/stripe — fail closed', () => {
  it.each([
    ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY'],
    ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  ])('answers 503 and writes nothing when %s is unset', async (unset, kept) => {
    vi.stubEnv(unset, '');
    vi.stubEnv(kept, kept === 'STRIPE_WEBHOOK_SECRET' ? WEBHOOK_SECRET : 'sk_test_webhook');
    const captured = await deliver(stripeEvent('checkout.session.completed', checkoutSession()));
    expect(captured.statusCode).toBe(503);
    expect(await supporterRow()).toBeNull();
  });
});

describe('POST /webhooks/stripe — signature and raw body', () => {
  it('rejects a request with no signature header', async () => {
    const { res, captured } = response();
    await handleStripeWebhook(request('{}', {}), res);
    expect(captured.statusCode).toBe(400);
  });

  it('rejects a payload signed with another secret and writes nothing', async () => {
    const captured = await deliver(stripeEvent('checkout.session.completed', checkoutSession()), {
      secret: 'whsec_attacker',
    });
    expect(captured.statusCode).toBe(400);
    expect(await supporterRow()).toBeNull();
  });

  it('rejects a body changed after signing', async () => {
    const original = JSON.stringify(stripeEvent('checkout.session.completed', checkoutSession()));
    const tampered = original.replace('2500', '250000');
    const { res, captured } = response();
    await handleStripeWebhook(request(tampered, signed(original)), res);
    expect(captured.statusCode).toBe(400);
    expect(await supporterRow()).toBeNull();
  });

  it('verifies the exact bytes, so formatting a JSON parser would drop still checks out', async () => {
    // Pretty-printed with a multi-byte character split across the two chunks:
    // anything that parsed and re-serialised the body would break the signature.
    const event = stripeEvent('checkout.session.completed', checkoutSession());
    const payload = JSON.stringify({ ...event, note: 'Grüße 🧗' }, null, 2);
    const captured = await deliver(event, { payload });
    expect(captured.statusCode).toBe(200);
    expect((await supporterRow())?.creditUntil).not.toBeNull();
  });

  it('answers 413 for a body over the cap', async () => {
    const payload = 'x'.repeat(MAX_STRIPE_WEBHOOK_BYTES + 1);
    const { res, captured } = response();
    await handleStripeWebhook(request(payload, signed(payload)), res);
    expect(captured.statusCode).toBe(413);
  });
});

describe('POST /webhooks/stripe — one-off credit', () => {
  it('links an sc_ claim and adds whole months: US$25 is 2 months', async () => {
    const before = new Date();
    const captured = await deliver(stripeEvent('checkout.session.completed', checkoutSession()));
    expect(captured.statusCode).toBe(200);
    const row = await supporterRow();
    expect(row?.source).toBe('stripe');
    expect(row?.supportedAt).not.toBeNull();
    expect(row?.showPublicly).toBe(false);
    expect(monthsBetween(before, row!.creditUntil!)).toBe(2);
    expect(isCurrentSupporter(row, new Date())).toBe(true);
    const [claim] = await claimRows();
    expect(claim).toMatchObject({ id: CLAIM_ID, checkoutSessionId: 'cs_test_one', currency: 'usd' });
  });

  it.each([
    [1499, 0],
    [1500, 1],
    [4499, 2],
  ])('A$%i buys %i months', async (amount, months) => {
    const before = new Date();
    await deliver(
      stripeEvent('checkout.session.completed', checkoutSession({ currency: 'aud', amount_total: amount })),
    );
    const row = await supporterRow();
    expect(row?.supportedAt).not.toBeNull();
    if (months === 0) {
      expect(row?.creditUntil).toBeNull();
      expect(isCurrentSupporter(row, new Date())).toBe(false);
    } else {
      expect(monthsBetween(before, row!.creditUntil!)).toBe(months);
    }
  });

  it('stacks on credit that has not run out yet', async () => {
    const existingUntil = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 15, 12));
    await db.insert(dbSchema.stripeSupporters).values({
      userId: USER_ID,
      creditUntil: existingUntil,
      supportedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await deliver(stripeEvent('checkout.session.completed', checkoutSession({ amount_total: 1000 })));
    const row = await supporterRow();
    expect(row?.creditUntil?.toISOString()).toBe(
      new Date(Date.UTC(existingUntil.getUTCFullYear(), 3, 15, 12)).toISOString(),
    );
    expect(row?.supportedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('ignores a currency other than aud and usd, still answering 200', async () => {
    const captured = await deliver(
      stripeEvent('checkout.session.completed', checkoutSession({ currency: 'eur', amount_total: 5000 })),
    );
    expect(captured.statusCode).toBe(200);
    expect(await supporterRow()).toBeNull();
    expect((await claimRows())[0].checkoutSessionId).toBeNull();
  });

  it.each(['web-support', 'sc-not-a-claim', 'SC_' + 'a'.repeat(32), null])(
    'treats client_reference_id %s as a src tag and links nothing',
    async (clientReferenceId) => {
      const captured = await deliver(
        stripeEvent('checkout.session.completed', checkoutSession({ client_reference_id: clientReferenceId })),
      );
      expect(captured.statusCode).toBe(200);
      expect(await supporterRow()).toBeNull();
      expect((await claimRows())[0].checkoutSessionId).toBeNull();
    },
  );

  it('ignores an sc_ id that names no claim', async () => {
    const captured = await deliver(
      stripeEvent('checkout.session.completed', checkoutSession({ client_reference_id: `sc_${'f'.repeat(32)}` })),
    );
    expect(captured.statusCode).toBe(200);
    expect(await supporterRow()).toBeNull();
  });

  it('credits a replayed event once', async () => {
    const event = stripeEvent('checkout.session.completed', checkoutSession());
    await deliver(event);
    const first = (await supporterRow())!.creditUntil!.toISOString();
    expect((await deliver(event)).statusCode).toBe(200);
    expect((await supporterRow())!.creditUntil!.toISOString()).toBe(first);
    expect(await claimRows()).toHaveLength(1);
  });

  it('credits a session once across completed and async_payment_succeeded', async () => {
    await deliver(stripeEvent('checkout.session.completed', checkoutSession()));
    const first = (await supporterRow())!.creditUntil!.toISOString();
    await deliver(stripeEvent('checkout.session.async_payment_succeeded', checkoutSession()));
    expect((await supporterRow())!.creditUntil!.toISOString()).toBe(first);
  });

  it('credits two concurrent deliveries of one session once', async () => {
    const event = stripeEvent('checkout.session.completed', checkoutSession());
    await Promise.all([deliver(event), deliver(event)]);
    const row = await supporterRow();
    expect(monthsBetween(new Date(), row!.creditUntil!)).toBe(2);
    expect(await claimRows()).toHaveLength(1);
  });

  it('waits for async_payment_succeeded when a delayed method completes unpaid', async () => {
    await deliver(stripeEvent('checkout.session.completed', checkoutSession({ payment_status: 'unpaid' })));
    expect(await supporterRow()).toBeNull();
    await deliver(stripeEvent('checkout.session.async_payment_failed', checkoutSession({ payment_status: 'unpaid' })));
    expect(await supporterRow()).toBeNull();
    await deliver(stripeEvent('checkout.session.async_payment_succeeded', checkoutSession()));
    expect((await supporterRow())?.creditUntil).not.toBeNull();
  });

  it('records a second payment through the same claim as its own ledger row', async () => {
    await deliver(stripeEvent('checkout.session.completed', checkoutSession({ amount_total: 1000 })));
    await deliver(
      stripeEvent('checkout.session.completed', checkoutSession({ id: 'cs_test_two', amount_total: 1000 })),
    );
    const claims = await claimRows();
    expect(claims.map((claim) => claim.checkoutSessionId)).toEqual(
      expect.arrayContaining(['cs_test_one', 'cs_test_two']),
    );
    expect(claims).toHaveLength(2);
    expect(claims.every((claim) => claim.src === 'web-support')).toBe(true);
    expect(monthsBetween(new Date(), (await supporterRow())!.creditUntil!)).toBe(2);
  });
});

describe('POST /webhooks/stripe — monthly subscriptions', () => {
  function subscription(status: string, cancelAtPeriodEnd = false) {
    return {
      id: 'sub_one',
      object: 'subscription',
      customer: 'cus_one',
      status,
      cancel_at_period_end: cancelAtPeriodEnd,
    };
  }

  it('links the subscription on checkout and keeps its status in sync', async () => {
    subscriptionRetrieve.mockResolvedValue(subscription('active'));
    await deliver(
      stripeEvent(
        'checkout.session.completed',
        checkoutSession({ mode: 'subscription', subscription: 'sub_one', amount_total: 1500, currency: 'aud' }),
      ),
    );
    let row = await supporterRow();
    expect(row).toMatchObject({ stripeSubscriptionId: 'sub_one', subscriptionStatus: 'active', creditUntil: null });
    expect(isCurrentSupporter(row, new Date())).toBe(true);

    // The event body says active; Stripe's current answer (past_due) is what is stored.
    subscriptionRetrieve.mockResolvedValue(subscription('past_due', true));
    await deliver(stripeEvent('customer.subscription.updated', subscription('active')));
    row = await supporterRow();
    expect(row).toMatchObject({ subscriptionStatus: 'past_due', cancelAtPeriodEnd: true });
    expect(isCurrentSupporter(row, new Date())).toBe(true);

    subscriptionRetrieve.mockResolvedValue(subscription('canceled'));
    await deliver(stripeEvent('customer.subscription.deleted', subscription('canceled')));
    row = await supporterRow();
    expect(row?.subscriptionStatus).toBe('canceled');
    expect(isCurrentSupporter(row, new Date())).toBe(false);
  });

  it('leaves a subscription no account claimed alone', async () => {
    subscriptionRetrieve.mockResolvedValue(subscription('active'));
    const captured = await deliver(stripeEvent('customer.subscription.created', subscription('active')));
    expect(captured.statusCode).toBe(200);
    expect(subscriptionRetrieve).not.toHaveBeenCalled();
    expect(await supporterRow()).toBeNull();
  });

  it('answers 500 so Stripe retries when Stripe cannot be read back', async () => {
    subscriptionRetrieve.mockRejectedValue(new Error('Stripe unavailable'));
    const captured = await deliver(
      stripeEvent('checkout.session.completed', checkoutSession({ mode: 'subscription', subscription: 'sub_one' })),
    );
    expect(captured.statusCode).toBe(500);
    expect(await supporterRow()).toBeNull();
    // The retry links it.
    subscriptionRetrieve.mockResolvedValue(subscription('active'));
    const retried = await deliver(
      stripeEvent('checkout.session.completed', checkoutSession({ mode: 'subscription', subscription: 'sub_one' })),
    );
    expect(retried.statusCode).toBe(200);
    expect((await supporterRow())?.stripeSubscriptionId).toBe('sub_one');
  });
});
