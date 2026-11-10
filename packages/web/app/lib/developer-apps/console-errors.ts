/**
 * What a refused developer-console operation means, read from the GraphQL
 * error's `extensions` (`graphql/resolvers/oauth-clients/partner-registration.ts`),
 * never from its English text. The one exception is `invalid-input`: the
 * server's message names the exact field and rule ("A redirect URI cannot have
 * a fragment (#)."), so the page shows it as written.
 */
export type ConsoleProblem =
  /** PARTNER_OAUTH_MODE is off: registration does not exist yet. */
  | { kind: 'not-available' }
  /** Signed in, but not on PARTNER_OAUTH_DEVELOPER_ALLOWLIST. */
  | { kind: 'not-allowlisted' }
  /** PARTNER_OAUTH_MODE is hold. */
  | { kind: 'paused' }
  | { kind: 'email-not-verified' }
  | { kind: 'rate-limited' }
  /** A lock or statement timeout on the server: a retry helps. */
  | { kind: 'busy' }
  | { kind: 'gone' }
  | { kind: 'suspended' }
  | { kind: 'invalid-input'; message: string }
  /** Anything else, a network failure included. */
  | { kind: 'failed' };

type GraphQLErrorShape = { message?: unknown; extensions?: { code?: unknown; reason?: unknown } | null };

function firstGraphQLError(error: unknown): GraphQLErrorShape | null {
  if (!error || typeof error !== 'object' || !('response' in error)) return null;
  const errors = (error as { response?: { errors?: unknown } }).response?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const [first] = errors as unknown[];
  return first && typeof first === 'object' ? (first as GraphQLErrorShape) : null;
}

export function classifyConsoleError(error: unknown): ConsoleProblem {
  const graphQLError = firstGraphQLError(error);
  if (!graphQLError) return { kind: 'failed' };
  const code = graphQLError.extensions?.code;
  const reason = graphQLError.extensions?.reason;
  const message = typeof graphQLError.message === 'string' ? graphQLError.message : '';

  switch (code) {
    case 'NOT_FOUND':
      // The mode is off, or an app id that is not (or no longer) this developer's.
      return reason === 'NOT_FOUND' ? { kind: 'gone' } : { kind: 'not-available' };
    case 'SERVICE_UNAVAILABLE':
      return reason === 'BUSY' ? { kind: 'busy' } : { kind: 'paused' };
    case 'FORBIDDEN':
      if (reason === 'NOT_ALLOWLISTED') return { kind: 'not-allowlisted' };
      if (reason === 'EMAIL_NOT_VERIFIED') return { kind: 'email-not-verified' };
      if (reason === 'SUSPENDED') return { kind: 'suspended' };
      return { kind: 'failed' };
    case 'RATE_LIMITED':
      return { kind: 'rate-limited' };
    case 'BAD_USER_INPUT':
      return message ? { kind: 'invalid-input', message } : { kind: 'failed' };
    default:
      return { kind: 'failed' };
  }
}
