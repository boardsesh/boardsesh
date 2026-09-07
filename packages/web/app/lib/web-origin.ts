import 'server-only';

/** Shared secret is server-only; never use a NEXT_PUBLIC_ variable for it. */
export const WEB_ORIGIN_HEADER = 'x-boardsesh-origin-verify';

export function acceptsWebOrigin(request: Request, pathname: string): boolean {
  if (process.env.WEB_ORIGIN_VERIFY_ENABLED !== '1') return true;
  // Railway probes only this cheap endpoint; no prefix or locale exceptions.
  if (pathname === '/api/health' && (request.method === 'GET' || request.method === 'HEAD')) return true;
  const expectedSecret = process.env.WEB_ORIGIN_VERIFY_SECRET;
  const suppliedSecret = request.headers.get(WEB_ORIGIN_HEADER);
  if (!expectedSecret || expectedSecret.length < 32 || !suppliedSecret) return false;
  // Compare every expected character rather than exposing the matching prefix.
  let difference = expectedSecret.length ^ suppliedSecret.length;
  for (let index = 0; index < expectedSecret.length; index++) {
    difference |= expectedSecret.charCodeAt(index) ^ suppliedSecret.charCodeAt(index);
  }
  return difference === 0;
}

/** Paths that used locale/session/CORS middleware before origin protection. */
export function needsPageMiddleware(pathname: string): boolean {
  if (/^\/api\/(v1|auth)(\/|$)/.test(pathname) || pathname === '/api/internal/ws-auth') return true;
  return (
    !/^(?:\/api\/|\/_next\/static|\/_next\/image|\/favicon.ico|\/monitoring|\/\.well-known\/)/.test(pathname) &&
    !pathname.includes('.')
  );
}
