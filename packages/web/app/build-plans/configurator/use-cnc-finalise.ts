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
import { useCncRequestScope } from '../use-cnc-request-scope';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';
import { CNC_CONFIGURATOR_DRAFT_KEY } from './configurator-state';

/**
 * Confirm the preview's licence and queue its free build pack.
 * Keep the action pending until navigation completes to prevent duplicate clicks.
 */
export type CncFinaliseResult = {
  finalise: (input: FinaliseCncOrderInput) => Promise<void>;
  isFinalising: boolean;
  errorKey: CncErrorKey | null;
};

/** Only navigate to an order page on this site, never a payment provider. */
export function isCheckoutRedirectUrl(url: string, siteOrigin: string | null = currentSiteOrigin()): boolean {
  try {
    const { origin, pathname } = new URL(url);
    return (
      siteOrigin !== null &&
      siteOrigin !== 'null' &&
      origin === siteOrigin &&
      /^\/build-plans\/orders\/BS-CNC-[A-Z0-9]+$/.test(pathname)
    );
  } catch {
    return false;
  }
}

function currentSiteOrigin(): string | null {
  return typeof window === 'undefined' ? null : window.location.origin;
}

export function useCncFinalise(authToken: string | null): CncFinaliseResult {
  const beginRequest = useCncRequestScope();
  const [isFinalising, setIsFinalising] = useState(false);
  const [errorKey, setErrorKey] = useState<CncErrorKey | null>(null);

  const finalise = useCallback(
    async (input: FinaliseCncOrderInput) => {
      const isCurrent = beginRequest();
      if (!isCurrent()) return;
      setErrorKey(null);
      setIsFinalising(true);
      try {
        const client = createGraphQLHttpClient(authToken);
        const response = await client.request<FinaliseCncOrderMutationResponse, FinaliseCncOrderMutationVariables>(
          FINALISE_CNC_ORDER,
          { input },
        );
        if (!isCurrent()) return;
        const { checkoutUrl } = response.finaliseCncOrder;
        if (!isCheckoutRedirectUrl(checkoutUrl)) {
          // Preserve the draft when the response cannot safely be opened.
          setErrorKey('generic');
          setIsFinalising(false);
          return;
        }
        // The order now carries the licence details; clear the browser draft
        // before opening its generation status.
        await removePreference(CNC_CONFIGURATOR_DRAFT_KEY);
        if (isCurrent()) window.location.assign(checkoutUrl);
      } catch (error) {
        if (isCurrent()) setErrorKey(cncErrorKey(error));
        if (isCurrent()) setIsFinalising(false);
      }
    },
    [authToken, beginRequest],
  );

  return { finalise, isFinalising, errorKey };
}
