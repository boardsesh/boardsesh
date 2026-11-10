import {
  ApiErrorResponseSchema,
  MeResponseSchema,
  type ApiErrorResponse,
  type MeResponse,
} from '@boardsesh/public-api';
import { staticPathToMediaRedirect } from '../../lib/media-url';

/**
 * The HTTP side of the public `/v1` API on api.boardsesh.com: its routes, the
 * bearer header, and the response bodies, each checked against the strict
 * `@boardsesh/public-api` schema before it is sent. Nothing here touches the
 * database or the partner authority.
 */

export type PublicApiRouteKind = 'me' | 'connection' | 'logbook-changes' | 'logbook-tick' | 'openapi';

export interface PublicApiRoute {
  method: 'GET' | 'DELETE';
  /** The whole path, byte for byte. */
  pathname: string;
  kind: PublicApiRouteKind;
}

/** A matched `/v1` request: the route, and the tick id for `GET /v1/logbook/ticks/{id}`. */
export interface PublicApiRequestRoute extends PublicApiRoute {
  /** The raw path segment after `/v1/logbook/ticks/`. Validated by the route, which answers 404 for anything else. */
  tickId?: string;
}

/** Everything `/v1` serves with a fixed path. */
export const PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  { method: 'GET', pathname: '/v1/me', kind: 'me' },
  { method: 'DELETE', pathname: '/v1/connection', kind: 'connection' },
  { method: 'GET', pathname: '/v1/logbook/changes', kind: 'logbook-changes' },
  { method: 'GET', pathname: '/v1/openapi.json', kind: 'openapi' },
];

/** `GET /v1/logbook/ticks/{id}`: one non-empty path segment after the prefix. */
const TICK_PATH_PREFIX = '/v1/logbook/ticks/';
const TICK_ROUTE: PublicApiRoute = { method: 'GET', pathname: `${TICK_PATH_PREFIX}{id}`, kind: 'logbook-tick' };

/** The path exactly as sent: a trailing slash, different case or encoded byte is another path. */
function requestTargetPath(requestTarget: string | undefined): string {
  if (!requestTarget) return '';
  const queryStart = requestTarget.indexOf('?');
  return queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
}

function tickIdSegment(pathname: string): string | undefined {
  if (!pathname.startsWith(TICK_PATH_PREFIX)) return undefined;
  const segment = pathname.slice(TICK_PATH_PREFIX.length);
  return segment.length > 0 && !segment.includes('/') ? segment : undefined;
}

export function matchPublicApiRoute(
  method: string | undefined,
  requestTarget: string | undefined,
): PublicApiRequestRoute | undefined {
  const pathname = requestTargetPath(requestTarget);
  const fixed = PUBLIC_API_ROUTES.find((route) => route.method === method && route.pathname === pathname);
  if (fixed) return fixed;
  const tickId = method === TICK_ROUTE.method ? tickIdSegment(pathname) : undefined;
  return tickId === undefined ? undefined : { ...TICK_ROUTE, tickId };
}

/**
 * A CORS preflight for a `/v1` route an app calls with a token. Answered
 * without reading any token. The OpenAPI document needs none: it is a plain GET.
 */
export function matchPublicApiPreflight(
  method: string | undefined,
  requestTarget: string | undefined,
): PublicApiRoute | undefined {
  if (method !== 'OPTIONS') return undefined;
  const pathname = requestTargetPath(requestTarget);
  const fixed = PUBLIC_API_ROUTES.find((route) => route.kind !== 'openapi' && route.pathname === pathname);
  if (fixed) return fixed;
  return tickIdSegment(pathname) === undefined ? undefined : TICK_ROUTE;
}

/**
 * RFC 6750 section 2.1: `Bearer` and one b64token. A token offered any other
 * way (a query parameter, a body field) is not read.
 */
const BEARER_AUTHORIZATION = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;
/** Opaque tokens are 32 characters today. Anything this long is not one, and is not worth hashing. */
const MAX_BEARER_LENGTH = 512;

export type ParsedBearer =
  | { token: string; problem?: undefined }
  | { token?: undefined; problem: 'missing' | 'malformed' };

