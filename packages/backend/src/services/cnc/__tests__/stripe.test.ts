// What the Stripe module is actually responsible for, with the SDK mocked out:
// the fail-closed configuration checks, and the exact shape of the one Checkout
// Session we ever create. The session params are worth asserting field by field
// because every one of them is load-bearing and none of them is visible in a
// test that only checks "a URL came back" — a dropped `metadata.orderId` means
// no order is ever queued, a dropped `automatic_tax` means unremitted GST.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { createSessionMock, constructEventMock, stripeConstructorMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  constructEventMock: vi.fn(),
  stripeConstructorMock: vi.fn(),
}));

vi.mock('stripe', () => {
  class StripeMock {
    checkout = { sessions: { create: createSessionMock } };
    webhooks = { constructEvent: constructEventMock };
    constructor(...args: unknown[]) {
      stripeConstructorMock(...args);
    }
  }
  return { default: StripeMock };
});

import {
  CncStripeSignatureError,
  CncStripeUnavailableError,
  constructWebhookEvent,
  createCheckoutSessionForOrder,
  getStripe,
  isStripeConfigured,
  isStripeWebhookConfigured,
  resetStripeClientForTests,
} from '../stripe';
import type { CncTierPrice } from '../catalog';

const PERSONAL_TIER: CncTierPrice = {
  tier: 'personal',
  priceCents: 14900,
  currency: 'AUD',
  stripePriceEnv: 'STRIPE_PRICE_CNC_PERSONAL',
};

const ORDER = { id: 42, licenceId: 'BS-CNC-ABC234' };

const ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_CNC_PERSONAL',
  'WEB_PUBLIC_URL',
  'BOARDSESH_URL',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  vi.clearAllMocks();
  resetStripeClientForTests();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  process.env.STRIPE_PRICE_CNC_PERSONAL = 'price_personal_123';
  process.env.WEB_PUBLIC_URL = 'https://www.boardsesh.com';
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStripeClientForTests();
});

describe('configuration', () => {
  it('is configured when the secret key is set', () => {
    expect(isStripeConfigured()).toBe(true);
    expect(isStripeWebhookConfigured()).toBe(true);
  });

  it('is not configured without a secret key', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isStripeConfigured()).toBe(false);
    expect(isStripeWebhookConfigured()).toBe(false);
  });

  it('separates the webhook half: a secret key without a webhook secret cannot verify', () => {
    // A deploy in this state can sell a pack and then never learn it was paid
    // for, so the two checks have to be able to disagree.
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(isStripeConfigured()).toBe(true);
    expect(isStripeWebhookConfigured()).toBe(false);
  });

  it('throws rather than constructing a client without a key', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => getStripe()).toThrow(CncStripeUnavailableError);
    expect(stripeConstructorMock).not.toHaveBeenCalled();
  });

  it('constructs the client once and reuses it', () => {
    getStripe();
    getStripe();
    expect(stripeConstructorMock).toHaveBeenCalledTimes(1);
    expect(stripeConstructorMock).toHaveBeenCalledWith('sk_test_fake');
  });
});

describe('createCheckoutSessionForOrder', () => {
  const create = () =>
    createCheckoutSessionForOrder({
      order: ORDER,
      tier: PERSONAL_TIER,
      successUrl: 'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234?checkout=success',
      cancelUrl: 'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234?checkout=cancelled',
      customerEmail: 'buyer@example.com',
    });

  it('builds the session Stripe is asked for', async () => {
    createSessionMock.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    await expect(create()).resolves.toEqual({
      sessionId: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });

    const [params] = createSessionMock.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({
      mode: 'payment',
      line_items: [{ price: 'price_personal_123', quantity: 1 }],
      success_url: 'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234?checkout=success',
      cancel_url: 'https://www.boardsesh.com/build-plans/orders/BS-CNC-ABC234?checkout=cancelled',
      customer_email: 'buyer@example.com',
      client_reference_id: 'BS-CNC-ABC234',
      metadata: { orderId: '42', licenceId: 'BS-CNC-ABC234' },
      payment_intent_data: { metadata: { orderId: '42', licenceId: 'BS-CNC-ABC234' } },
      consent_collection: { terms_of_service: 'required' },
      automatic_tax: { enabled: true },
      allow_promotion_codes: false,
    });
  });

  it('points the terms text at the published licence', async () => {
    createSessionMock.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    await create();

    const [params] = createSessionMock.mock.calls[0] as [
      { custom_text: { terms_of_service_acceptance: { message: string } } },
    ];
    expect(params.custom_text.terms_of_service_acceptance.message).toBe(
      'I accept the Boardsesh manufacturing licence for this build (one wall). ' +
        'Terms: https://www.boardsesh.com/build-plans/licence',
    );
  });

  it('expires the session at least 30 minutes out, in whole seconds', async () => {
    createSessionMock.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const before = Math.floor(Date.now() / 1000);
    await create();

    const [params] = createSessionMock.mock.calls[0] as [{ expires_at: number }];
    // Stripe's floor is 30 minutes measured against ITS clock when the request
    // lands, so sending exactly now+1800 is rejected the moment latency eats a
    // second of it. The cushion is what this asserts.
    expect(params.expires_at).toBeGreaterThan(before + 30 * 60);
    expect(params.expires_at).toBeLessThanOrEqual(before + 32 * 60);
    expect(Number.isInteger(params.expires_at)).toBe(true);
  });

  it('refuses a tier whose price env is unset rather than charging the wrong amount', async () => {
    delete process.env.STRIPE_PRICE_CNC_PERSONAL;
    await expect(create()).rejects.toThrow(CncStripeUnavailableError);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('wraps a Stripe API failure', async () => {
    createSessionMock.mockRejectedValue(new Error('card_declined'));
    await expect(create()).rejects.toThrow(CncStripeUnavailableError);
  });

  it('treats a session with no hosted URL as an outage', async () => {
    // There is nowhere to send the buyer, so the order must not be left
    // looking sold.
    createSessionMock.mockResolvedValue({ id: 'cs_test_1', url: null });
    await expect(create()).rejects.toThrow(CncStripeUnavailableError);
  });
});

describe('constructWebhookEvent', () => {
  it('returns the verified event', () => {
    const event = { id: 'evt_1', type: 'checkout.session.completed' };
    constructEventMock.mockReturnValue(event);

    expect(constructWebhookEvent('{"raw":true}', 't=1,v1=sig')).toBe(event);
    expect(constructEventMock).toHaveBeenCalledWith('{"raw":true}', 't=1,v1=sig', 'whsec_fake');
  });

  it('rejects a missing signature header before calling Stripe', () => {
    expect(() => constructWebhookEvent('{}', undefined)).toThrow(CncStripeSignatureError);
    expect(constructEventMock).not.toHaveBeenCalled();
  });

  it('turns a verification failure into a signature error', () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    expect(() => constructWebhookEvent('{}', 't=1,v1=bad')).toThrow(CncStripeSignatureError);
  });

  it('will not verify without a webhook secret', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => constructWebhookEvent('{}', 't=1,v1=sig')).toThrow(CncStripeUnavailableError);
  });
});
