import { GRAPHQL_REQUEST_TIMEOUT_CODE } from '@boardsesh/offline-sync/error-classification';

/**
 * The GraphQL request deadline, as a standalone module.
 *
 * It lives apart from `client.ts` for one reason: `client.ts` statically imports
 * the auth interceptor, and through it the whole secure-store chain. The React
 * Query provider needs only the predicate below to decide whether to retry, and
 * dragging a native keychain module into the provider's graph (and into every
 * suite that touches it) to answer a one-line question is a bad trade.
 * `client.ts` re-exports the predicate, so the public surface is unchanged.
 */

export type GraphqlRequestTimeoutError = Error & { code: string; timeoutMs: number };

export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Our own deadline expiring, not the caller cancelling. The `name` stays
 * `AbortError` so every existing cancellation filter (error-reporting's
 * `isCancellation`, the shared classifier) keeps treating it as one; the `code`
 * is what lets the React Query retry policy tell "we gave up waiting" apart from
 * "the user left the screen", and stop re-asking a backend that is not
 * answering (issue #4862).
 */
export function createGraphqlTimeoutError(timeoutMs: number): GraphqlRequestTimeoutError {
  const error = createAbortError(`GraphQL request timed out after ${timeoutMs}ms`) as GraphqlRequestTimeoutError;
  error.code = GRAPHQL_REQUEST_TIMEOUT_CODE;
  error.timeoutMs = timeoutMs;
  return error;
}

export function isGraphqlRequestTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === GRAPHQL_REQUEST_TIMEOUT_CODE;
}
