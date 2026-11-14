// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import * as https from 'node:https';
import * as http from 'node:http';
import GoogleProvider from 'next-auth/providers/google';
import AppleProvider from 'next-auth/providers/apple';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSetCookie } from 'cookie';
import { startConfiguredProviderTransport } from '../../backend/src/auth/current-store/__tests__/fixtures/app-router-providers';
import type { AnonymousProviderReply, WebCredentialProof } from '@boardsesh/auth-protocol';
import type {
  AnonymousProviderCommandClient,
  AnonymousProviderOperationReply,
} from '@/app/lib/auth/anonymous-provider-command-client.server';
import type { PresentedBrowserSelection } from '@/app/lib/auth/presented-browser-selection.server';

const fixture = vi.hoisted(() => {
  const origin = 'https://www.provider-outer.example.test';
  const secret = 'owned-provider-outer-nextauth-secret-6975';
  process.env.NEXTAUTH_URL = origin;
  process.env.NEXTAUTH_SECRET = secret;
  return {
    origin,
    secret,
    selected: undefined as PresentedBrowserSelection | undefined,
    client: undefined as AnonymousProviderCommandClient | undefined,
    ready: true,
    fault: '',
    trace: [] as string[],
    writes: 0,
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => {
      fixture.writes += 1;
      throw new Error('Legacy write refused');
    },
    insert: () => {
      fixture.writes += 1;
      throw new Error('Legacy write refused');
    },
  }),
}));
vi.mock('@/app/lib/auth/provider-security-readiness', () => ({ publicProviderSecurityReady: () => fixture.ready }));
vi.mock('@/app/lib/auth/anonymous-provider-command-client.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/anonymous-provider-command-client.server')>()),
  createAnonymousProviderCommandClient: () => {
    if (!fixture.client) throw new Error('Missing private fixture');
    return fixture.client;
  },
}));
vi.mock('@/app/lib/auth/presented-browser-selection.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/presented-browser-selection.server')>()),
  readPresentedBrowserSelection: async () => {
    fixture.trace.push('primary-read');
    return fixture.selected;
  },
}));
vi.mock('@/app/lib/auth/browser-consumers.server', async (original) => {
  const actual = await original<typeof import('@/app/lib/auth/browser-consumers.server')>();
  return {
    ...actual,
    browserConsumerFacade: {
      ...actual.browserConsumerFacade,
      observe: async () => {
        fixture.trace.push('actual-admission');
        return fixture.selected;
      },
    },
  };
});
vi.mock('@/app/lib/auth/browser-proof-cookies.server', async (original) => {
  const actual = await original<typeof import('@/app/lib/auth/browser-proof-cookies.server')>();
  return {
    ...actual,
    buildBrowserProofCookieCandidate: (...parameters: Parameters<typeof actual.buildBrowserProofCookieCandidate>) => {
      fixture.trace.push('cookie-plan');
      if (fixture.fault === 'capacity') throw new Error('Cookie plan full');
      return actual.buildBrowserProofCookieCandidate(...parameters);
    },
  };
});
vi.mock('@/app/lib/partner-oauth/sign-in-failure-return', async (original) => {
  const actual = await original<typeof import('@/app/lib/partner-oauth/sign-in-failure-return')>();
  return {
    ...actual,
    withPartnerSignInFailureReturn: async (...parameters: Parameters<typeof actual.withPartnerSignInFailureReturn>) => {
      const response = await actual.withPartnerSignInFailureReturn(...parameters);
      fixture.trace.push('actual-partner-finished');
      if (fixture.fault === 'future-cookie')
        response.headers.append('Set-Cookie', '__Host-boardsesh.future-provider.injected=bad; Path=/; Secure');
      if (fixture.fault === 'body-error')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Late body failure'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      return response;
    },
  };
});
import { GET, POST } from '@/app/api/auth/[...nextauth]/route';
import { authOptions } from '@/app/lib/auth/auth-options';
import { providerCandidateCredentialHash } from '@/app/lib/auth/provider-security-command-client.server';
import { BROWSER_CORRELATION_COOKIE, readBrowserProofCookie } from '@/app/lib/auth/browser-proof-cookies.server';
import {
  anonymousProviderFlowCookieName,
  anonymousProviderPendingCookieName,
  openAnonymousProviderFlow,
} from '@/app/lib/auth/anonymous-provider-flow.server';
import { webOAuthFlowHash } from '@/app/lib/auth/web-oauth-continuation.server';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0, 100);
const bindingToken = 'A'.repeat(43);
const bindingId = createHash('sha256').update(bindingToken).digest('hex');
const cursor = { bindingId, version: 0, bindingExpiresAt: new Date(NOW + 3_600_000).toISOString() };
const storage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers(): Promise<Headers>;
  cookies(): Promise<{ getAll(): { name: string; value: string }[] }>;
};
const nextRequire = createRequire(require.resolve('next-auth'));
const oidc = nextRequire('openid-client') as { custom: { setHttpOptionsDefaults(settings: object): void } };
const originalCallbacks = authOptions.callbacks;
let providers: Awaited<ReturnType<typeof startConfiguredProviderTransport>>;
let cookies: Map<string, string>;
let target: WebCredentialProof;
let commits: number;
let aborts: number;
let intents: number;
let preparedIdentityKind: 'new' | 'existing';
let issuedCandidate: { kind: 'legacy-jwe' | 'canonical-token'; credential: string } | undefined;
function remember(response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const parsed = parseSetCookie(header);
    if (
      !parsed.value ||
      (parsed.maxAge !== undefined && parsed.maxAge <= 0) ||
      (parsed.expires && parsed.expires.getTime() <= Date.now())
    )
      cookies.delete(parsed.name);
    else cookies.set(parsed.name, parsed.value);
  }
}
function request(path: string, fields?: Record<string, string> | string, cookieFilter?: (name: string) => boolean) {
  return new NextRequest(path.startsWith('https:') ? path : `${fixture.origin}/api/auth/${path}`, {
    method: fields ? 'POST' : 'GET',
    headers: {
      Host: new URL(fixture.origin).host,
      Cookie: [...cookies]
        .filter(([name]) => !cookieFilter || cookieFilter(name))
        .map(([name, content]) => `${name}=${content}`)
        .join('; '),
      ...(fields ? { Origin: fixture.origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
}
function invoke(current: NextRequest): Promise<Response> {
  const context = {
    params: Promise.resolve({ nextauth: current.nextUrl.pathname.slice('/api/auth/'.length).split('/') }),
  };
  return storage.run(current, () => (current.method === 'POST' ? POST(current, context) : GET(current, context)));
}
async function start(provider: 'google' | 'apple', fault = '') {
  const csrfResponse = await invoke(request('csrf'));
  remember(csrfResponse);
  const csrfToken = ((await csrfResponse.json()) as { csrfToken: string }).csrfToken;
  const response = await invoke(
    request(`signin/${provider}`, {
      csrfToken: fault === 'csrf' ? 'wrong' : csrfToken,
      callbackUrl: `${fixture.origin}/settings`,
      json: 'true',
      ...(fault === 'asserted-uid' ? { assertedUserId: 'chosen-user' } : {}),
    }),
  );
  remember(response);
  if (response.status >= 400) return { response, state: '', hash: '', callback: undefined };
  const location = ((await response.json()) as { url: string }).url;
  const state = new URL(location).searchParams.get('state');
  if (!state) return { response, state: '', hash: '', callback: undefined };
  const callback = providers.authorize(
    location,
    { subject: 'verified-subject', email: 'verified@example.test', emailVerified: true },
    { cancel: fault === 'cancel', rejectToken: fault === 'token-reject' },
  );
  return { response, state, hash: webOAuthFlowHash(provider, state), callback };
}
async function complete(provider: 'google' | 'apple', fault = '') {
  const started = await start(provider, fault);
  if (!started.callback) return { ...started, response: started.response };
  fixture.trace = [];
  fixture.fault = fault;
  const callback = started.callback;
  let response: Response;
  if (callback.method === 'POST') {
    const before = fixture.trace.length;
    const previousCommits = commits;
    const previousAborts = aborts;
    const held = await invoke(request(callback.url, callback.form, (name) => !name.startsWith('__Host-boardsesh.')));
    expect(held.status).toBe(303);
    expect(fixture.trace.length).toBe(before);
    expect(commits).toBe(previousCommits);
    expect(aborts).toBe(previousAborts);
    remember(held);
    const continuation = held.headers.get('Location');
    if (!continuation) throw new Error('Missing actual Apple continuation');
    response = await invoke(request(continuation));
  } else response = await invoke(request(callback.url));
  return { ...started, response };
}
beforeAll(async () => {
  providers = await startConfiguredProviderTransport();
  providers.registerRedirect(fixture.origin);
  oidc.custom.setHttpOptionsDefaults({ agent: providers.agent, timeout: 3000 });
  const nativeHttps = require('node:https') as typeof https;
  const nativeHttp = require('node:http') as typeof http;
  const original = nativeHttps.request;
  mock.method(nativeHttps, 'request', (url: string | URL, options: https.RequestOptions) => {
    const parsed = new URL(url);
    if (!providers.allowedDestinations.has(`${parsed.origin}${parsed.pathname}`) || options.agent !== providers.agent)
      throw new Error('Unowned network');
    return original(url, options);
  });
  mock.method(nativeHttp, 'request', () => {
    throw new Error('Unowned HTTP');
  });
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => storage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => storage.getStore()?.cookies.getAll() ?? [],
  }));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  fixture.trace = [];
  fixture.writes = 0;
  fixture.fault = '';
  fixture.ready = true;
  vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  fixture.selected = { status: 'anonymous', cursor: { ...cursor } };
  cookies = new Map([[BROWSER_CORRELATION_COOKIE, bindingToken]]);
  commits = 0;
  aborts = 0;
  intents = 0;
  issuedCandidate = undefined;
  preparedIdentityKind = 'new';
  target = {
    version: 1,
    userId: 'backend-created-user',
    authSessionId: 'backend-fixed-session',
    generation: 0,
    authenticatedAt: null,
    linkGuarded: false,
  };
  authOptions.providers = [
    GoogleProvider({ clientId: providers.clients.google.id, clientSecret: providers.clients.google.secret }),
    AppleProvider({
      clientId: providers.clients.apple.id,
      clientSecret: providers.clients.apple.secret,
      checks: ['pkce', 'state'],
    }),
  ];
  authOptions.callbacks = {
    ...originalCallbacks,
    signIn: async () => {
      fixture.writes += 1;
      throw new Error('Legacy identity writer');
    },
  };
  authOptions.events = {
    signIn: async () => {
      fixture.trace.push('actual-signin-event');
      if (fixture.fault === 'event') throw new Error('Late event failure');
    },
  };
  fixture.client = {
    async command(operation, payload) {
      fixture.trace.push(`private-${operation}`);
      expect(payload).not.toHaveProperty('actor');
      expect(payload.browser).toEqual({ bindingToken, expectedVersion: 0 });
      const metadata = { anonymousProviderVersion: 1 as const, requestId: '00000000-0000-4000-8000-000000000000' };
      let reply: AnonymousProviderReply;
      if (operation === 'intent') {
        intents += 1;
        expect('credentialKind' in payload && payload.credentialKind).toBe('canonical-token');
        reply = {
          ...metadata,
          operation,
          outcome: 'recorded',
          intentToken: 'B'.repeat(43),
          browserIntentToken: 'C'.repeat(43),
          browserCursor: cursor,
          expiresAt: new Date(NOW + 300_000).toISOString(),
        };
      } else if (operation === 'prepare') {
        if (!('providerProof' in payload)) throw new Error('Missing verified provider');
        expect(payload.providerProof.identity.sub).toBe('verified-subject');
        expect(
          payload.providerProof.provider === 'google'
            ? typeof payload.providerProof.idToken
            : payload.providerProof.idToken,
        ).toBe(payload.providerProof.provider === 'google' ? 'string' : null);
        if (fixture.fault === 'drift') fixture.selected = { status: 'proof-required' };
        const proposal = 'P'.repeat(43);
        reply = {
          ...metadata,
          operation,
          outcome: 'prepared',
          preparationToken: 'D'.repeat(43),
          proposedCanonicalToken: proposal,
          browserCursor: cursor,
          preparation: {
            credentialKind: 'canonical-token',
            verifiedIdentity: payload.providerProof.identity,
            identityPlan: {
              kind: preparedIdentityKind,
              provider: payload.providerProof.provider,
              subject: payload.providerProof.identity.sub,
              generation: target.generation,
              user: {
                id: target.userId,
                email: 'stored@example.test',
                name: 'Stored backend name',
                image: null,
                emailVerified: null,
                createdAt: preparedIdentityKind === 'new' ? new Date(NOW).toISOString() : '2019-01-01T00:00:00.000Z',
              },
            },
            credentialProof: { ...target },
            credentialExpiresAt: new Date(Math.floor((NOW + 3_600_000) / 1000) * 1000).toISOString(),
            expiresAt: new Date(NOW + 300_000).toISOString(),
            proposedCanonicalTokenHash: providerCandidateCredentialHash({
              kind: 'canonical-token',
              credential: proposal,
            }),
          },
        };
      } else if (operation === 'abort') {
        aborts += 1;
        reply = { ...metadata, operation, outcome: 'aborted' };
      } else {
        if (!('candidate' in payload)) throw new Error('Missing actual candidate');
        expect(fixture.trace).toContain('actual-partner-finished');
        expect(fixture.trace).toContain('actual-admission');
        expect(fixture.trace).toContain('cookie-plan');
        expect(fixture.trace).toContain('actual-signin-event');
        issuedCandidate = payload.candidate;
        commits += 1;
        if (fixture.fault === 'lost-finalizer') throw new Error('Unknown finalizer outcome');
        reply = {
          ...metadata,
          operation: 'finalize',
          outcome: 'committed',
          candidateCredentialHash: providerCandidateCredentialHash(payload.candidate),
          browserCursor: { ...cursor, version: 1 },
        };
      }
      return reply as AnonymousProviderOperationReply<typeof operation>;
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  mock.restoreAll();
  vi.restoreAllMocks();
  oidc.custom.setHttpOptionsDefaults({ agent: undefined });
  await providers.close();
});

describe('actual production OAuth outer route and installed NextAuth', () => {
  it.each(['google', 'apple'] as const)(
    'composes %s positive anonymous sign-in for both new and returning owners',
    async (provider) => {
      for (const kind of ['new', 'existing'] as const) {
        preparedIdentityKind = kind;
        target = {
          ...target,
          userId: kind === 'new' ? 'backend-created-user' : 'stable-existing-user',
          generation: kind === 'new' ? 0 : 7,
        };
        const result = await complete(provider);
        expect(result.response.status, JSON.stringify(fixture.trace)).toBe(302);
        expect(result.response.headers.get('Location')).toBe(`${fixture.origin}/settings`);
        expect(commits).toBe(kind === 'new' ? 1 : 2);
        expect(aborts).toBe(0);
        expect(fixture.writes).toBe(0);
        expect(issuedCandidate).toEqual({ kind: 'canonical-token', credential: 'P'.repeat(43) });
        const headers = result.response.headers.getSetCookie();
        expect(headers.some((header) => header.startsWith(anonymousProviderPendingCookieName(result.hash)))).toBe(
          false,
        );
        expect(headers.some((header) => header.includes('next-auth.session-token'))).toBe(false);
        remember(result.response);
        const flow = await openAnonymousProviderFlow(
          cookies.get(anonymousProviderFlowCookieName(result.hash))!,
          result.hash,
          fixture.secret,
        );
        expect(flow.preparation?.identityPlan.kind).toBe(kind);
        expect(flow.preparation?.credentialProof).toEqual(target);
        const proof = readBrowserProofCookie([...cookies].map(([name, content]) => `${name}=${content}`).join('; '), {
          bindingId,
          version: 1,
        });
        expect(proof.status).toBe('present');
        if (proof.status === 'present')
          expect(proof.proof).toEqual({ kind: 'canonical-token', rawCredential: 'P'.repeat(43) });
        // A second independent anonymous binding observation is supplied for the matrix.
        cookies = new Map([[BROWSER_CORRELATION_COOKIE, bindingToken]]);
        fixture.trace = [];
      }
    },
  );
  it.each(['event', 'capacity', 'future-cookie', 'body-error', 'drift', 'cancel', 'token-reject'])(
    'withholds every cookie and finalizer on %s',
    async (fault) => {
      const result = await complete('google', fault);
      expect(result.response.status).toBe(503);
      expect(result.response.headers.getSetCookie()).toEqual([]);
      expect(commits).toBe(0);
      expect(fixture.writes).toBe(0);
    },
  );
  it('does not retry or abort after an uncertain SQL finalizer', async () => {
    const result = await complete('google', 'lost-finalizer');
    expect(result.response.status).toBe(503);
    expect(result.response.headers.getSetCookie()).toEqual([]);
    expect(commits).toBe(1);
    expect(aborts).toBe(0);
  });
  it.each(['proof-required', 'missing-binding', 'denied', 'conflict', 'unavailable'] as const)(
    'never converts %s to an anonymous identity command',
    async (status) => {
      fixture.selected = { status };
      const result = await start('google');
      expect(result.response.status).toBe(503);
      expect(intents).toBe(0);
      expect(commits).toBe(0);
    },
  );
  it('rejects a claimed UID before any private intent or provider exchange', async () => {
    const result = await start('google', 'asserted-uid');
    expect(result.response.status).toBe(503);
    expect(intents).toBe(0);
  });
  it('keeps the code readiness floor closed before private commands', async () => {
    fixture.ready = false;
    const result = await start('google');
    expect(result.response.status).toBe(503);
    expect(intents).toBe(0);
  });
  it('keeps Facebook closed before provider, identity or cookie work', async () => {
    const response = await invoke(request('callback/facebook?state=not-a-provider-flow'));
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(intents).toBe(0);
    expect(commits).toBe(0);
  });
});
