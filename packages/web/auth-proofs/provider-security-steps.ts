/**
 * A browser's steps against www's provider-security routes (#7596 B5e1), for
 * the proofs that drive them over the real backend. No mocks live here; each
 * proof file declares its own and passes the routes in.
 */
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { expect } from 'vite-plus/test';
import { CookieJar, ORIGIN, callRoute, setCookies, type AuthRoute } from './route-harness';
import { BRIDGED, LEGACY, LOGIN, randomClientAddress, sessionCookieNamesIn } from './web-session-harness';
import type { GoogleIdentity } from './google-oidc-fixture';

export const FLOW_COOKIE = '__Host-boardsesh.provider-flow';
const EXPECTED_VIEWER_HEADER = 'X-Boardsesh-Expected-Viewer';

type StepRoute = {
  GET: (request: NextRequest, context: { params: Promise<{ step: string[] }> }) => Promise<Response>;
  POST: (request: NextRequest, context: { params: Promise<{ step: string[] }> }) => Promise<Response>;
};
type GoogleStandIn = { authorize: (url: string, identity: GoogleIdentity) => Promise<string> };

/**
 * The provider-security tables, which the shared test schema leaves out: the
 * same two migrations the backend's provider-security fixture applies.
 */
export async function addProviderSecurityTables(client: { unsafe: (query: string) => PromiseLike<unknown> }) {
  for (const filename of ['0312_browser_binding_selection.sql', '0313_provider_security_receipts.sql'])
    await client.unsafe(readFileSync(new URL(`../../db/drizzle/${filename}`, import.meta.url), 'utf8'));
}

/** HARD RULE 2: a provider-security reply sets and clears no session cookie of any name. */
export function expectNoSessionCookie(response: Response): void {
  expect(sessionCookieNamesIn(response)).toEqual([]);
  for (const header of setCookies(response))
    for (const name of [LOGIN, BRIDGED, LEGACY, 'next-auth.session-token'])
      expect(header.startsWith(`${name}=`) || header.startsWith(`${name}.`)).toBe(false);
}

export function providerSecuritySteps(route: StepRoute, authRoute: AuthRoute, google: GoogleStandIn) {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    jar: CookieJar,
    options: {
      body?: unknown;
      viewer?: string | null;
      origin?: string | null;
      cookie?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const url = new URL(`/api/auth/provider-security/${path}`, ORIGIN);
    const headers = new Headers({ 'x-forwarded-for': randomClientAddress(), ...options.headers });
    headers.set('cookie', options.cookie ?? jar.header());
    if (method === 'POST') {
      if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
      headers.set('content-type', 'application/json');
      if (options.viewer) headers.set(EXPECTED_VIEWER_HEADER, options.viewer);
    }
    const request = new NextRequest(url, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
    const step = url.pathname.split('/api/auth/provider-security/')[1].split('/');
    const response = await route[method](request, { params: Promise.resolve({ step }) });
    expectNoSessionCookie(response);
    return response;
  }

  /** The tab's expected-viewer key, from the session read (as the www guard sends it). */
  async function viewerOf(jar: CookieJar): Promise<string> {
    const response = await callRoute(authRoute, '/api/auth/session', {
      cookie: jar.header(),
      headers: { 'x-forwarded-for': randomClientAddress() },
    });
    const session = (await response.json()) as { user?: { id?: string }; authSessionId?: string };
    if (!session.user?.id || !session.authSessionId) throw new Error('The jar is not signed in');
    return `${session.user.id}:${session.authSessionId}`;
  }

  async function post(path: string, jar: CookieJar, body: unknown = {}, viewer?: string): Promise<Response> {
    const response = await call('POST', path, jar, { body, viewer: viewer ?? (await viewerOf(jar)) });
    jar.apply(response);
    return response;
  }

  /** Google's answer to an authorization URL, delivered to the given callback path, as the browser follows it. */
  async function followGoogle(
    jar: CookieJar,
    authorizationUrl: string,
    identity: GoogleIdentity,
    callbackPath?: string,
  ) {
    const callback = new URL(await google.authorize(authorizationUrl, identity));
    const path = callbackPath ?? callback.pathname;
    const target = `${path}${callback.search}`;
    if (path.startsWith('/api/auth/provider-security/')) {
      const response = await call('GET', target.slice('/api/auth/provider-security/'.length), jar);
      jar.apply(response);
      return { response, callback };
    }
    const response = await callRoute(authRoute, target, {
      cookie: jar.header(),
      headers: { 'x-forwarded-for': randomClientAddress() },
    });
    jar.apply(response);
    return { response, callback };
  }

  /** The `providerSecurity` result a callback's 303 names. */
  function resultOf(response: Response): string | null {
    expect(response.status).toBe(303);
    const location = response.headers.get('location');
    return location ? new URL(location).searchParams.get('providerSecurity') : null;
  }

  /** A Google sign-in through NextAuth's route (B5b), as the login page's button starts it. */
  async function googleSignIn(jar: CookieJar, identity: GoogleIdentity, csrfToken: string) {
    const start = await callRoute(authRoute, '/api/auth/signin/google', {
      cookie: jar.header(),
      form: { csrfToken, callbackUrl: `${ORIGIN}/`, json: 'true' },
      headers: { 'x-forwarded-for': randomClientAddress() },
    });
    jar.apply(start);
    const { url } = (await start.clone().json()) as { url: string };
    return { url, ...(await followGoogle(jar, url, identity)) };
  }

  /** The whole link of a Google identity, after a password reauthentication. */
  async function linkGoogleWithPassword(jar: CookieJar, identity: GoogleIdentity, password: string) {
    const started = await post('start', jar, { action: 'link', provider: 'google', returnTo: '/settings' });
    expect(started.status).toBe(200);
    const proved = await post('reauthenticate/password', jar, { password });
    const { url } = (await proved.json()) as { url: string };
    const { response } = await followGoogle(jar, url, identity);
    return resultOf(response);
  }

  /** The account's methods, as the signed-in browser reads them. */
  async function methodsOf(jar: CookieJar) {
    const response = await call('GET', 'methods', jar);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      passwordUsable: boolean;
      providers: { methodId: string; provider: string; canUnlink: boolean }[];
      reauthentication: { password: boolean; google: boolean; apple: boolean };
      linking: Record<'google' | 'apple', { available: boolean; reason?: string }>;
    };
  }

  return { call, post, viewerOf, followGoogle, resultOf, googleSignIn, linkGoogleWithPassword, methodsOf };
}

export function flowCookieOf(response: Response): string | undefined {
  return setCookies(response).find((header) => header.startsWith(`${FLOW_COOKIE}=`));
}
