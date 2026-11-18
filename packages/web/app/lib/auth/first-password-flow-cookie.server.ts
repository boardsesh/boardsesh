import 'server-only';
import { createHash } from 'node:crypto';
import { stringifySetCookie } from 'cookie';
import { z } from 'zod';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { cookieCopies, openCookieValue, sealCookieValue } from './sealed-cookie.server';

/**
 * Flow custody for first password (#7596 B5e2), as for provider security: the
 * backend's challenge, recovery and preparation tokens live in one sealed,
 * `__Host-`, HttpOnly, Secure, SameSite=Lax cookie of their own, written when
 * the email is requested and cleared when the flow ends. Only the emailed
 * confirmation token travels in the link (in its fragment), with an operation
 * key that names this flow without revealing its tokens. The record names the
 * account and session that asked: the backend accepts the confirmation only
 * from that same session, and www checks it first.
 */

const KEY_LABEL = 'boardsesh-first-password-flow-cookie-v1';
const SECURE_NAME = '__Host-boardsesh.first-password-flow';
const PLAIN_NAME = 'boardsesh.first-password-flow';
const backendToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const recordSchema = z
  .object({
    version: z.literal(1),
    // Ids are UUIDs; the caps keep any record well under the sealed-cookie limit.
    userId: z.string().min(1).max(128),
    authSessionId: z.string().min(1).max(128),
    challengeToken: backendToken,
    recoveryToken: backendToken,
    /** Milliseconds: the challenge's own end (five minutes at most). */
    expiresAt: z.number().int().positive(),
    /** Set once `prepare` answered, so a lost `finalize` reply can be recovered later. */
    preparationToken: backendToken.optional(),
  })
  .strict();
export type FirstPasswordFlowRecord = z.infer<typeof recordSchema>;

export function firstPasswordFlowCookieName(secure: boolean): string {
  return secure ? SECURE_NAME : PLAIN_NAME;
}

/** The value the emailed link carries to name this flow: a digest of its challenge, never the challenge. */
export function firstPasswordOperationKey(challengeToken: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['first-password-operation-v1', challengeToken]))
    .digest('hex');
}

function attributes(cookies: Pick<BrowserSessionCookieConfiguration, 'secure'>) {
  return { httpOnly: true, secure: cookies.secure, path: '/', sameSite: 'lax' } as const;
}

export function sealFirstPasswordFlowCookie(
  cookies: BrowserSessionCookieConfiguration,
  record: FirstPasswordFlowRecord,
): string {
  const parsed = recordSchema.parse(record);
  const name = firstPasswordFlowCookieName(cookies.secure);
  // The challenge lives five minutes; a lost reply can still be recovered for two more.
  const maxAge = Math.max(0, Math.min(15 * 60, Math.floor((parsed.expiresAt - Date.now()) / 1000) + 120));
  const value = sealCookieValue(cookies.secret, KEY_LABEL, name, JSON.stringify(parsed));
  return stringifySetCookie({ ...attributes(cookies), name, value, maxAge });
}

export function clearFirstPasswordFlowCookie(cookies: Pick<BrowserSessionCookieConfiguration, 'secure'>): string {
  return stringifySetCookie({
    ...attributes(cookies),
    name: firstPasswordFlowCookieName(cookies.secure),
    value: '',
    maxAge: 0,
    expires: new Date(0),
  });
}

export type FirstPasswordFlowRead =
  | { kind: 'open'; record: FirstPasswordFlowRecord }
  | { kind: 'none' }
  /** Two copies, or a seal that does not open: nothing of this flow can be used. */
  | { kind: 'invalid' };

/** From the raw `Cookie` header: exactly one copy that opens and parses. Expiry is the backend's to judge. */
export function readFirstPasswordFlowCookie(
  cookieHeader: string | null,
  cookies: BrowserSessionCookieConfiguration,
): FirstPasswordFlowRead {
  const name = firstPasswordFlowCookieName(cookies.secure);
  const copies = cookieCopies(cookieHeader, name);
  if (copies.length === 0) return { kind: 'none' };
  if (copies.length !== 1) return { kind: 'invalid' };
  const opened = openCookieValue(cookies.secret, KEY_LABEL, name, copies[0]);
  if (opened === undefined) return { kind: 'invalid' };
  try {
    return { kind: 'open', record: recordSchema.parse(JSON.parse(opened)) };
  } catch {
    return { kind: 'invalid' };
  }
}
