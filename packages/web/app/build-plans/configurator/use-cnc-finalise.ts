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
import { useDocumentLocale } from '@/app/lib/i18n/document-locale-context';
import { applyLocale } from '@/app/lib/i18n/locale-href';
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

/** Build a local order path from the identifier; never follow a server URL. */
export function cncOrderPath(licenceId: unknown): string | null {
  if (typeof licenceId !== 'string' || licenceId.length !== 13 || !/^BS-CNC-[A-Z0-9]{6}$/.test(licenceId)) return null;
  return `/build-plans/orders/${licenceId}`;
}

export function useCncFinalise(authToken: string | null): CncFinaliseResult {
  const beginRequest = useCncRequestScope();
  const locale = useDocumentLocale();
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
        const orderPath = cncOrderPath(response.finaliseCncOrder.licenceId);
        if (!orderPath) {
          // Preserve the draft when the response cannot safely be opened.
          setErrorKey('generic');
          setIsFinalising(false);
          return;
        }
        // The order now carries the licence details; clear the browser draft
        // before opening its generation status.
        await removePreference(CNC_CONFIGURATOR_DRAFT_KEY);
        // Start a fresh document so the preview's React Query entry cannot
        // replace the newly queued/ready order fetched by the server.
        if (isCurrent()) window.location.assign(applyLocale(orderPath, locale));
      } catch (error) {
        if (isCurrent()) setErrorKey(cncErrorKey(error));
        if (isCurrent()) setIsFinalising(false);
      }
    },
    [authToken, beginRequest, locale],
  );

  return { finalise, isFinalising, errorKey };
}
