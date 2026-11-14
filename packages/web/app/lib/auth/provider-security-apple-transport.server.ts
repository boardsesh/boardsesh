import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import { NextRequest } from 'next/server';
import { providerSecurityMode } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import {
  findWebOAuthCallbackScope,
  holdAppleOAuthCallback,
  readAppleOAuthCallbackState,
} from './web-oauth-continuation.server';

const callbackPath = '/api/auth/callback/apple';

/** Transport normalization only. A signed flow-state cookie admits this bounded
 * POST to a same-WWW GET; it never admits an account, exchanges a provider code,
 * or supplies missing Lax source/operation cookies. The resumed GET must pass
 * the ordinary actual-source and exact operation admission before any command.
 * Mount this before selected-source response admission, never as its bypass. */
export async function normalizeProviderSecurityAppleCallback(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly nextauth: readonly string[] }> },
  base: NextAuthOptions,
  dependencies: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
  } = {},
): Promise<Response | null> {
  const method = request.method;
  const pathname = request.nextUrl.pathname;
  if (method !== 'POST' || pathname !== callbackPath) return null;
  const environment = Object.freeze({ ...(dependencies.environment ?? process.env) });
  const ready = dependencies.ready ?? publicProviderSecurityReady;
  try {
    if (providerSecurityMode(environment) === 'legacy') return null;
    if (
      !ready() ||
      browserBindingMode(environment) !== 'backend-staging' ||
      environment.CURRENT_STORE_WEB_OAUTH_MODE !== 'backend-staging'
    )
      return unavailableCredentialResponse();
    // Capture the request and issuer configuration before even route parameters
    // await. A wrapper retaining either input cannot retarget the signed state.
    const capturedHeaders = new Headers(request.headers);
    const origin = resolvePublicAuthOrigin(environment);
    if (!origin || new URL(origin).protocol !== 'https:' || capturedHeaders.get('host') !== new URL(origin).host)
      return unavailableCredentialResponse();
    const cookies = Object.fromEntries(
      Object.entries(base.cookies ?? {}).map(([name, cookie]) => [name, { ...cookie, options: { ...cookie.options } }]),
    );
    const issuer: NextAuthOptions = { ...base, cookies, secret: base.secret ?? environment.NEXTAUTH_SECRET };
    const configured = issuer.providers.find((provider) => (provider.options?.id ?? provider.id) === 'apple');
    if (configured?.type !== 'oauth' || !issuer.secret) return unavailableCredentialResponse();
    const observed = capturedHeaders.get('cookie') ?? '';
    if (Buffer.byteLength(observed) > 32_768 || observed.split(';').length > 128)
      return unavailableCredentialResponse();
    const snapshot = new NextRequest(request.clone(), { headers: capturedHeaders });
    const route = [...(await context.params).nextauth];
    if (route[0] !== 'callback' || route[1] !== 'apple' || route.length !== 2) return unavailableCredentialResponse();
    if (snapshot.nextUrl.pathname !== callbackPath || snapshot.signal.aborted) return unavailableCredentialResponse();
    const state = await readAppleOAuthCallbackState(snapshot);
    const scope = await findWebOAuthCallbackScope(snapshot, issuer, 'apple', state);
    const held = await holdAppleOAuthCallback(snapshot, issuer, scope, state);
    // The existing holder reads canonical deployment configuration itself;
    // require it to agree with this request's captured origin after all awaits.
    if (
      snapshot.signal.aborted ||
      held.status !== 303 ||
      held.headers.get('Location') !== `${origin}${callbackPath}?boardseshOAuthContinue=${scope}` ||
      held.body !== null
    )
      return unavailableCredentialResponse();
    const expected = `__Secure-boardsesh.web-oauth.apple.${scope}`;
    const headers = held.headers.getSetCookie();
    if (headers.length < 1 || headers.length > 2) return unavailableCredentialResponse();
    const names = headers.map((header) => header.split('=', 1)[0]);
    if (
      (headers.length === 1 ? names[0] !== expected : names[0] !== `${expected}.0` || names[1] !== `${expected}.1`) ||
      headers.some(
        (header) =>
          Buffer.byteLength(header) > 4096 ||
          !header.includes(`; Path=${callbackPath}; Max-Age=60; HttpOnly; SameSite=Lax; Secure`) ||
          /;\s*Domain=/i.test(header),
      )
    )
      return unavailableCredentialResponse();
    return held;
  } catch {
    return unavailableCredentialResponse();
  }
}
