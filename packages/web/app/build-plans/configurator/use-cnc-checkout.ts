'use client';

import { useCallback, useState } from 'react';
import type { CreateCncCheckoutSessionInput } from '@boardsesh/shared-schema';
import {
  CREATE_CNC_CHECKOUT_SESSION,
  type CreateCncCheckoutSessionMutationResponse,
  type CreateCncCheckoutSessionMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';

export type CncCheckoutResult = {
  startCheckout: (input: CreateCncCheckoutSessionInput) => Promise<void>;
  isStarting: boolean;
  errorKey: CncErrorKey | null;
};

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
        window.location.assign(response.createCncCheckoutSession.checkoutUrl);
      } catch (error) {
        setErrorKey(cncErrorKey(error));
        setIsStarting(false);
      }
    },
    [authToken],
  );

  return { startCheckout, isStarting, errorKey };
}
