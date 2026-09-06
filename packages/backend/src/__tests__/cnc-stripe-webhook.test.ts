// Real-database tests for the Stripe webhook, because every property worth
// testing here is a property of the database:
//
//  * Idempotency is a primary-key conflict on `cnc_stripe_events`, not
//    application logic. Mocking the insert would test nothing.
//  * "Already queued" and "already moved on" are zero-row results from
//    `transitionOrder`'s conditional UPDATE. A mocked order layer would happily
//    let a redelivery re-queue a paid pack.
//
// Payloads are signed with the real `stripe` SDK's `generateTestHeaderString`,
// so the signature path under test is the production one — no mock stands in
// for the thing that authenticates every request this route accepts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { cncOrders, cncStripeEvents, type CncOrder } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { createPendingOrder, transitionOrder } from '../services/cnc/orders';
import { resetStripeClientForTests } from '../services/cnc/stripe';
import { handleCncStripeWebhook } from '../handlers/cnc-stripe-webhook';

// The purchase announcement is a best-effort consequence of a payment that is
// already durable; asserting it fired is enough, and neither SMTP nor PostHog
// belongs in a database test.
const { sendOrderReceivedMock, captureEventMock } = vi.hoisted(() => ({
  sendOrderReceivedMock: vi.fn(async (_input: { to: string }) => {}),
  captureEventMock: vi.fn(() => true),
}));

vi.mock('../email/cnc-emails', () => ({ sendCncOrderReceivedEmail: sendOrderReceivedMock }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: captureEventMock }));

const WEBHOOK_SECRET = 'whsec_test_cnc_webhook';
const BUYER_ID = 'cnc-webhook-buyer';
const SECOND_BUYER_ID = 'cnc-webhook-buyer-2';

const savedEnv = new Map<string, string | undefined>();

type TestResponse = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  writeHead: (statusCode: number, headers?: Record<string, string | string[]>) => void;
  end: (body?: string) => void;
};

/**
 * A stream that is enough of an `IncomingMessage` for `readJsonBody`, which
 * only ever reads `data`/`end`/`error` plus the headers. Cast rather than
 * faked whole: the alternative is 13 properties of noise that no assertion
 * would ever touch.
 */
function makeRequest(body: string, headers: Record<string, string> = {}, method = 'POST'): IncomingMessage {
  // Buffer chunks, not strings: `readJsonBody` concatenates with
  // `Buffer.concat`, exactly as a real socket delivers them.
  return Object.assign(Readable.from([Buffer.from(body, 'utf8')]), { method, headers }) as unknown as IncomingMessage;
}

function makeResponse(): TestResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(body = '') {
      this.body += body;
    },
  };
}

function signed(payload: unknown): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET }),
    },
  };
}

/** Post a signed event and return the response. */
async function deliver(payload: unknown): Promise<TestResponse> {
  const { body, headers } = signed(payload);
  const res = makeResponse();
  await handleCncStripeWebhook(makeRequest(body, headers), res as unknown as ServerResponse);
  return res;
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt_test_${String(eventCounter)}_${String(Date.now())}`;
}

function completedEvent(order: CncOrder, overrides: Record<string, unknown> = {}, type = 'checkout.session.completed') {
  return {
    id: nextEventId(),
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_test_${String(order.id)}`,
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: `pi_test_${String(order.id)}`,
        amount_total: 14900,
        // AUD, 10% inclusive of the total. Not a real GST computation — just
        // clean numbers the amount_excluding_tax_cents assertion can check.
        total_details: { amount_tax: 1490 },
        currency: 'aud',
        metadata: { orderId: String(order.id), licenceId: order.licenceId },
        ...overrides,
      },
    },
  };
}

