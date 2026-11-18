import 'server-only';
import { stringifySetCookie } from 'cookie';
import { z } from 'zod';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { cookieCopies, openCookieValue, sealCookieValue } from './sealed-cookie.server';

/**
 * The forced re-sign-in's own state (#7596 B5e1, #7655 item 6): who started
 * it and where it returns to, sealed in one `__Host-`, HttpOnly, Secure,
 * SameSite=Lax cookie for ten minutes, written by a same-origin POST before
 * the sign-in. After the sign-in, `/api/auth/reauthenticate/return` compares
 * `startedAs` with the account the browser is now signed in as and forwards
 * to the return path only when they are the same. Nothing the climber can
 * edit in a URL decides either value.
 */

const KEY_LABEL = 'boardsesh-reauthentication-cookie-v1';
const SECURE_NAME = '__Host-boardsesh.reauthenticate';
const PLAIN_NAME = 'boardsesh.reauthenticate';
export const REAUTHENTICATION_MAX_AGE_SECONDS = 10 * 60;

const recordSchema = z
  .object({
    version: z.literal(1),
    startedAs: z.string().min(1).max(1024),
    /** A same-origin path, checked when it was written. */
    returnTo: z.string().min(1).max(512),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ReauthenticationRecord = z.infer<typeof recordSchema>;

const nameOf = (secure: boolean) => (secure ? SECURE_NAME : PLAIN_NAME);
const attributes = (secure: boolean) => ({ httpOnly: true, secure, path: '/', sameSite: 'lax' }) as const;

export function sealReauthenticationCookie(
  cookies: BrowserSessionCookieConfiguration,
  record: ReauthenticationRecord,
): string {
  const name = nameOf(cookies.secure);
  const value = sealCookieValue(cookies.secret, KEY_LABEL, name, JSON.stringify(recordSchema.parse(record)));
  return stringifySetCookie({ ...attributes(cookies.secure), name, value, maxAge: REAUTHENTICATION_MAX_AGE_SECONDS });
}

export function clearReauthenticationCookie(cookies: Pick<BrowserSessionCookieConfiguration, 'secure'>): string {
  return stringifySetCookie({
    ...attributes(cookies.secure),
    name: nameOf(cookies.secure),
    value: '',
    maxAge: 0,
    expires: new Date(0),
  });
}

/** The open record from the raw `Cookie` header: one copy, a seal that opens, not past its end. */
export function readReauthenticationCookie(
  cookieHeader: string | null,
  cookies: BrowserSessionCookieConfiguration,
  now = Date.now(),
): ReauthenticationRecord | undefined {
  const name = nameOf(cookies.secure);
  const copies = cookieCopies(cookieHeader, name);
  if (copies.length !== 1) return undefined;
  const opened = openCookieValue(cookies.secret, KEY_LABEL, name, copies[0]);
  if (opened === undefined) return undefined;
  try {
    const record = recordSchema.parse(JSON.parse(opened));
    return record.expiresAt > now ? record : undefined;
  } catch {
    return undefined;
  }
}
