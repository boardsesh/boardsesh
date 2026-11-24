/** Public documents only. Keep the edge rule and origin eligibility identical. */
export const MARKETING_CACHE_PATHS = [
  '/',
  '/apps',
  '/apps/kilter',
  '/apps/aurora',
  '/apps/moonboard',
  '/apps/woods',
  '/compare/spray-wall-apps',
] as const;

export const MARKETING_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=300';
export const MARKETING_CDN_CACHE_CONTROL = 's-maxage=300, stale-while-revalidate=300';
export const MARKETING_SESSION_COOKIE_SUBSTRINGS = [
  'next-auth.session-token',
  'boardsesh.session_token',
  'boardsesh.bridged_session_token',
] as const;
export const MARKETING_LOCALE_COOKIE = 'boardsesh-locale';
export const MARKETING_ROUTER_HEADERS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
] as const;
export const MARKETING_CACHE_VARY = ['Cookie', 'Authorization', ...MARKETING_ROUTER_HEADERS].join(', ');

export function isCacheableMarketingRequest(request: {
  method: string;
  pathname: string;
  search: string;
  headers: Pick<Headers, 'get' | 'has'>;
}): boolean {
  const { method, pathname, search, headers } = request;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!(MARKETING_CACHE_PATHS as readonly string[]).includes(pathname) || search !== '') return false;
  if (headers.has('authorization') || MARKETING_ROUTER_HEADERS.some((header) => headers.has(header))) return false;
  const cookies = headers.get('cookie') ?? '';
  if (MARKETING_SESSION_COOKIE_SUBSTRINGS.some((name) => cookies.includes(name))) return false;
  // A hit at the edge never executes the saved-language redirect in middleware.
  return pathname !== '/' || !cookies.includes(MARKETING_LOCALE_COOKIE);
}