/** A `checkout.session.expired`-shaped event, or its async-payment-failed twin. */
function unpaidSessionEvent(
  order: CncOrder,
  type: 'checkout.session.expired' | 'checkout.session.async_payment_failed',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: nextEventId(),
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_test_${String(order.id)}`,
        object: 'checkout.session',
        payment_status: 'unpaid',
        metadata: { orderId: String(order.id), licenceId: order.licenceId },
        ...overrides,
      },
    },
  };
}

async function insertUser(userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${userId + '@test.com'}, ${'Buyer ' + userId}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function clearFixtures(): Promise<void> {
  await db.execute(
    sql`DELETE FROM "cnc_stripe_events" WHERE "order_id" IN (SELECT id FROM "cnc_orders" WHERE "user_id" IN (${BUYER_ID}, ${SECOND_BUYER_ID})) OR "id" LIKE 'evt_test_%'`,
  );
  await db.execute(sql`DELETE FROM "cnc_orders" WHERE "user_id" IN (${BUYER_ID}, ${SECOND_BUYER_ID})`);
  await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${BUYER_ID}, ${SECOND_BUYER_ID})`);
}

async function createOrder(userId = BUYER_ID): Promise<CncOrder> {
  return createPendingOrder({
    userId,
    tier: 'personal',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: { sheetStock: '2440x1220', panelThicknessMm: 18 },
    licenseeName: 'Test Buyer',
    licenseeEmail: 'buyer@example.com',
    licenceAcceptedAt: new Date(),
    currency: 'AUD',
    amountCents: 14900,
  });
}

async function readOrder(orderId: number): Promise<CncOrder> {
  const [order] = await db.select().from(cncOrders).where(eq(cncOrders.id, orderId)).limit(1);
  if (!order) throw new Error(`order ${String(orderId)} vanished`);
  return order;
}

beforeAll(async () => {
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const) savedEnv.set(key, process.env[key]);
  // A syntactically valid test key. Nothing here reaches Stripe's API — only
  // the local signature verification, which needs a constructed client.
  process.env.STRIPE_SECRET_KEY = 'sk_test_cnc_webhook';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  resetStripeClientForTests();
  await insertUser(BUYER_ID);
  await insertUser(SECOND_BUYER_ID);
});

afterAll(async () => {
  await clearFixtures();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStripeClientForTests();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.execute(
    sql`DELETE FROM "cnc_stripe_events" WHERE "order_id" IN (SELECT id FROM "cnc_orders" WHERE "user_id" IN (${BUYER_ID}, ${SECOND_BUYER_ID})) OR "id" LIKE 'evt_test_%'`,
  );
  await db.execute(sql`DELETE FROM "cnc_orders" WHERE "user_id" IN (${BUYER_ID}, ${SECOND_BUYER_ID})`);
});

