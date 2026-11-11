import 'server-only';
import { decode } from 'next-auth/jwt';
import { GET_AUTHENTICATED_USER_ID } from '@boardsesh/graphql/operations/account';
import { getGraphQLHttpUrl } from '../backend-url';
import { webClientIdentityHeaders } from '../client-identity';

/** An unavailable authority must never be interpreted as a confirmed logout. */
export class CredentialAuthorityUnavailable extends Error {
  constructor() {
    super('Credential authority is temporarily unavailable');
    this.name = 'CredentialAuthorityUnavailable';
  }
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/**
 * Admit the exact presented JWE through the backend's primary authority.
 * No caller-supplied UID, session timestamp, or cached positive result is proof.
 * The backend decides deletion and the cookie's `gen` stamp against the
 * climber's current generation (BA-04 PR 2), so a reset ends the cookie here too.
 * Only its explicit UNAUTHENTICATED is a denial; anything else is unavailable.
 */
export async function admitPresentedWebCredential(credential: string): Promise<string | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new CredentialAuthorityUnavailable();

  let subject: string;
  try {
    const token = await decode({ token: credential, secret });
    if (!token || typeof token.sub !== 'string' || !token.sub.trim()) return null;
    subject = token.sub;
  } catch {
    return null;
  }

  // Covers both response headers and body consumption. Do not retain the
  // request/response or attach a potentially secret-bearing transport cause.
  const controller = new AbortController();
  const expiresAt = performance.now() + 3_000;
  const deadline = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(getGraphQLHttpUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
        ...webClientIdentityHeaders(),
      },
      body: JSON.stringify({ query: GET_AUTHENTICATED_USER_ID }),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const result: unknown = await response.json();
    // The backend answers a refused cookie (deleted account, reset) with 401;
    // one from before that change answered 200 as anonymous. Either way only
    // the explicit UNAUTHENTICATED below is a denial, and a 401 never admits.
    const refused = response.status === 401;
    if (controller.signal.aborted || performance.now() >= expiresAt || !(response.ok || refused) || !isRecord(result)) {
      throw new CredentialAuthorityUnavailable();
    }
    if ('errors' in result) {
      const errors = result.errors;
      // Only the mounted resolver's explicit unauthenticated response is a
      // known denial. An old backend, mixed errors, or partial data is unknown.
      if (
        (result.data === null || result.data === undefined) &&
        Array.isArray(errors) &&
        errors.length === 1 &&
        isRecord(errors[0]) &&
        isRecord(errors[0].extensions) &&
        errors[0].extensions.code === 'UNAUTHENTICATED'
      ) {
        return null;
      }
      throw new CredentialAuthorityUnavailable();
    }
    if (refused || !isRecord(result.data) || result.data.authenticatedUserId !== subject) {
      throw new CredentialAuthorityUnavailable();
    }
    return subject;
  } catch {
    throw new CredentialAuthorityUnavailable();
  } finally {
    clearTimeout(deadline);
  }
}
