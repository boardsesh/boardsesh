import 'server-only';
import { unstable_cache } from 'next/cache';
import {
  fetchAllPublicSupporters,
  GET_PUBLIC_SUPPORTERS,
  type GetPublicSupportersResponse,
  type GetPublicSupportersVariables,
  type PublicSupporter,
} from '@boardsesh/graphql/operations/support';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';

/** A new opt-in shows on /about within this long. */
const PUBLIC_SUPPORTERS_REVALIDATE_SECONDS = 300;

const loadPublicSupporters = unstable_cache(
  async (): Promise<PublicSupporter[]> => {
    // One deadline across every page, so a slow backend costs the page at most this long.
    const signal = AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS);
    return fetchAllPublicSupporters((variables) =>
      executeGraphQLInternal<GetPublicSupportersResponse, GetPublicSupportersVariables>(
        GET_PUBLIC_SUPPORTERS,
        variables,
        signal,
      ),
    );
  },
  ['about-public-supporters'],
  { revalidate: PUBLIC_SUPPORTERS_REVALIDATE_SECONDS },
);

/**
 * Supporters who chose public credit and are currently supporters. Empty when
 * the backend cannot answer: the rest of /about still renders.
 */
export async function getPublicSupporters(): Promise<PublicSupporter[]> {
  try {
    return await loadPublicSupporters();
  } catch (error) {
    console.error('getPublicSupporters failed:', error);
    return [];
  }
}
