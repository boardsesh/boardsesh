import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { CreateCncCheckoutSessionInput } from '@boardsesh/shared-schema';

const graphqlRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
}));

const removePreference = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference }));

const { useCncCheckout, isStripeCheckoutUrl, STRIPE_CHECKOUT_ORIGIN } =
  await import('../configurator/use-cnc-checkout');
const { CNC_CONFIGURATOR_DRAFT_KEY } = await import('../configurator/configurator-state');

const locationAssign = vi.fn();

const CHECKOUT_INPUT: CreateCncCheckoutSessionInput = {
  config: { boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: '26,27,28,29', options: {} },
  tier: 'personal',
  licenseeName: 'Sam Bouldering',
  licenseeEmail: 'sam@example.com',
  acceptLicence: true,
};

function checkoutUrlResponse(checkoutUrl: string) {
  return { createCncCheckoutSession: { orderId: '41', licenceId: 'BS-CNC-K7QM3T', checkoutUrl } };
}

/** A `graphql-request` ClientError, walked by shape rather than by `instanceof`. */
function graphqlError(code: string) {
  return { response: { errors: [{ message: 'nope', extensions: { code } }] } };
}

beforeEach(() => {
  graphqlRequest.mockReset();
  removePreference.mockReset().mockResolvedValue(undefined);
  locationAssign.mockReset();
  // jsdom's own `location` is not assignable; replace the whole object so the
  // hook's `window.location.assign(url)` is observable.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { assign: locationAssign, href: 'http://localhost/build-plans' },
  });
});

describe('isStripeCheckoutUrl', () => {
  it('accepts Stripe-hosted checkout, whatever the path and query carry', () => {
    expect(isStripeCheckoutUrl(`${STRIPE_CHECKOUT_ORIGIN}/c/pay/cs_test_a1b2c3#fidkd`)).toBe(true);
  });

  it('rejects every near-miss origin', () => {
    // The look-alikes that matter: a suffixed hostname, a subdomain of an
    // attacker's zone, plain http, and an entirely different site.
    for (const url of [
      'https://checkout.stripe.com.evil.example/c/pay/cs_test',
      'https://checkout.stripe.com.evil.example',
      'https://evil.example/checkout.stripe.com',
      'http://checkout.stripe.com/c/pay/cs_test',
      'https://dashboard.stripe.com/c/pay/cs_test',
    ]) {
      expect({ url, allowed: isStripeCheckoutUrl(url) }).toEqual({ url, allowed: false });
    }
  });

  it('accepts this site itself, which is where the dev-only bypass sends the buyer', () => {
    expect(
      isStripeCheckoutUrl(
        'https://boardsesh.test/build-plans/orders/BS-CNC-ABC234?checkout=success',
        'https://boardsesh.test',
      ),
    ).toBe(true);
    expect(isStripeCheckoutUrl('https://evil.example/build-plans/orders/BS-CNC-ABC234', 'https://boardsesh.test')).toBe(
      false,
    );
  });

  it('returns false rather than throwing on a URL that does not parse', () => {
    for (const url of ['', 'not a url', '/c/pay/cs_test', 'javascript:alert(1)']) {
      expect({ url, allowed: isStripeCheckoutUrl(url) }).toEqual({ url, allowed: false });
    }
  });
});

describe('useCncCheckout', () => {
  it('sends the browser to a Stripe checkout URL and wipes the saved draft', async () => {
    graphqlRequest.mockResolvedValue(checkoutUrlResponse(`${STRIPE_CHECKOUT_ORIGIN}/c/pay/cs_test_a1b2c3`));

    const { result } = renderHook(() => useCncCheckout('ws-token'));
    await act(async () => {
      await result.current.startCheckout(CHECKOUT_INPUT);
    });

    expect(locationAssign).toHaveBeenCalledWith(`${STRIPE_CHECKOUT_ORIGIN}/c/pay/cs_test_a1b2c3`);
    expect(removePreference).toHaveBeenCalledWith(CNC_CONFIGURATOR_DRAFT_KEY);
    expect(result.current.errorKey).toBeNull();
    // Never cleared on the success path: the navigation is already in flight,
    // and a re-enabled button is a second Stripe session for one wall.
    expect(result.current.isStarting).toBe(true);
  });

  it('refuses to navigate to a URL on any other origin', async () => {
    graphqlRequest.mockResolvedValue(checkoutUrlResponse('https://evil.example/c/pay/cs_test_a1b2c3'));

    const { result } = renderHook(() => useCncCheckout('ws-token'));
    await act(async () => {
      await result.current.startCheckout(CHECKOUT_INPUT);
    });

    expect(locationAssign).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.errorKey).toBe('generic'));
    expect(result.current.isStarting).toBe(false);
    // Nothing was charged, so the configuration the buyer typed must survive
    // for the retry.
    expect(removePreference).not.toHaveBeenCalled();
  });

  it('shows the same error for a malformed URL instead of throwing', async () => {
    graphqlRequest.mockResolvedValue(checkoutUrlResponse('https://'));

    const { result } = renderHook(() => useCncCheckout('ws-token'));
    // No rejection escapes: `startCheckout` resolves, which is what keeps this
    // off the unhandled-rejection path.
    await act(async () => {
      await expect(result.current.startCheckout(CHECKOUT_INPUT)).resolves.toBeUndefined();
    });

    expect(locationAssign).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.errorKey).toBe('generic'));
    expect(result.current.isStarting).toBe(false);
  });

  it('maps each backend error code to its own message key', async () => {
    for (const code of ['CNC_INVALID_CONFIG', 'CNC_WORKER_UNAVAILABLE', 'CNC_CHECKOUT_UNAVAILABLE']) {
      graphqlRequest.mockRejectedValueOnce(graphqlError(code));

      const { result } = renderHook(() => useCncCheckout('ws-token'));
      await act(async () => {
        await result.current.startCheckout(CHECKOUT_INPUT);
      });

      await waitFor(() => expect({ code, errorKey: result.current.errorKey }).toEqual({ code, errorKey: code }));
      expect(result.current.isStarting).toBe(false);
    }
  });

  it('falls back to the generic key for a transport failure', async () => {
    graphqlRequest.mockRejectedValue(new Error('fetch failed'));

    const { result } = renderHook(() => useCncCheckout('ws-token'));
    await act(async () => {
      await result.current.startCheckout(CHECKOUT_INPUT);
    });

    await waitFor(() => expect(result.current.errorKey).toBe('generic'));
    expect(locationAssign).not.toHaveBeenCalled();
  });
});
