import { ClientError, GraphQLClient, type Variables } from 'graphql-request';
import { BACKEND_URL } from './env';
import { getAccessToken, refreshSession } from './auth-session';
import { timeoutSignal } from './timeout-signal';

const REQUEST_TIMEOUT_MS = 20_000;

// The backend treats an expired token as anonymous instead of answering 401, so
// a stale session shows up as this resolver error (requireAuthenticated in
// packages/backend/src/graphql/resolvers/shared/helpers.ts).
const AUTH_REQUIRED_MESSAGE = 'Authentication required';

function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    (error.response.errors ?? []).some((graphqlError) => graphqlError.message.includes(AUTH_REQUIRED_MESSAGE))
  );
}

function createClient(accessToken: string | null): GraphQLClient {
  return new GraphQLClient(`${BACKEND_URL}/graphql`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    fetch: (url: string | URL | Request, init: RequestInit = {}) =>
      fetch(url, { ...init, signal: init.signal ?? timeoutSignal(REQUEST_TIMEOUT_MS) }),
  });
}

/**
 * Run a GraphQL operation against Boardsesh as the signed-in climber (or
 * anonymously when signed out). A request rejected for a stale session is
 * retried once after a token refresh.
 */
export async function graphqlRequest<TData, TVariables extends Variables = Variables>(
  document: string,
  variables?: TVariables,
): Promise<TData> {
  const accessToken = await getAccessToken();
  try {
    return await createClient(accessToken).request<TData>(document, variables);
  } catch (error) {
    if (!accessToken || !isAuthRequiredError(error)) throw error;
    if ((await refreshSession()) !== 'refreshed') throw error;
    return createClient(await getAccessToken()).request<TData>(document, variables);
  }
}

/** A short, readable message for an error thrown by `graphqlRequest`. */
export function describeRequestError(error: unknown): string {
  if (error instanceof ClientError) {
    const firstMessage = error.response.errors?.[0]?.message;
    if (firstMessage) return firstMessage;
    return `Boardsesh answered with HTTP ${error.response.status}.`;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Boardsesh took too long to answer. Check your connection and try again.';
  }
  // The message below hides the cause, so leave it in the dev log.
  if (__DEV__) console.warn('Boardsesh request failed:', error);
  return 'Could not reach Boardsesh. Check your connection and try again.';
}
