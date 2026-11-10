/**
 * The partner OAuth request as the www sign-in and consent pages receive it.
 *
 * The backend (`packages/backend/src/auth/partner/`) sends a browser to
 * `/oauth/sign-in` or `/oauth/consent` with the app's authorize parameters plus
 * the fields Better Auth adds when it signs them. The consent page hands the
 * signed part back untouched, because the signature is what proves the link.
 * The sign-in page instead starts the request again at authorize once the
 * climber has signed in, so it drops the signing fields first.
 *
 * Neither page can check the signature: only the backend holds the key. A
 * query that merely looks right still gets every check at authorize and at
 * the consent routes.
 */

import { PARTNER_OAUTH_ISSUER } from '@boardsesh/auth-protocol/partner-oauth';

export const PARTNER_AUTHORIZE_URL = `${PARTNER_OAUTH_ISSUER}/oauth2/authorize`;
export const PARTNER_CONSENT_URL = `${PARTNER_OAUTH_ISSUER}/oauth2/consent`;
export const PARTNER_CONSENT_DETAILS_URL = `${PARTNER_OAUTH_ISSUER}/oauth2/consent-details`;

export const PARTNER_SIGN_IN_PATH = '/oauth/sign-in';
export const PARTNER_CONSENT_PATH = '/oauth/consent';

/**
 * Better Auth 1.7.17's signing fields (`signParams` in @better-auth/oauth-provider).
 * `ba_param` lists the names the signature covers, itself included.
 */
const SIGNATURE_PARAMETER = 'sig';
const EXPIRY_PARAMETER = 'exp';
const SIGNED_NAMES_PARAMETER = 'ba_param';
const SIGNING_PARAMETERS: readonly string[] = [
  SIGNATURE_PARAMETER,
  EXPIRY_PARAMETER,
  'ba_iat',
  'ba_pl',
  SIGNED_NAMES_PARAMETER,
];

/**
 * Added by www to its own sign-in page URL, never by the backend, and never
 * forwarded to it: `signed_in` marks the return from a sign-in this page
 * started, and `error` carries a failed social sign-in's NextAuth code.
 */
export const SIGNED_IN_PARAMETER = 'boardsesh_signed_in';
export const SIGN_IN_ERROR_PARAMETER = 'error';

/**
 * A real signed query is a few hundred characters. The cap keeps a crafted one
 * out of NextAuth's callback-url cookie, which carries the sign-in page's URL.
 */
export const MAX_PARTNER_QUERY_LENGTH = 4096;

export type PartnerOAuthRequest = {
  /** Only the parameters the signature covers, plus `sig`: what the consent routes verify. */
  signedQuery: string;
  clientId: string;
  /** When the backend stops accepting this link, from `exp`. */
  expiresAtMs: number;
};

/** Next's page `searchParams` as the URLSearchParams it came from. */
export function searchParamsFromRecord(record: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(record)) {
    if (Array.isArray(value)) for (const item of value) search.append(name, item);
    else if (value !== undefined) search.append(name, value);
  }
  return search;
}

/**
 * The part of a page query the backend signed, in the order it arrived, the way
 * Better Auth's own client rebuilds it (`buildSignedOAuthQuery`). Anything else
 * on the URL, such as this site's own markers, would break the signature.
 */
function signedPart(search: URLSearchParams): URLSearchParams | null {
  const signedNames = new Set(search.getAll(SIGNED_NAMES_PARAMETER));
  if (signedNames.size === 0) return null;
  const signed = new URLSearchParams();
  for (const [name, value] of search) {
    if (name === SIGNATURE_PARAMETER || name === SIGNED_NAMES_PARAMETER || signedNames.has(name)) {
      signed.append(name, value);
    }
  }
  return signed;
}

/**
 * The request a page was opened with, or null when the query cannot be one
 * the backend signed: no single signature, no list of signed names, no app,
 * no expiry, or longer than any real one.
 */
export function readPartnerOAuthRequest(search: URLSearchParams): PartnerOAuthRequest | null {
  if (search.toString().length > MAX_PARTNER_QUERY_LENGTH) return null;
  const signed = signedPart(search);
  if (!signed) return null;
  const signatures = signed.getAll(SIGNATURE_PARAMETER);
  const clientIds = signed.getAll('client_id');
  const expiries = signed.getAll(EXPIRY_PARAMETER);
  if (signatures.length !== 1 || !signatures[0] || clientIds.length !== 1 || !clientIds[0]) return null;
  const expirySeconds = expiries.length === 1 ? Number(expiries[0]) : Number.NaN;
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds <= 0) return null;
  return { signedQuery: signed.toString(), clientId: clientIds[0], expiresAtMs: expirySeconds * 1000 };
}

/** Whether the backend would now refuse the link as expired. */
export function isPartnerRequestExpired(request: PartnerOAuthRequest, nowMs: number): boolean {
  return request.expiresAtMs <= nowMs;
}

/**
 * Where the browser goes to start the app's request again: authorize, with the
 * app's own parameters and none of the signing fields. Authorize checks the app,
 * its redirect and PKCE from scratch, so this is no more than the app's own link.
 */
export function partnerAuthorizeUrl(request: PartnerOAuthRequest): string {
  const parameters = new URLSearchParams(request.signedQuery);
  for (const name of SIGNING_PARAMETERS) parameters.delete(name);
  return `${PARTNER_AUTHORIZE_URL}?${parameters.toString()}`;
}

/** The sign-in page for this request, as a site path (no locale; `LocaleLink` adds it). */
export function partnerSignInPath(request: PartnerOAuthRequest, extra: Record<string, string> = {}): string {
  const parameters = new URLSearchParams(request.signedQuery);
  for (const [name, value] of Object.entries(extra)) parameters.set(name, value);
  return `${PARTNER_SIGN_IN_PATH}?${parameters.toString()}`;
}
