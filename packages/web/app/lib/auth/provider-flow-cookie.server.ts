import 'server-only';
import { randomBytes } from 'node:crypto';
import { stringifySetCookie } from 'cookie';
import { z } from 'zod';
import { providerSecurityProviderSchema } from '@boardsesh/auth-protocol';
import type { BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { cookieCopies, openCookieValue, sealCookieValue } from './sealed-cookie.server';

/**
 * Flow custody for provider link, unlink and reauthentication (#7596 B5e1).
 *
 * Every secret of one flow lives in ONE cookie on www: the backend's intent,
 * recovery, reauthentication and preparation tokens, and each provider round
 * trip's state, nonce and PKCE verifier. None of them goes into the OAuth
 * `state`, a URL or page JavaScript. The cookie is:
 * - sealed: AES-256-GCM under a key derived (HKDF-SHA256) from
 *   `AUTH_BROWSER_SESSION_COOKIE_SECRET` with its own label, so it can be
 *   opened by nothing else, and the cookie name is the associated data;
 * - `__Host-` (Secure, Path=/, no Domain): no sibling subdomain can plant or
 *   read it; outside a secure context (local development) the plain name;
 * - HttpOnly, at most 15 minutes old (the backend intent's lifetime);
 * - SameSite=Lax, or None when the flow has an Apple round trip, because
 *   Apple answers with a cross-site `form_post`.
 * It is cleared with the attributes it was written with.
 *
 * The record also names the account and the session that started the flow.
 * Each later step compares them with the session the request presents now,
 * and the backend compares the presented token with the one the intent stores.
 */

/** HKDF `info`: a key used for this cookie and nothing else. */
const KEY_LABEL = 'boardsesh-provider-security-flow-cookie-v1';
const SECURE_NAME = '__Host-boardsesh.provider-flow';
const PLAIN_NAME = 'boardsesh.provider-flow';
/** The backend intent lives 15 minutes; the cookie never outlives it. */
export const PROVIDER_FLOW_MAX_AGE_SECONDS = 15 * 60;

const backendToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** State, nonce and PKCE verifier: 32 random bytes each, base64url. */
const flowSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const roundTripSchema = z.object({ state: flowSecret, nonce: flowSecret, verifier: flowSecret }).strict();

const flowRecordSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(['link', 'unlink']),
    provider: providerSecurityProviderSchema,
    /** Who started the flow: every later step must present this account and session. */
    userId: z.string().min(1).max(1024),
    authSessionId: z.string().min(1).max(1024),
    intentToken: backendToken,
    recoveryToken: backendToken,
    /** Milliseconds; the backend intent's own end. */
    expiresAt: z.number().int().positive(),
    /** A same-origin path, checked when the flow started. */
    returnTo: z.string().min(1).max(512),
    sameSite: z.enum(['lax', 'none']),
    reauthenticationToken: backendToken.optional(),
    /** The Google reauthentication round trip, while it is under way. */
    reauthentication: roundTripSchema.optional(),
    /** The link's own provider round trip, while it is under way. */
    providerLeg: roundTripSchema.optional(),
    /**
     * Apple's cross-site `form_post`, held for the same-site GET that resumes
     * it (the Lax session cookie rides only on that GET). `code` is null when
     * the climber cancelled at Apple.
     */
    heldCallback: z
      .object({ code: z.string().min(1).max(1024).nullable(), state: z.string().min(1).max(1024) })
      .strict()
      .optional(),
  })
  .strict();

export type ProviderFlowRecord = z.infer<typeof flowRecordSchema>;
export type ProviderFlowRoundTrip = z.infer<typeof roundTripSchema>;

export function providerFlowCookieName(secure: boolean): string {
  return secure ? SECURE_NAME : PLAIN_NAME;
}

/** 32 random bytes, base64url: a state, a nonce or a PKCE verifier (256 bits). */
export function newFlowSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function newRoundTrip(): ProviderFlowRoundTrip {
  return { state: newFlowSecret(), nonce: newFlowSecret(), verifier: newFlowSecret() };
}

function cookieAttributes(cookies: Pick<BrowserSessionCookieConfiguration, 'secure'>, sameSite: 'lax' | 'none') {
  // SameSite=None needs Secure; a plain context (local development) cannot do Apple anyway.
  const effective = cookies.secure ? sameSite : 'lax';
  return { httpOnly: true, secure: cookies.secure, path: '/', sameSite: effective } as const;
}

/** The `Set-Cookie` that writes (or rewrites) the flow's record. Throws `SealedCookieTooLarge` rather than write what the reader refuses. */
export function sealProviderFlowCookie(cookies: BrowserSessionCookieConfiguration, record: ProviderFlowRecord): string {
  const parsed = flowRecordSchema.parse(record);
  const name = providerFlowCookieName(cookies.secure);
  const value = sealCookieValue(cookies.secret, KEY_LABEL, name, JSON.stringify(parsed));
  const maxAge = Math.max(
    0,
    Math.min(PROVIDER_FLOW_MAX_AGE_SECONDS, Math.floor((parsed.expiresAt - Date.now()) / 1000)),
  );
  return stringifySetCookie({ ...cookieAttributes(cookies, parsed.sameSite), name, value, maxAge });
}

/** The `Set-Cookie` that ends the flow, with the attributes it was written with. */
export function clearProviderFlowCookie(
  cookies: Pick<BrowserSessionCookieConfiguration, 'secure'>,
  sameSite: 'lax' | 'none',
): string {
  return stringifySetCookie({
    ...cookieAttributes(cookies, sameSite),
    name: providerFlowCookieName(cookies.secure),
    value: '',
    maxAge: 0,
    expires: new Date(0),
  });
}

export type ProviderFlowRead =
  | { kind: 'open'; record: ProviderFlowRecord }
  /** No flow cookie. */
  | { kind: 'none' }
  /** Present but unusable: two copies, a seal that does not open, or past its end. */
  | { kind: 'invalid' };

/**
 * The flow record of a request, from the raw `Cookie` header: exactly one
 * copy of the name, a seal that opens under this deployment's key, a record
 * that parses, and not past its end.
 */
export function readProviderFlowCookie(
  cookieHeader: string | null,
  cookies: BrowserSessionCookieConfiguration,
  now = Date.now(),
): ProviderFlowRead {
  const name = providerFlowCookieName(cookies.secure);
  const copies = cookieCopies(cookieHeader, name);
  if (copies.length === 0) return { kind: 'none' };
  if (copies.length !== 1) return { kind: 'invalid' };
  const opened = openCookieValue(cookies.secret, KEY_LABEL, name, copies[0]);
  if (opened === undefined) return { kind: 'invalid' };
  try {
    const record = flowRecordSchema.parse(JSON.parse(opened));
    if (record.expiresAt <= now) return { kind: 'invalid' };
    return { kind: 'open', record };
  } catch {
    return { kind: 'invalid' };
  }
}
