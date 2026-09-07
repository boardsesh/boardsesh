'use client';

import { useCallback, useState } from 'react';
import type { FinaliseCncOrderInput } from '@boardsesh/shared-schema';
import {
  FINALISE_CNC_ORDER,
  type FinaliseCncOrderMutationResponse,
  type FinaliseCncOrderMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { removePreference } from '@/app/lib/user-preferences-db';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';
import { CNC_CONFIGURATOR_DRAFT_KEY } from './configurator-state';

/**
 * Buy the preview the buyer has been looking at.
 *
 * Everything about the wall is already on the order — this call only attaches
 * who the licence names and opens the payment page for it. That is the whole
 * point of the preview-first flow: nobody can buy a pack they have not seen,
 * because the only way to reach this mutation is with an order id that came
 * back from a preview.
 *
 * Not a React Query mutation, deliberately: the success path leaves the app
 * entirely, so there is no cache to invalidate and no result to render. What is
 * left is a request, a pending flag and an error — which is this hook.
 *
 * `window.location.assign`, not `router.push`: `checkoutUrl` is a Stripe-hosted
 * page on another origin, and Next's router only knows about this one.
 *
 * `isFinalising` is never cleared on success. The navigation is already in
 * flight, and flipping the button back to "Finalise and buy" while the browser
 * is leaving invites a second click and a second Stripe session for one wall.
 */

export type CncFinaliseResult = {
  finalise: (input: FinaliseCncOrderInput) => Promise<void>;
  isFinalising: boolean;
  errorKey: CncErrorKey | null;
};

/**
 * The only third-party origin this hook will hand the browser to.
 *
 * `checkoutUrl` arrives from the backend, which builds it from Stripe's own
 * session response — but it is still a server-supplied string that goes
 * straight into `window.location`. Pinning the origin means a compromised or
 * misconfigured backend cannot turn Finalise into an open redirect onto a
 * phishing page that looks like a payment form.
 */
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

/**
 * `true` only for a well-formed URL on Stripe's hosted checkout origin, or on
 * this site itself.
 *
 * The `new URL()` parse is guarded because a malformed string throws, and a
 * throw here would escape as an unhandled rejection rather than showing the
 * buyer an error.
 */
export function isCheckoutRedirectUrl(url: string, siteOrigin: string | null = currentSiteOrigin()): boolean {
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

export function useCncFinalise(authToken: string | null): CncFinaliseResult {
  const [isFinalising, setIsFinalising] = useState(false);
  const [errorKey, setErrorKey] = useState<CncErrorKey | null>(null);

  const finalise = useCallback(
    async (input: FinaliseCncOrderInput) => {
      setErrorKey(null);
      setIsFinalising(true);
      try {
        const client = createGraphQLHttpClient(authToken);
        const response = await client.request<FinaliseCncOrderMutationResponse, FinaliseCncOrderMutationVariables>(
          FINALISE_CNC_ORDER,
          { input },
        );
        const { checkoutUrl } = response.finaliseCncOrder;
        if (!isCheckoutRedirectUrl(checkoutUrl)) {
          // Same generic error as any other failed finalise, and the draft is
          // deliberately left alone: nothing was charged, so the buyer should
          // find their configuration still there when they retry.
          setErrorKey('generic');
          setIsFinalising(false);
          return;
        }
        // The sale is on its way to Stripe: the draft has done its job, and a
        // buyer's name and email have no reason to sit in this browser's
        // IndexedDB once the order carries them. `removePreference` swallows
        // its own errors, so a failed wipe never blocks the redirect.
        await removePreference(CNC_CONFIGURATOR_DRAFT_KEY);
        window.location.assign(checkoutUrl);
      } catch (error) {
        setErrorKey(cncErrorKey(error));
        setIsFinalising(false);
      }
    },
    [authToken],
  );

  return { finalise, isFinalising, errorKey };
}
