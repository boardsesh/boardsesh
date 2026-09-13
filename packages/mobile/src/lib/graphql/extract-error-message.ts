import { hasGraphqlErrorCode } from '@boardsesh/offline-sync/error-classification';

// graphql-request throws ClientError-shaped errors carrying response.errors[].
// Surface the first server message when present so backend guidance reaches the
// user verbatim (e.g. "This Instagram post isn't available", "already attached
// to <other climb>", "Instagram is temporarily blocking us"); otherwise return
// null so the caller can fall back to a generic toast string. Never leaks fetch
// internals.
type GraphqlErrorLike = {
  message?: string;
  extensions?: {
    code?: unknown;
    retryAfterSeconds?: unknown;
    [key: string]: unknown;
  } | null;
};

function getGraphqlErrors(error: unknown): GraphqlErrorLike[] {
  if (!error || typeof error !== 'object') return [];
  const response = (error as { response?: { errors?: GraphqlErrorLike[] } }).response;
  if (Array.isArray(response?.errors)) return response.errors;
  const graphqlErrors = (error as { graphqlErrors?: GraphqlErrorLike[] }).graphqlErrors;
  return Array.isArray(graphqlErrors) ? graphqlErrors : [];
}

export function extractGraphqlMessage(error: unknown): string | null {
  const first = getGraphqlErrors(error)[0]?.message;
  if (typeof first === 'string' && first.length > 0) return first;
  return null;
}

export function isGraphqlRateLimitedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const directExtensions = (error as { extensions?: GraphqlErrorLike['extensions'] }).extensions;
  if (directExtensions?.code === 'RATE_LIMITED') return true;

  return getGraphqlErrors(error).some((graphqlError) => graphqlError.extensions?.code === 'RATE_LIMITED');
}

const GRAPHQL_VALIDATION_FAILED = 'GRAPHQL_VALIDATION_FAILED';

// Sentry fingerprint entries must stay short. Validation messages are built by
// graphql-js from the schema and our own static query documents ('Cannot query
// field "x" on type "Y".'), never from variables, but a "Did you mean" list can
// run long, so cap it.
const MAX_VALIDATION_MESSAGE_LENGTH = 200;

/**
 * The backend rejected the request document itself: it asks for a field,
 * argument or type the running schema does not have. This is a schema mismatch
 * between this bundle and the backend (an OTA that shipped before its backend
 * change, or a field removed while installed builds still query it). Retrying
 * cannot help, and Yoga tags every such error GRAPHQL_VALIDATION_FAILED.
 */
export function isGraphqlValidationFailedError(error: unknown): boolean {
  return hasGraphqlErrorCode(error, GRAPHQL_VALIDATION_FAILED);
}

const MAX_CAUSE_DEPTH = 5;

// Walks the same shapes `hasGraphqlErrorCode` accepts (a bounded `.cause`
// chain, a top-level `errors` array, graphql-request's `response.errors`, and a
// re-thrown GraphQLError carrying `extensions` itself), so an error the
// predicate matches never reads back as 'unknown'.
function findValidationFailedMessage(error: unknown, depth: number): string | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as { errors?: unknown; extensions?: GraphqlErrorLike['extensions']; message?: unknown };

  const candidates = [
    ...(Array.isArray(record.errors) ? (record.errors as GraphqlErrorLike[]) : []),
    ...getGraphqlErrors(error),
  ];
  const validationError = candidates.find(
    (graphqlError) => graphqlError?.extensions?.code === GRAPHQL_VALIDATION_FAILED,
  );
  if (typeof validationError?.message === 'string' && validationError.message.length > 0)
    return validationError.message;

  if (record.extensions?.code === GRAPHQL_VALIDATION_FAILED && typeof record.message === 'string' && record.message) {
    return record.message;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== error) {
    return findValidationFailedMessage(cause, depth + 1);
  }
  return null;
}

/** The first validation message, bounded for use as a Sentry fingerprint. */
export function readGraphqlValidationFailedMessage(error: unknown): string {
  const message = findValidationFailedMessage(error, 0);
  if (!message) return 'unknown';
  return message.slice(0, MAX_VALIDATION_MESSAGE_LENGTH);
}

// The backend's `requireAuthenticated` guard throws this exact message (a plain
// Error, so no extensions.code) whenever a session-only resolver runs without a
// signed-in user. graphql-request surfaces it as a ClientError carrying
// response.errors[].
const AUTH_REQUIRED_MESSAGE = 'Authentication required to perform this operation';

/**
 * An *expected* authentication failure: a session-only query ran without a
 * session (e.g. on a logged-out cold start) or raced a token expiry. Call sites
 * should gate authed queries with React Query `enabled`, and the 401 interceptor
 * already forces sign-out, so these carry no action — error tracking drops them.
 * Matches only the exact backend message / UNAUTHENTICATED code so genuine
 * authorization faults still surface.
 */
export function isExpectedAuthError(error: unknown): boolean {
  return getGraphqlErrors(error).some(
    (graphqlError) =>
      graphqlError.message === AUTH_REQUIRED_MESSAGE || graphqlError.extensions?.code === 'UNAUTHENTICATED',
  );
}

// attachBetaLink rejections the user resolves themselves by picking a different
// climb or post: a bad/private Instagram link, the same or another climb already
// owns the video, the tick is an attempt (not a send), or the tick is for a
// different climb/board/angle. These surface as an inline message on the share
// sheet and carry no engineering signal. Deliberately excludes BETA_LINK_INTERNAL
// / BETA_LINK_INSERT_FAILED (genuine write faults) and FORBIDDEN, which still report.
const EXPECTED_BETA_VALIDATION_CODES = new Set([
  'INSTAGRAM_BETA_VALIDATION',
  'BETA_LINK_TICK_NOT_ASCENT',
  'BETA_LINK_TICK_MISMATCH',
  'BETA_LINK_TICK_ALREADY_LINKED',
]);

/**
 * An *expected* beta-video attach rejection — a user-facing validation the
 * climber fixes themselves (the share sheet shows the backend's guidance inline).
 * Error tracking drops these so the genuine attach faults stay visible.
 */
export function isExpectedBetaValidationError(error: unknown): boolean {
  return getGraphqlErrors(error).some(
    (graphqlError) =>
      typeof graphqlError.extensions?.code === 'string' &&
      EXPECTED_BETA_VALIDATION_CODES.has(graphqlError.extensions.code),
  );
}

// The board-mutation rejections clients branch on are parsed in
// @boardsesh/graphql so web and mobile read the same shapes. Re-exported here so
// board screens keep a single import for GraphQL error handling.
export {
  isDuplicateBoardError,
  readDuplicateBoardError,
  isBoardLimitError,
  type DuplicateBoardError,
} from '@boardsesh/graphql/errors';
