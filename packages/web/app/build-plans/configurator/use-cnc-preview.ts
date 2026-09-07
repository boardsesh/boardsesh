'use client';

import { useCallback, useState } from 'react';
import type { CncBoardConfigInput, CncOrder } from '@boardsesh/shared-schema';
import {
  CREATE_CNC_DOWNLOAD_GRANT,
  CREATE_CNC_PREVIEW,
  type CreateCncDownloadGrantMutationResponse,
  type CreateCncDownloadGrantMutationVariables,
  type CreateCncPreviewMutationResponse,
  type CreateCncPreviewMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient, getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';

/**
 * Ask for a free watermarked preview of the wall on screen, and hand out the
 * link to its PDF.
 *
 * Both halves of "look before you buy" live here because they are the same
 * conversation: the mutation makes the preview, the grant hands the buyer the
 * sheets it produced, and neither is a purchase. Finalising is the other hook.
 *
 * Not a React Query mutation: nothing here has a cache entry to invalidate. The
 * order it returns is handed straight to the poll, which owns the watching from
 * that moment on.
 *
 * The preview call is idempotent by configuration — the backend dedupes on a
 * hash of the normalised config and returns the order it already made — so
 * pressing the button twice on one wall costs nothing and does not spend one of
 * the four previews an hour.
 */

export type CncPreviewResult = {
  /** Returns the order to watch, or null when the request failed. */
  requestPreview: (config: CncBoardConfigInput) => Promise<CncOrder | null>;
  isRequesting: boolean;
  /** Fresh link to the watermarked PDF, opened in a new tab. */
  downloadPreview: (licenceId: string) => Promise<void>;
  isDownloading: boolean;
  errorKey: CncErrorKey | null;
  /** True when the last failure was the hourly preview ceiling, not an outage. */
  isRateLimited: boolean;
};

/**
 * `true` only for a well-formed URL on the backend this client already talks
 * to, derived from the same helper that builds the GraphQL endpoint so the two
 * cannot drift apart.
 *
 * A grant URL is a server-supplied string that the browser is about to open, so
 * it gets the same origin pin the checkout redirect gets. The parse is guarded:
 * a malformed URL has to show the buyer an error, not throw inside a click
 * handler.
 */
export function isBackendDownloadUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(getGraphQLHttpUrl()).origin;
  } catch {
    return false;
  }
}

export function useCncPreview(authToken: string | null): CncPreviewResult {
  const [isRequesting, setIsRequesting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [errorKey, setErrorKey] = useState<CncErrorKey | null>(null);

  const requestPreview = useCallback(
    async (config: CncBoardConfigInput): Promise<CncOrder | null> => {
      setErrorKey(null);
      setIsRequesting(true);
      try {
        const client = createGraphQLHttpClient(authToken);
        const response = await client.request<CreateCncPreviewMutationResponse, CreateCncPreviewMutationVariables>(
          CREATE_CNC_PREVIEW,
          { config },
        );
        return response.createCncPreview;
      } catch (error) {
        setErrorKey(cncErrorKey(error));
        return null;
      } finally {
        setIsRequesting(false);
      }
    },
    [authToken],
  );

  const downloadPreview = useCallback(
    async (licenceId: string) => {
      setErrorKey(null);
      setIsDownloading(true);
      try {
        const client = createGraphQLHttpClient(authToken);
        const response = await client.request<
          CreateCncDownloadGrantMutationResponse,
          CreateCncDownloadGrantMutationVariables
        >(CREATE_CNC_DOWNLOAD_GRANT, { licenceId, kind: 'PREVIEW' });
        const grantUrl = response.createCncDownloadGrant.url;
        if (!isBackendDownloadUrl(grantUrl)) {
          setErrorKey('generic');
          return;
        }
        // A new tab rather than `location.assign`: the buyer is mid-flow in the
        // configurator and a download must not take the wall they configured
        // off the screen. `noopener` because the opened page must never reach
        // back into this one through `window.opener`.
        window.open(grantUrl, '_blank', 'noopener,noreferrer');
      } catch (error) {
        setErrorKey(cncErrorKey(error));
      } finally {
        setIsDownloading(false);
      }
    },
    [authToken],
  );

  return {
    requestPreview,
    isRequesting,
    downloadPreview,
    isDownloading,
    errorKey,
    isRateLimited: errorKey === 'RATE_LIMITED',
  };
}
