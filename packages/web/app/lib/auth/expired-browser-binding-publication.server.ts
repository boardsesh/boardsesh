import 'server-only';
import { browserCoordinatorResultSchema } from '@boardsesh/auth-protocol/browser-coordinator';
import { expiredBrowserBindingBrowserPreparationReplySchema } from '@boardsesh/auth-protocol/expired-browser-binding-browser-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  BROWSER_CORRELATION_COOKIE,
  BROWSER_PROOF_COOKIE_LIMITS,
  buildCanonicalCoordinatorCorrelationCookie,
} from './browser-proof-cookies.server';
import {
  EXPIRED_BROWSER_BINDING_CARRIER_PREFIX,
  type ExpiredBrowserBindingCarrier,
} from './expired-browser-binding-carrier.server';
import { boundedAuthCookiePairs } from './public-auth-request.server';

/** Materialize the complete response and projected next request before a writer.
 * The body is strictly metadata; only this purpose's cookies may be changed. */
export function bufferExpiredBrowserBindingResponse(
  body: unknown,
  status: number,
  cookies: readonly string[],
  observedCookieHeader: string | null,
): Response {
  const parsed = expiredBrowserBindingBrowserPreparationReplySchema.parse(body);
  const serialized = JSON.stringify(parsed);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, follow',
    'X-Content-Type-Options': 'nosniff',
  });
  if (status === 429 || status === 503) headers.set('Retry-After', '1');
  if (cookies.length > BROWSER_PROOF_COOKIE_LIMITS.responseHeaders) throw new AuthBackendUnavailableError();
  const replaced = new Set<string>();
  const added: string[] = [];
  let headerBytes = 0;
  for (const cookie of cookies) {
    if (/[\r\n]/.test(cookie) || Buffer.byteLength(cookie) > BROWSER_PROOF_COOKIE_LIMITS.cookieHeaderBytes)
      throw new AuthBackendUnavailableError();
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator < 1) throw new AuthBackendUnavailableError();
    const name = pair.slice(0, separator);
    if (
      replaced.has(name) ||
      (name !== BROWSER_CORRELATION_COOKIE && !name.startsWith(EXPIRED_BROWSER_BINDING_CARRIER_PREFIX))
    )
      throw new AuthBackendUnavailableError();
    replaced.add(name);
    if (pair.slice(separator + 1)) added.push(pair);
    headerBytes += Buffer.byteLength(`Set-Cookie: ${cookie}\r\n`);
    headers.append('Set-Cookie', cookie);
  }
  for (const [name, content] of headers)
    if (name !== 'set-cookie') headerBytes += Buffer.byteLength(`${name}: ${content}\r\n`);
  const projected = [
    ...boundedAuthCookiePairs(observedCookieHeader)
      .filter((pair) => !replaced.has(pair.name))
      .map((pair) => `${pair.name}=${pair.content}`),
    ...added,
  ];
  if (
    Buffer.byteLength(serialized) > 8192 ||
    headerBytes > BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes ||
    projected.length > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs ||
    Buffer.byteLength(projected.join('; ')) > BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes
  )
    throw new AuthBackendUnavailableError();
  return new Response(serialized, { status, headers });
}

export function expiredBrowserBindingTargetResponse(
  carrier: Readonly<ExpiredBrowserBindingCarrier>,
  header: string | null,
  origin: string,
): Response {
  const cursor = carrier.preparation.targetCursor;
  return bufferExpiredBrowserBindingResponse(
    browserCoordinatorResultSchema.parse({ status: 'ready', cursor: { bindingId: cursor.bindingId, version: 0 } }),
    200,
    [
      buildCanonicalCoordinatorCorrelationCookie({
        servingOrigin: origin,
        canonicalOrigin: origin,
        token: carrier.targetBindingToken,
        bindingId: cursor.bindingId,
      }),
    ],
    header,
  );
}

/** Clear only the exact operation whose complete physical target was confirmed.
 * Old proofs and every unrelated operation remain untouched. */
export function expiredBrowserBindingConfirmedResponse(
  carrier: Readonly<ExpiredBrowserBindingCarrier>,
  operationKey: string,
  header: string | null,
): Response {
  const base = EXPIRED_BROWSER_BINDING_CARRIER_PREFIX + operationKey;
  const clears = boundedAuthCookiePairs(header)
    .filter((pair) => pair.name === base || pair.name.startsWith(`${base}.`))
    .map((pair) => `${pair.name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  return bufferExpiredBrowserBindingResponse(
    { status: 'ready', cursor: { bindingId: carrier.preparation.targetCursor.bindingId, version: 0 } },
    200,
    clears,
    header,
  );
}
