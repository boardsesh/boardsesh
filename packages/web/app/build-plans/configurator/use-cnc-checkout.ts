'use client';

import { useCallback, useState } from 'react';
import type { CreateCncCheckoutSessionInput } from '@boardsesh/shared-schema';
import {
  CREATE_CNC_CHECKOUT_SESSION,
  type CreateCncCheckoutSessionMutationResponse,
  type CreateCncCheckoutSessionMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { removePreference } from '@/app/lib/user-preferences-db';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';
import { CNC_CONFIGURATOR_DRAFT_KEY } from './configurator-state';

export type CncCheckoutResult = {
  startCheckout: (input: CreateCncCheckoutSessionInput) => Promise<void>;
  isStarting: boolean;
  errorKey: CncErrorKey | null;
};

/**
 * The only origin this hook will hand the browser to.
 *
 * `checkoutUrl` arrives from the backend, which builds it from Stripe's own
 * session response — but it is still a server-supplied string that goes
 * straight into `window.location`. Pinning the origin means a compromised or
 * misconfigured backend cannot turn the Buy button into an open redirect onto
 * a phishing page that looks like a payment form.
 */
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

/**
 * `true` only for a well-formed URL on Stripe's hosted checkout origin.
 *
 * The `new URL()` parse is guarded because a malformed string throws, and a
 * throw here would escape as an unhandled rejection rather than showing the
 * buyer an error.
 */
export function isStripeCheckoutUrl(url: string, siteOrigin: string | null = currentSiteOrigin()): boolean {
  try {
    const { origin } = new URL(url);
    if (origin === STRIPE_CHECKOUT_ORIGIN) return true;
    // The dev-only checkout bypass (`CNC_CHECKOUT_BYPASS`, see
    // docs/cnc-packs.md) skips Stripe and sends the buyer straight to their
    // order page on this site. Our own origin is the only other place a
    // checkout URL may point.
    return siteOrigin !== null && siteOrigin !== 'null' && origin === siteOrigin;
  } catch {
    return false;
  }
}

function currentSiteOrigin(): string | null {
  return typeof window === 'undefined' ? null : window.location.origin;
}

/**
 * Open Stripe Checkout for a configured pack.
 *
 * Not a React Query mutation, deliberately: the success path leaves the app
 * entirely, so there is no cache to invalidate and no result to render. What is
 * left is a request, a pending flag and an error — which is this hook.
 *
 * `window.location.assign`, not `router.push`: `checkoutUrl` is a Stripe-hosted
 * page on another origin, and Next's router only knows about this one.
 *
 * `isStarting` is never cleared on success. The navigation is already in
 * flight, and flipping the button back to "Buy" while the browser is leaving
 * invites a second click and a second Stripe session for one wall.
 */
export function useCncCheckout(authToken: string | null): CncCheckoutResult {
  const [isStarting, setIsStarting] = useState(false);
  const [errorKey, setErrorKey] = useState<CncErrorKey | null>(null);

  const startCheckout = useCallback(
    async (input: CreateCncCheckoutSessionInput) => {
      setErrorKey(null);
      setIsStarting(true);
      try {
        const client = createGraphQLHttpClient(authToken);
        const response = await client.request<
          CreateCncCheckoutSessionMutationResponse,
          CreateCncCheckoutSessionMutationVariables
        >(CREATE_CNC_CHECKOUT_SESSION, { input });
        const { checkoutUrl } = response.createCncCheckoutSession;
        if (!isStripeCheckoutUrl(checkoutUrl)) {
          // Same generic error as any other failed start, and the draft is
          // deliberately left alone: nothing was charged, so the buyer should
          // find their configuration still there when they retry.
          setErrorKey('generic');
          setIsStarting(false);
          return;
        }
        // The sale is confirmed: the draft has done its job, and a buyer's name
        // and email have no reason to sit in this browser's IndexedDB once
        // Stripe has the order. `removePreference` swallows its own errors, so
        // a failed wipe never blocks the redirect that follows it.
        await removePreference(CNC_CONFIGURATOR_DRAFT_KEY);
        window.location.assign(checkoutUrl);
      } catch (error) {
        setErrorKey(cncErrorKey(error));
        setIsStarting(false);
      }
    },
    [authToken],
  );

  return { startCheckout, isStarting, errorKey };
}