export function parseBearerAuthorization(header: string | undefined): ParsedBearer {
  if (header === undefined || header === '') return { problem: 'missing' };
  const token = BEARER_AUTHORIZATION.exec(header)?.[1];
  if (!token || token.length > MAX_BEARER_LENGTH) return { problem: 'malformed' };
  return { token };
}

/**
 * The image hosts of the sign-in providers whose picture lands in
 * `users.image` (`web/app/lib/auth/auth-options.ts`): Google's profile photo
 * hosts, and Facebook's `picture.data.url` host and CDN. Sign in with Apple
 * shares no picture, so it has none.
 */
const SIGN_IN_PROVIDER_IMAGE_HOSTS: ReadonlyArray<(hostname: string) => boolean> = [
  (hostname) => /^lh\d+\.googleusercontent\.com$/.test(hostname),
  (hostname) => hostname === 'platform-lookaside.fbsbx.com' || hostname.endsWith('.fbcdn.net'),
];

/**
 * Only a URL on our own media host or a sign-in provider's image host, over
 * https, with no credentials and no port. A climber can type any URL into
 * their profile, and an app that fetches avatars on its server must never be
 * pointed at an internal host or its own cloud metadata service.
 */
function isServableAvatarUrl(candidate: string, mediaBaseUrl: string | null): boolean {
  if (!URL.canParse(candidate)) return false;
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const mediaOrigin = mediaBaseUrl && URL.canParse(mediaBaseUrl) ? new URL(mediaBaseUrl).origin : null;
  if (url.origin === mediaOrigin) return true;
  return SIGN_IN_PROVIDER_IMAGE_HOSTS.some((isProviderHost) => isProviderHost(url.hostname));
}

/**
 * An https URL an app can put in an `<img>`, or null. Uploaded avatars are
 * stored as backend-relative `/static/avatars/…` paths, so those become the
 * public media URL the backend would redirect them to. A sign-in provider's
 * picture passes as it is. Anything else (`javascript:`, `data:`, a bare path,
 * another host, junk) is null. The contract's own `z.httpUrl()` has the last
 * word, so this can never send a value the response schema would refuse.
 */
export function publicAvatarUrl(stored: string | null, mediaBaseUrl: string | null): string | null {
  const trimmed = stored?.trim();
  if (!trimmed) return null;
  let candidate: string | null = trimmed;
  if (trimmed.startsWith('/static/')) {
    if (!mediaBaseUrl) return null;
    const relative = new URL(trimmed, 'https://backend.invalid');
    candidate = staticPathToMediaRedirect(relative.pathname, relative.searchParams, mediaBaseUrl);
  }
  if (!candidate || !isServableAvatarUrl(candidate, mediaBaseUrl)) return null;
  // Send the URL as this parser understood it, never the raw string. Parsers
  // disagree on oddities such as `https://good.host\@other.host/`: WHATWG reads
  // good.host, curl and Python read other.host. The serialized form
  // (`https://good.host/@other.host/`) reads the same everywhere.
  const serialized = new URL(candidate).href;
  return MeResponseSchema.shape.avatarUrl.safeParse(serialized).success ? serialized : null;
}

export interface ClimberRecord {
  subject: string;
  profile?: { displayName: string | null; avatarUrl: string | null };
}

/** The `/v1/me` body. Throws if it would not match the contract, so nothing outside it is ever sent. */
export function presentMe(record: ClimberRecord, mediaBaseUrl: string | null): MeResponse {
  const body: MeResponse = { id: record.subject };
  if (record.profile) {
    body.displayName = record.profile.displayName;
    body.avatarUrl = publicAvatarUrl(record.profile.avatarUrl, mediaBaseUrl);
  }
  return MeResponseSchema.parse(body);
}

export type PublicApiErrorCode = ApiErrorResponse['error'];

/** The documented error body. Never a stack trace, a query or a token. `field` names the parameter that failed validation. */
export function apiErrorBody(
  error: PublicApiErrorCode,
  message: string,
  requestId: string,
  field?: string,
): ApiErrorResponse {
  return ApiErrorResponseSchema.parse({ error, message, requestId, ...(field ? { field } : {}) });
}
