import {
  PARTNER_CONSOLE_ALLOWLIST_UNAVAILABLE,
  PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED,
} from '@boardsesh/auth-protocol/partner-oauth';

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
  /** Signed in, but PostHog's `developer-console` flag does not name the account. */
  | { kind: 'not-allowlisted' }
  /** The backend could not ask PostHog whether the account is invited. A retry helps. */
  | { kind: 'invite-check-failed' }
  /** PARTNER_OAUTH_MODE is hold. */
  | { kind: 'paused' }
  | { kind: 'email-not-verified' }
  /**
   * A redirect URI change, a new secret or a deletion, from a session signed in
   * more than five minutes ago (or of unknown age): sign in again, then retry.
   */
  | { kind: 'sign-in-again' }
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
      if (reason === 'BUSY') return { kind: 'busy' };
      if (reason === PARTNER_CONSOLE_ALLOWLIST_UNAVAILABLE) return { kind: 'invite-check-failed' };
      return { kind: 'paused' };
    case 'FORBIDDEN':
      if (reason === 'NOT_ALLOWLISTED') return { kind: 'not-allowlisted' };
      if (reason === 'EMAIL_NOT_VERIFIED') return { kind: 'email-not-verified' };
      if (reason === 'SUSPENDED') return { kind: 'suspended' };
      if (reason === PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED) return { kind: 'sign-in-again' };
      return { kind: 'failed' };
    case 'RATE_LIMITED':
      return { kind: 'rate-limited' };
    case 'BAD_USER_INPUT':
      return message ? { kind: 'invalid-input', message } : { kind: 'failed' };
    default:
      return { kind: 'failed' };
  }
}
