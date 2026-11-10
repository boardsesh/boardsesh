import type { NextRequest } from 'next/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import {
  MAX_PARTNER_QUERY_LENGTH,
  PARTNER_SIGN_IN_PATH,
  SIGN_IN_ERROR_PARAMETER,
  SIGNED_IN_PARAMETER,
} from './authorization-query';

/**
 * Keeps a failed Google, Apple or Facebook sign-in on `/oauth/sign-in`.
 *
 * NextAuth sends a failed social sign-in through `/api/auth/error` and
 * `/api/auth/signin` to `pages.signIn` (`/auth/login?error=…`), or to
 * `pages.error` (`/auth/error?error=…`) for the few codes outside its sign-in
 * list. Both lose the app's request, and `/auth/login` is a universal link the
 * iPhone app claims (verification links rely on that), so the climber would be
 * dropped into the app halfway through connecting a partner. When the sign-in
 * started on the partner page, the redirect goes back there instead, with the
 * error code, as soon as NextAuth names one of those destinations.
 *
 * Where it started is NextAuth's own record: the `callbackUrl` on the
 * `/auth/login` redirect, or the callback-url cookie it set when the sign-in
 * began. Only a path to the sign-in page itself is honoured, and the new
 * redirect is that path alone, never an origin, so nothing here can send the
 * browser off this site.
 */

/** NextAuth's error hops and the two pages they end on (`pages.signIn`, `pages.error`). */
const ERROR_DESTINATIONS: ReadonlySet<string> = new Set([
  '/api/auth/error',
  '/api/auth/signin',
  '/auth/login',
  '/auth/error',
]);

const CALLBACK_URL_COOKIE_NAMES = ['__Secure-next-auth.callback-url', 'next-auth.callback-url'] as const;

const LOCALE_SEGMENTS = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);
const PARTNER_SIGN_IN_PATHNAME = new RegExp(`^(?:/(?:${LOCALE_SEGMENTS.join('|')}))?${PARTNER_SIGN_IN_PATH}$`);

/** NextAuth's codes are words; anything else is passed on as its generic failure. */
const ERROR_CODE = /^[A-Za-z]{1,64}$/;
const GENERIC_ERROR_CODE = 'OAuthCallback';

/** Only parses: tells a relative path from an absolute URL without trusting either. */
const PARSING_ORIGIN = 'https://partner-sign-in-return.invalid';

/** The sign-in page path and query a candidate names, or null when it names anything else. */
export function partnerSignInReturnPath(candidate: string | null | undefined): URL | null {
  if (!candidate || candidate.length > MAX_PARTNER_QUERY_LENGTH + 256) return null;
  let url: URL;
  try {
    url = new URL(candidate, PARSING_ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.hash) return null;
  return PARTNER_SIGN_IN_PATHNAME.test(url.pathname) ? url : null;
}

function errorDestination(response: Response): URL | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get('Location');
  if (!location) return null;
  try {
    const destination = new URL(location, PARSING_ORIGIN);
    if (!ERROR_DESTINATIONS.has(destination.pathname)) return null;
    return destination.searchParams.has(SIGN_IN_ERROR_PARAMETER) ? destination : null;
  } catch {
    return null;
  }
}

function startedOn(request: NextRequest, destination: URL): URL | null {
  const fromRedirect = partnerSignInReturnPath(destination.searchParams.get('callbackUrl'));
  if (fromRedirect) return fromRedirect;
  for (const name of CALLBACK_URL_COOKIE_NAMES) {
    const fromCookie = partnerSignInReturnPath(request.cookies.get(name)?.value);
    if (fromCookie) return fromCookie;
  }
  return null;
}

/** The response, or the same redirect pointed back at the partner sign-in page. */
export function withPartnerSignInFailureReturn(request: NextRequest, response: Response): Response {
  const destination = errorDestination(response);
  if (!destination) return response;
  const partnerReturn = startedOn(request, destination);
  if (!partnerReturn) return response;

  const errorCode = destination.searchParams.get(SIGN_IN_ERROR_PARAMETER) ?? '';
  partnerReturn.searchParams.delete(SIGNED_IN_PARAMETER);
  partnerReturn.searchParams.set(SIGN_IN_ERROR_PARAMETER, ERROR_CODE.test(errorCode) ? errorCode : GENERIC_ERROR_CODE);
  const headers = new Headers(response.headers);
  headers.set('Location', `${partnerReturn.pathname}${partnerReturn.search}`);
  return new Response(null, { status: response.status, headers });
}
