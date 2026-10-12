import 'server-only';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';

/**
 * The two backend calls behind `/b/{slug}?invite={token}`.
 *
 * Plain `fetch`, not graphql-request, and every failure collapses to `null`
 * without a log line: a graphql-request error carries the request variables,
 * and the variable here is the token. `null` is safe in both places it lands,
 * because the page then serves the link exactly as it would without the token.
 * Never cached: a link can be reset between two requests.
 */

const REDEEM_DOCUMENT = `mutation RedeemBoardShareLink($token: String!) { redeemBoardShareLink(token: $token) { boardUuid slug } }`;
const PREVIEW_DOCUMENT = `query BoardShareLinkPreview($token: String!) { boardShareLinkPreview(token: $token) { name } }`;

async function postGraphQL<T>(document: string, token: string, authToken: string | undefined): Promise<T | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...webClientIdentityHeaders() };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const response = await fetch(getGraphQLHttpUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: document, variables: { token } }),
      signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: T | null; errors?: unknown[] };
    if (Array.isArray(payload.errors) && payload.errors.length > 0) return null;
    return payload.data ?? null;
  } catch {
    return null;
  }
}

/** Join the board as the signed-in viewer. `null` when the link opens nothing new. */
export async function redeemBoardInvite(
  token: string,
  authToken: string,
): Promise<{ boardUuid: string; slug: string } | null> {
  const data = await postGraphQL<{ redeemBoardShareLink: { boardUuid: string; slug: string } | null }>(
    REDEEM_DOCUMENT,
    token,
    authToken,
  );
  return data?.redeemBoardShareLink ?? null;
}

/** The board's name for a signed-out visitor, or `null` for a dead link. */
export async function previewBoardInvite(token: string): Promise<{ name: string } | null> {
  const data = await postGraphQL<{ boardShareLinkPreview: { name: string } | null }>(
    PREVIEW_DOCUMENT,
    token,
    undefined,
  );
  return data?.boardShareLinkPreview ?? null;
}
