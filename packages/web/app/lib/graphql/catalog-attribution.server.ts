import 'server-only';
import { headers } from 'next/headers';
import { CATALOG_PROOF_HEADER, signCatalogRequest } from '@boardsesh/crypto/catalog-request-proof';
import { trustedClientRateLimitKey } from '@/app/lib/auth/trusted-client-ip.server';

/** Background revalidation still consumes a bounded backend budget. */
export const CATALOG_SERVER_CACHE_IDENTITY = 'server-cache';

/** Call outside unstable_cache; capture only the trusted bucket, never request headers. */
export async function catalogRequestIdentity(): Promise<string> {
  try {
    const requestHeaders = await headers();
    return trustedClientRateLimitKey(new Request('https://www.boardsesh.com', { headers: requestHeaders }));
  } catch {
    // Build-time reads and background jobs have no incoming visitor.
    return CATALOG_SERVER_CACHE_IDENTITY;
  }
}

/** Sign at fetch time so a stale-cache refresh never reuses an expired proof. */
export function catalogGraphQLProofHeaders(
  url: string,
  clientIp = CATALOG_SERVER_CACHE_IDENTITY,
): Record<string, string> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return {};
  return {
    [CATALOG_PROOF_HEADER]: signCatalogRequest(
      { purpose: 'graphql', method: 'POST', pathname: new URL(url).pathname, clientIp },
      secret,
    ),
  };
}
