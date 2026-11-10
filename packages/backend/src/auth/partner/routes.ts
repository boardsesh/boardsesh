/** Better Auth mounts under the issuer path, so its own routes are relative to this. */
export const PARTNER_AUTH_BASE_PATH = '/api/auth';

export type PartnerRouteKind = 'authorize' | 'consent' | 'consent-details' | 'token' | 'revoke' | 'discovery' | 'error';

export interface PartnerRoute {
  method: 'GET' | 'POST';
  /** The whole path, byte for byte. */
  pathname: string;
  kind: PartnerRouteKind;
}

/**
 * Everything partner OAuth answers on the API host. `error` is where the
 * provider sends a browser it must not send to the app (an unknown client or an
 * unregistered redirect URI), so it has to answer rather than 404.
 */
export const PARTNER_ROUTES: readonly PartnerRoute[] = [
  { method: 'GET', pathname: `${PARTNER_AUTH_BASE_PATH}/oauth2/authorize`, kind: 'authorize' },
  { method: 'POST', pathname: `${PARTNER_AUTH_BASE_PATH}/oauth2/consent`, kind: 'consent' },
  // What the www consent screen shows: the app, its developer and the scopes, for an open consent link.
  { method: 'POST', pathname: `${PARTNER_AUTH_BASE_PATH}/oauth2/consent-details`, kind: 'consent-details' },
  { method: 'POST', pathname: `${PARTNER_AUTH_BASE_PATH}/oauth2/token`, kind: 'token' },
  { method: 'POST', pathname: `${PARTNER_AUTH_BASE_PATH}/oauth2/revoke`, kind: 'revoke' },
  { method: 'GET', pathname: `/.well-known/oauth-authorization-server${PARTNER_AUTH_BASE_PATH}`, kind: 'discovery' },
  { method: 'GET', pathname: `${PARTNER_AUTH_BASE_PATH}/.well-known/oauth-authorization-server`, kind: 'discovery' },
  { method: 'GET', pathname: `${PARTNER_AUTH_BASE_PATH}/error`, kind: 'error' },
];

const CORS_ROUTE_KINDS: ReadonlySet<PartnerRouteKind> = new Set(['consent', 'consent-details', 'token', 'revoke']);

/**
 * The path of a request target, exactly as the client sent it. Nothing is
 * decoded or normalized: a trailing slash, doubled slash, different case,
 * percent-encoded byte or dot segment is simply a different path.
 */
function requestTargetPath(requestTarget: string | undefined): string {
  if (!requestTarget) return '';
  const queryStart = requestTarget.indexOf('?');
  return queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
}

export function requestTargetQuery(requestTarget: string | undefined): string {
  if (!requestTarget) return '';
  const queryStart = requestTarget.indexOf('?');
  return queryStart === -1 ? '' : requestTarget.slice(queryStart);
}

export function matchPartnerRoute(
  method: string | undefined,
  requestTarget: string | undefined,
): PartnerRoute | undefined {
  const pathname = requestTargetPath(requestTarget);
  return PARTNER_ROUTES.find((route) => route.method === method && route.pathname === pathname);
}

/** A CORS preflight is answered here and never reaches the authority. Only POST routes can be fetched cross-origin. */
export function matchPartnerPreflight(
  method: string | undefined,
  requestTarget: string | undefined,
): PartnerRoute | undefined {
  if (method !== 'OPTIONS') return undefined;
  const pathname = requestTargetPath(requestTarget);
  return PARTNER_ROUTES.find((route) => route.pathname === pathname && CORS_ROUTE_KINDS.has(route.kind));
}

/**
 * Better Auth paths the authority refuses, relative to the issuer. The router
 * compares these whole, so `/callback/:id` and `/reset-password/:token` cannot
 * be listed: `matchPartnerRoute` is what keeps those unreachable.
 */
export const PARTNER_DISABLED_PATHS: readonly string[] = [
  '/account-info',
  '/change-email',
  '/change-password',
  '/delete-user',
  '/delete-user/callback',
  '/error',
  '/get-access-token',
  '/get-session',
  '/link-social',
  '/list-accounts',
  '/list-sessions',
  '/oauth2/client/rotate-keys',
  '/oauth2/client/rotate-secret',
  '/oauth2/continue',
  '/oauth2/create-client',
  '/oauth2/delete-client',
  '/oauth2/delete-consent',
  '/oauth2/end-session',
  '/oauth2/end-session/confirm',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/introspect',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/register',
  '/oauth2/update-client',
  '/oauth2/update-consent',
  '/oauth2/userinfo',
  '/ok',
  '/refresh-token',
  '/request-password-reset',
  '/reset-password',
  '/revoke-other-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/send-verification-email',
  '/sign-in/email',
  '/sign-in/social',
  '/sign-out',
  '/sign-up/email',
  '/unlink-account',
  '/update-session',
  '/update-user',
  '/verify-email',
  '/verify-password',
];