describe('POST /api/cnc/stripe/webhook', () => {
  it('rejects an unsigned body with 400', async () => {
    const res = makeResponse();
    await handleCncStripeWebhook(
      makeRequest(JSON.stringify({ id: 'evt_unsigned', type: 'checkout.session.completed' })),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body signed with the wrong secret with 400', async () => {
    const body = JSON.stringify({ id: 'evt_wrong_secret', type: 'checkout.session.completed' });
    const res = makeResponse();
    await handleCncStripeWebhook(
      makeRequest(body, {
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_not_ours' }),
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    // Nothing was recorded: a body that did not come from Stripe never reaches
    // the idempotency table, or a redelivery of the real event would be eaten.
    const [recorded] = await db.select().from(cncStripeEvents).where(eq(cncStripeEvents.id, 'evt_wrong_secret'));
    expect(recorded).toBeUndefined();
  });

  it('rejects a non-POST with 405', async () => {
    const res = makeResponse();
    await handleCncStripeWebhook(makeRequest('', {}, 'GET'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(405);
  });

  it('queues a paid order and stamps when it was paid', async () => {
    const order = await createOrder();
    const event = completedEvent(order);

    const res = await deliver(event);

    expect(res.statusCode).toBe(200);
    const updated = await readOrder(order.id);
    expect(updated.status).toBe('queued');
    expect(updated.paidAt).toBeInstanceOf(Date);
    // Stripe's clock, not ours: a redelivery days later must not backdate or
    // forward-date the payment.
    expect(updated.paidAt?.getTime()).toBe(event.created * 1000);
    expect(updated.queuedAt).toBeInstanceOf(Date);
    expect(updated.stripePaymentIntentId).toBe(`pi_test_${String(order.id)}`);
    expect(updated.amountCents).toBe(14900);
    expect(updated.currency).toBe('AUD');
    // Two receipts: the signed-in account (inserted with `<userId>@test.com`)
    // and the buyer-typed licenseeEmail, which the fixture sets to a
    // different address on purpose.
    expect(sendOrderReceivedMock).toHaveBeenCalledTimes(2);
    const recipients = sendOrderReceivedMock.mock.calls.map(([input]) => input.to).sort();
    expect(recipients).toEqual([`${BUYER_ID}@test.com`, 'buyer@example.com'].sort());
    expect(captureEventMock).toHaveBeenCalledWith(
      'Build Plans Pack Purchased',
      expect.objectContaining({
        properties: expect.objectContaining({ amount_cents: 14900, amount_excluding_tax_cents: 13410 }),
      }),
    );
  });

  it('sends only one receipt when the account email and the licensee email are the same', async () => {
    const order = await createPendingOrder({
      userId: BUYER_ID,
      tier: 'personal',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27,28,29',
      options: { sheetStock: '2440x1220', panelThicknessMm: 18 },
      licenseeName: 'Test Buyer',
      // Matches the account email inserted by `insertUser` for BUYER_ID.
      licenseeEmail: `${BUYER_ID}@test.com`,
      licenceAcceptedAt: new Date(),
      currency: 'AUD',
      amountCents: 14900,
    });

    await deliver(completedEvent(order));

    expect(sendOrderReceivedMock).toHaveBeenCalledTimes(1);
  });

  it('treats a redelivered event id as a no-op', async () => {
    const order = await createOrder();
    const event = completedEvent(order);

    await deliver(event);
    vi.clearAllMocks();
    const second = await deliver(event);

    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ received: true, duplicate: true });
    // The buyer is emailed once, not once per Stripe retry.
    expect(sendOrderReceivedMock).not.toHaveBeenCalled();
    expect(captureEventMock).not.toHaveBeenCalled();
  });

  it('does nothing when a different event completes an already-queued order', async () => {
    const order = await createOrder();
    await deliver(completedEvent(order));
    const afterFirst = await readOrder(order.id);
    vi.clearAllMocks();

    // Same order, new event id — so the idempotency gate lets it through and
    // the conditional UPDATE is the only thing standing between a redelivery
    // and a re-queued pack.
    const res = await deliver(completedEvent(order, { amount_total: 999 }));

    expect(res.statusCode).toBe(200);
    const afterSecond = await readOrder(order.id);
    expect(afterSecond.status).toBe('queued');
    expect(afterSecond.amountCents).toBe(14900);
    expect(afterSecond.queuedAt?.getTime()).toBe(afterFirst.queuedAt?.getTime());
    expect(sendOrderReceivedMock).not.toHaveBeenCalled();
  });

  it('ignores a completed session whose licence id does not match the order', async () => {
    const order = await createOrder();

    const res = await deliver(
      completedEvent(order, { metadata: { orderId: String(order.id), licenceId: 'BS-CNC-ZZZZZZ' } }),
    );

    expect(res.statusCode).toBe(200);
    expect((await readOrder(order.id)).status).toBe('pending_payment');
    expect(sendOrderReceivedMock).not.toHaveBeenCalled();
  });

  it('ignores a completed session that was not actually paid', async () => {
    const order = await createOrder();

    const res = await deliver(completedEvent(order, { payment_status: 'unpaid' }));

    expect(res.statusCode).toBe(200);
    expect((await readOrder(order.id)).status).toBe('pending_payment');
  });

  it('cancels the order when the checkout session expires', async () => {
    const order = await createOrder();

    const res = await deliver({
      id: nextEventId(),
      object: 'event',
      type: 'checkout.session.expired',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_${String(order.id)}`,
          object: 'checkout.session',
          payment_status: 'unpaid',
          metadata: { orderId: String(order.id), licenceId: order.licenceId },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect((await readOrder(order.id)).status).toBe('cancelled');
  });

  it('queues a paid order on async_payment_succeeded, exactly like a paid checkout.session.completed', async () => {
    const order = await createOrder();
    const event = completedEvent(order, {}, 'checkout.session.async_payment_succeeded');

    const res = await deliver(event);

    expect(res.statusCode).toBe(200);
    const updated = await readOrder(order.id);
    expect(updated.status).toBe('queued');
    // This event's own `created`, not the original session-completed moment
    // (there wasn't one here) and not wall-clock time.
    expect(updated.paidAt?.getTime()).toBe(event.created * 1000);
    expect(updated.stripePaymentIntentId).toBe(`pi_test_${String(order.id)}`);
    expect(sendOrderReceivedMock).toHaveBeenCalled();
    expect(captureEventMock).toHaveBeenCalledWith('Build Plans Pack Purchased', expect.anything());
  });

  it('cancels the order on async_payment_failed, the same as an expired checkout', async () => {
    const order = await createOrder();

    const res = await deliver(unpaidSessionEvent(order, 'checkout.session.async_payment_failed'));

    expect(res.statusCode).toBe(200);
    expect((await readOrder(order.id)).status).toBe('cancelled');
    expect(sendOrderReceivedMock).not.toHaveBeenCalled();
  });

  it('refunds a paid order found by its payment intent', async () => {
    const order = await createOrder();
    await deliver(completedEvent(order));
    vi.clearAllMocks();

    const res = await deliver({
      id: nextEventId(),
      object: 'event',
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_test_${String(order.id)}`,
          object: 'charge',
          payment_intent: `pi_test_${String(order.id)}`,
          refunded: true,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const refunded = await readOrder(order.id);
    expect(refunded.status).toBe('refunded');
    expect(refunded.refundedAt).toBeInstanceOf(Date);
  });

  it('refunds an order that has already generated', async () => {
    const order = await createOrder();
    await deliver(completedEvent(order));
    // Walk the row to `ready` the way the worker would, so the refund is
    // exercised from the state a real refund usually arrives in.
    await transitionOrder(order.id, 'claim', { claimToken: 'token-1', workerId: 'worker-1', attempts: 1 });
    await transitionOrder(order.id, 'complete', { generatedAt: new Date(), zipKey: 'cnc-packs/x.zip' });
    expect((await readOrder(order.id)).status).toBe('ready');

    await deliver({
      id: nextEventId(),
      object: 'event',
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_test_ready_${String(order.id)}`,
          object: 'charge',
          payment_intent: `pi_test_${String(order.id)}`,
          refunded: true,
        },
      },
    });

    expect((await readOrder(order.id)).status).toBe('refunded');
  });

  it('acknowledges a refund for a charge that is not ours', async () => {
    const res = await deliver({
      id: nextEventId(),
      object: 'event',
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: 'ch_someone_else', object: 'charge', payment_intent: 'pi_someone_else', refunded: true },
      },
    });

    // 200, not an error: every charge on the Stripe account lands here, and
    // most of them have nothing to do with build packs.
    expect(res.statusCode).toBe(200);
  });

  it('records and acknowledges an event type it does not act on', async () => {
    const eventId = nextEventId();
    const res = await deliver({
      id: eventId,
      object: 'event',
      type: 'payment_intent.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'pi_ignored', object: 'payment_intent' } },
    });

    expect(res.statusCode).toBe(200);
    const [recorded] = await db.select().from(cncStripeEvents).where(eq(cncStripeEvents.id, eventId));
    // Marked processed even though nothing changed: "handled" means "will never
    // be acted on again", not "changed something".
    expect(recorded?.processedAt).toBeInstanceOf(Date);
    expect(recorded?.orderId).toBeNull();
  });
});
