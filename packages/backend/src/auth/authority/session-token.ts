import { createHash, randomBytes } from 'node:crypto';

/**
 * `auth_session.token` stores this digest of a session token, never the token.
 * A copy of the table (a dump, the DR standby, a backup) then holds nothing a
 * browser could present. Lookups hash the presented token and compare digests.
 */
export function sessionTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** A new opaque session token: the raw value for the one reply that hands it out, and the digest the row stores. */
export function newSessionToken(): { readonly token: string; readonly stored: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, stored: sessionTokenDigest(token) };
}
