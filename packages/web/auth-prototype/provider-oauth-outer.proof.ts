// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import * as https from 'node:https';
import * as http from 'node:http';
import GoogleProvider from 'next-auth/providers/google';
import AppleProvider from 'next-auth/providers/apple';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSetCookie } from 'cookie';
import { startConfiguredProviderTransport } from '../../backend/src/auth/current-store/__tests__/fixtures/app-router-providers';
import type { AnonymousProviderReply, ProviderSecurityReply, WebCredentialProof } from '@boardsesh/auth-protocol';
import type {
  ProviderSecurityCommandClient,
  ProviderSecurityOperationReply,
} from '@/app/lib/auth/provider-security-command-client.server';
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
  process.env.CURRENT_STORE_PROVIDER_SECURITY_MODE = 'backend-staging';
  process.env.CURRENT_STORE_BROWSER_BINDING_MODE = 'backend-staging';
  process.env.CURRENT_STORE_WEB_OAUTH_MODE = 'backend-staging';
  return {
    origin,
    secret,
    selected: undefined as PresentedBrowserSelection | undefined,
    client: undefined as AnonymousProviderCommandClient | undefined,
    providerClient: undefined as ProviderSecurityCommandClient | undefined,
    ready: true,
    internalRequestUrl: false,
    legacyConsumer: false,
    primaryReads: 0,
    fault: '',
    trace: [] as string[],
    commands: [] as string[],
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
vi.mock('@/app/lib/auth/web-oauth-command-client.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/web-oauth-command-client.server')>()),
  createWebOAuthCommandClient: () => ({
    intent: async () => {
      fixture.trace.push('legacy-intent');
      return { outcome: 'recorded' };
    },
    resolve: async () => {
      fixture.trace.push('legacy-resolve');
      throw new Error('Unexpected legacy identity resolution');
    },
  }),
}));
vi.mock('@/app/lib/auth/provider-security-readiness', () => ({ publicProviderSecurityReady: () => fixture.ready }));
vi.mock('@/app/lib/auth/browser-coordinator-readiness', () => ({ publicBrowserCoordinatorReady: () => fixture.ready }));
vi.mock('@/app/lib/auth/anonymous-provider-command-client.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/anonymous-provider-command-client.server')>()),
  createAnonymousProviderCommandClient: () => {
    if (!fixture.client) throw new Error('Missing private fixture');
    return fixture.client;
  },
}));
vi.mock('@/app/lib/auth/provider-security-command-client.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/provider-security-command-client.server')>()),
  createProviderSecurityCommandClient: () => {
    if (!fixture.providerClient) throw new Error('Missing signed-in private fixture');
    return fixture.providerClient;
  },
}));
vi.mock('@/app/lib/auth/presented-browser-selection.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/presented-browser-selection.server')>()),
  readPresentedBrowserSelection: async () => {
    fixture.trace.push('primary-read');
    fixture.primaryReads += 1;
    if (fixture.fault === 'observer-drift' && fixture.primaryReads >= 5)
      fixture.selected = { status: 'proof-required' };
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
        return fixture.legacyConsumer ? { status: 'legacy' } : fixture.selected;
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
      if (fixture.fault === 'wrong-path-capacity')
        response.headers.append('Set-Cookie', 'retained-browser-cookie=; Max-Age=0; Path=/other; Secure');
      if (fixture.fault === 'wrong-domain-capacity')
        response.headers.append(
          'Set-Cookie',
          'retained-browser-cookie=; Max-Age=0; Path=/; Domain=other.example.test; Secure',
        );
      if (fixture.fault === 'header-during-body') {
        let retained!: Response;
        retained = new Response(
          new ReadableStream(
            {
              pull(controller) {
                retained.headers.append('Set-Cookie', '__Host-boardsesh.browser-proof.forged=bad; Path=/; Secure');
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ url: `${fixture.origin}/settings` })));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
        return retained;
      }
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
import { captureProviderBrowserContext } from '@/app/lib/auth/provider-security-selection.server';
import {
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  openProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '@/app/lib/auth/provider-security-flow.server';
import { providerSecurityResumeUrl } from '@/app/lib/auth/provider-security-resume';
import { buildBrowserProofCookieCandidate } from '@/app/lib/auth/browser-proof-cookies.server';
import { POST as acknowledgePost } from '@/app/api/internal/auth/provider-signin/acknowledge/route';
import {
  acknowledgeProviderSignin,
  PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH,
} from '@/app/lib/auth/provider-signin-acknowledgment';
import { releaseRateLimitAttempt } from '@/app/lib/auth/rate-limiter';
import { trustedClientRateLimitKey } from '@/app/lib/auth/trusted-client-ip.server';
import { GET as coordinatorObserve } from '@/app/api/internal/auth/browser-coordinator/observe/route';
import { BROWSER_COORDINATOR_PATHS } from '@/app/lib/auth/browser-coordinator-routes.server';

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
let explicitStartFields: Record<string, string> | undefined;
let explicitFrame: ProviderSecurityFlow | undefined;
let issuedCandidate: { kind: 'legacy-jwe' | 'canonical-token'; credential: string } | undefined;
let finalizedAnonymousFlows: Set<string>;
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
  const incoming = new URL(path.startsWith('https:') ? path : `${fixture.origin}/api/auth/${path}`);
  if (fixture.internalRequestUrl) {
    incoming.protocol = 'http:';
    incoming.host = '0.0.0.0:3000';
  }
  return new NextRequest(incoming, {
    method: fields ? 'POST' : 'GET',
    headers: {
      Host: new URL(fixture.origin).host,
      ...(fixture.internalRequestUrl
        ? { 'X-Forwarded-Host': 'foreign.example.test', 'X-Forwarded-Proto': 'http' }
        : {}),
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
  const current = request(`signin/${provider}`, {
    csrfToken: fault === 'csrf' ? 'wrong' : csrfToken,
    callbackUrl: `${fixture.origin}/settings`,
    json: 'true',
    ...(fault === 'asserted-uid' ? { assertedUserId: 'chosen-user' } : {}),
    ...explicitStartFields,
  });
  if (fault === 'bad-host') current.headers.set('host', 'foreign.example.test');
  if (fault === 'external-origin') current.headers.set('origin', 'https://foreign.example.test');
  const response = await invoke(current);
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
  if (fault === 'callback-clock') {
    const jwt = originalCallbacks?.jwt;
    if (!jwt) throw new Error('Actual JWT callback missing');
    authOptions.callbacks = {
      ...authOptions.callbacks,
      jwt: async (parameters) => {
        const claims = await jwt(parameters);
        claims.auth_time = Math.floor(NOW / 1000);
        claims.link_guarded = true;
        return claims;
      },
    };
  }
  const started = await start(provider, fault);
  if (!started.callback) return { ...started, response: started.response };
  fixture.trace = [];
  fixture.fault = fault;
  if (['observed-capacity', 'wrong-path-capacity', 'wrong-domain-capacity'].includes(fault))
    cookies.set('retained-browser-cookie', 'p'.repeat(4300));
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
  fixture.commands = [];
  fixture.fault = '';
  fixture.ready = true;
  fixture.internalRequestUrl = false;
  fixture.legacyConsumer = false;
  fixture.primaryReads = 0;
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
  finalizedAnonymousFlows = new Set();
  preparedIdentityKind = 'new';
  explicitStartFields = undefined;
  explicitFrame = undefined;
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
      fixture.commands.push(operation);
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
        if (fixture.fault === 'prepare-response-lost') throw new Error('Uncertain preparation reply');
      } else if (operation === 'abort') {
        aborts += 1;
        reply = { ...metadata, operation, outcome: 'aborted' };
      } else {
        if (!('candidate' in payload)) throw new Error('Missing actual candidate');
        const replay = finalizedAnonymousFlows.has(payload.flowHash);
        if (!replay) {
          expect(fixture.trace).toContain('actual-partner-finished');
          expect(fixture.trace).toContain('actual-admission');
          expect(fixture.trace).toContain('cookie-plan');
          expect(fixture.trace).toContain('actual-signin-event');
          finalizedAnonymousFlows.add(payload.flowHash);
          commits += 1;
        }
        issuedCandidate = payload.candidate;
        if (fixture.fault === 'lost-finalizer') throw new Error('Unknown finalizer outcome');
        if (replay && fixture.fault === 'ack-drift') fixture.selected = { status: 'proof-required' };
        reply = {
          ...metadata,
          operation: 'finalize',
          outcome: replay && fixture.fault !== 'ack-committed' ? 'recovered' : 'committed',
          candidateCredentialHash: providerCandidateCredentialHash(payload.candidate),
          browserCursor: { ...cursor, version: 1 },
        };
      }
      return reply as AnonymousProviderOperationReply<typeof operation>;
    },
  };
  fixture.providerClient = {
    async command(operation, payload) {
      fixture.trace.push(`private-${operation}`);
      fixture.commands.push(operation);
      if (fixture.selected?.status !== 'admitted') throw new Error('Expected current source A');
      const actor = captureProviderBrowserContext(fixture.selected);
      expect(payload.actor).toEqual(actor.actor);
      const metadata = { providerSecurityVersion: 1 as const, requestId: '00000000-0000-4000-8000-000000000000' };
      const storedUser = {
        id: target.userId,
        email: 'stored@example.test',
        name: 'Stored backend name',
        image: null,
        emailVerified: null,
        createdAt: '2019-01-01T00:00:00.000Z',
      };
      let reply: ProviderSecurityReply;
      if (operation === 'signin-intent') {
        intents += 1;
        reply = {
          ...metadata,
          operation,
          outcome: 'recorded',
          intentToken: 'B'.repeat(43),
          browserIntentToken: 'C'.repeat(43),
          browserCursor: actor.browserCursor,
          expiresAt: new Date(NOW + 300_000).toISOString(),
        };
      } else if (operation === 'signin-prepare') {
        if (!('providerProof' in payload) || !payload.providerProof || !('subject' in payload.providerProof))
          throw new Error('Missing actual provider proof');
        if (fixture.fault === 'same-owner')
          reply = {
            ...metadata,
            operation,
            outcome: 'same-owner',
            credentialProof: actor.sourceCredentialProof,
            credentialExpiresAt: actor.credentialExpiresAt,
            browserCursor: actor.browserCursor,
            user: { ...storedUser, id: actor.actor.expectedUserId },
          };
        else
          reply = {
            ...metadata,
            operation,
            outcome: 'prepared',
            preparationToken: 'D'.repeat(43),
            browserCursor: actor.browserCursor,
            user: storedUser,
            proposedCanonicalToken: actor.actor.kind === 'canonical-token' ? 'P'.repeat(43) : null,
            preparation: {
              provider: payload.providerProof.provider,
              subject: payload.providerProof.subject,
              credentialProof: target,
              credentialExpiresAt: new Date(Math.floor((NOW + 3_600_000) / 1000) * 1000).toISOString(),
              expiresAt: new Date(NOW + 300_000).toISOString(),
              proposedCanonicalTokenHash:
                actor.actor.kind === 'canonical-token'
                  ? providerCandidateCredentialHash({ kind: 'canonical-token', credential: 'P'.repeat(43) })
                  : null,
            },
          };
      } else if (operation === 'bind' || operation === 'bind-google-reauthentication')
        reply = { ...metadata, operation, outcome: 'bound' };
      else if (operation === 'reauthenticate-google')
        reply = {
          ...metadata,
          operation,
          outcome: 'proved',
          reauthenticationToken: 'R'.repeat(43),
          expiresAt: new Date(NOW + 120_000).toISOString(),
        };
      else if (operation === 'prepare')
        reply = {
          ...metadata,
          operation,
          outcome: 'prepared',
          preparationToken: 'D'.repeat(43),
          browserCursor: actor.browserCursor,
          user: { ...storedUser, id: actor.actor.expectedUserId },
          credentialProof: { ...actor.sourceCredentialProof, generation: actor.sourceCredentialProof.generation + 1 },
          credentialExpiresAt: actor.credentialExpiresAt,
          expiresAt: new Date(NOW + 120_000).toISOString(),
          proposedCanonicalToken: actor.actor.kind === 'canonical-token' ? 'Q'.repeat(43) : null,
        };
      else if (operation === 'signin-abort' || operation === 'abort') {
        aborts += 1;
        reply = { ...metadata, operation, outcome: 'aborted' };
      } else if (operation === 'signin-finalize' || operation === 'finalize') {
        if (!('candidate' in payload)) throw new Error('Missing actual candidate');
        expect(fixture.trace).toContain('actual-partner-finished');
        expect(fixture.trace).toContain('actual-admission');
        expect(fixture.trace).toContain('cookie-plan');
        issuedCandidate = payload.candidate;
        commits += 1;
        reply = {
          ...metadata,
          operation,
          outcome: 'committed',
          candidateCredentialHash: providerCandidateCredentialHash(payload.candidate),
          browserCursor: { ...actor.browserCursor, version: actor.browserCursor.version + 1 },
        };
      } else throw new Error('Unexpected signed-in provider command');
      return reply as ProviderSecurityOperationReply<typeof operation>;
    },
  };
});
afterEach(() => {
  // Cases share one real process limiter and intentionally supply no vouched
  // visitor address. Return the fixture's bounded unknown-client allowance
  // between independent cases; the production check and threshold stay real.
  const key = `web-oauth-signin:${trustedClientRateLimitKey(request('signin/google'))}`;
  for (let attempt = 0; attempt < 20; attempt += 1) releaseRateLimitAttempt(key);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  mock.restoreAll();
  vi.restoreAllMocks();
  oidc.custom.setHttpOptionsDefaults({ agent: undefined });
  await providers.close();
});

async function selectOwnedA(kind: 'legacy-jwe' | 'canonical-token') {
  const sourceProof: WebCredentialProof = {
    version: 1,
    userId: 'stable-owner-A',
    authSessionId: 'stable-session-A',
    generation: 3,
    authenticatedAt: new Date(NOW - 86_400_000).toISOString(),
    linkGuarded: true,
  };
  const sourceCredential =
    kind === 'canonical-token'
      ? 'S'.repeat(43)
      : await encode({
          secret: fixture.secret,
          maxAge: 1800,
          token: {
            sub: sourceProof.userId,
            authSessionId: sourceProof.authSessionId,
            gen: 3,
            auth_time: Date.parse(sourceProof.authenticatedAt!) / 1000,
            link_guarded: true,
          },
        });
  const sourceExpiry =
    kind === 'canonical-token'
      ? new Date(Math.floor((NOW + 1_800_000) / 1000) * 1000).toISOString()
      : new Date(Number((await decode({ secret: fixture.secret, token: sourceCredential }))?.exp) * 1000).toISOString();
  const ownedCursor = { ...cursor, version: 2 };
  fixture.selected = {
    status: 'admitted',
    bindingToken,
    actor: {
      version: 2,
      credential:
        kind === 'canonical-token' ? { kind, token: sourceCredential } : { kind, credential: sourceCredential },
    },
    cursor: ownedCursor,
    session: {
      userId: sourceProof.userId,
      authSessionId: sourceProof.authSessionId,
      generation: 3,
      authenticatedAt: sourceProof.authenticatedAt,
      linkGuarded: true,
      requiresAccountCutoff: false,
      expiresAt: sourceExpiry,
    },
    user: { id: sourceProof.userId, email: 'owner-A@example.test', name: 'Stored A', image: null },
  };
  cookies = new Map([[BROWSER_CORRELATION_COOKIE, bindingToken]]);
  if (kind === 'legacy-jwe') cookies.set('__Secure-next-auth.session-token', sourceCredential);
  for (const header of buildBrowserProofCookieCandidate({
    cursor: { bindingId, version: 2 },
    proof: { kind, rawCredential: sourceCredential },
    proofMaxAgeSeconds: 1800,
    observedCookieHeader: null,
  }).headers) {
    const parsed = parseSetCookie(header);
    if (parsed.value) cookies.set(parsed.name, parsed.value);
  }
  target = {
    version: 1,
    userId: 'stable-owner-B',
    authSessionId: 'backend-distinct-session-B',
    generation: 8,
    authenticatedAt: null,
    linkGuarded: false,
  };
  return captureProviderBrowserContext(fixture.selected);
}
async function prepareExplicit(operation: 'link' | 'reauthenticate-google', provider: 'google' | 'apple') {
  const actor = await selectOwnedA('canonical-token');
  explicitFrame = {
    version: 1,
    action: 'link',
    provider,
    methodId: null,
    actorKind: actor.actor.kind,
    actorCredentialHash: actor.credentialHash,
    browserBindingHash: actor.browserCursor.bindingId,
    browserVersion: actor.browserCursor.version,
    browserBindingExpiresAt: actor.browserCursor.bindingExpiresAt,
    sourceCredentialProof: actor.sourceCredentialProof,
    credentialExpiresAt: actor.credentialExpiresAt,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    recoveryToken: 'G'.repeat(43),
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(),
    reauthenticationToken: operation === 'link' ? 'R'.repeat(43) : null,
    reauthenticationExpiresAt: operation === 'link' ? new Date(NOW + 120_000).toISOString() : null,
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
  const key = providerSecurityOperationKey(explicitFrame.intentToken);
  cookies.set(providerSecurityFlowCookieName(key, true), await sealProviderSecurityFlow(explicitFrame, fixture.secret));
  explicitStartFields = {
    providerSecurityOperation: operation,
    providerSecurityOperationKey: key,
    callbackUrl: providerSecurityResumeUrl(fixture.origin, key),
  };
  return key;
}

async function holdCommittedAnonymousProof(provider: 'google' | 'apple' = 'google') {
  const result = await complete(provider);
  expect(result.response.status).toBe(302);
  remember(result.response);
  const flow = await openAnonymousProviderFlow(
    cookies.get(anonymousProviderFlowCookieName(result.hash))!,
    result.hash,
    fixture.secret,
  );
  if (!flow.preparation) throw new Error('Actual completed preparation missing');
  const held = readBrowserProofCookie([...cookies].map(([name, content]) => `${name}=${content}`).join('; '), {
    bindingId,
    version: 1,
  });
  if (held.status !== 'present') throw new Error('Actual next-request B proof missing');
  const proof = flow.preparation.credentialProof;
  fixture.selected = {
    status: 'admitted',
    bindingToken,
    cursor: { ...cursor, version: 1 },
    actor: {
      version: 1,
      credential:
        held.proof.kind === 'canonical-token'
          ? { kind: held.proof.kind, token: held.proof.rawCredential }
          : { kind: held.proof.kind, credential: held.proof.rawCredential },
    },
    session: {
      userId: proof.userId,
      authSessionId: proof.authSessionId,
      generation: proof.generation,
      authenticatedAt: proof.authenticatedAt,
      linkGuarded: proof.linkGuarded,
      requiresAccountCutoff: false,
      expiresAt: flow.preparation.credentialExpiresAt,
    },
    user: { id: proof.userId, email: 'stored@example.test', name: 'Stored backend name', image: null },
  };
  fixture.trace = [];
  fixture.primaryReads = 0;
  return result;
}
function actualCoordinatorRequest() {
  return new Request(`${fixture.origin}${BROWSER_COORDINATOR_PATHS.observe}`, {
    headers: {
      Host: new URL(fixture.origin).host,
      Origin: fixture.origin,
      Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
    },
  });
}
async function acknowledgeActualRoute() {
  return acknowledgeProviderSignin(fixture.origin, new AbortController().signal, async (url, settings) => {
    expect(url).toBe(`${fixture.origin}${PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH}`);
    expect(settings?.body).toBe('{}');
    expect(new Headers(settings?.headers).has('authorization')).toBe(false);
    const response = await acknowledgePost(
      new Request(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, {
        ...settings,
        headers: {
          ...Object.fromEntries(new Headers(settings?.headers)),
          Host: new URL(fixture.origin).host,
          Origin: fixture.origin,
          Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
        },
      }),
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    return response;
  });
}

describe('actual production OAuth outer route and installed NextAuth', () => {
  it.each(['google', 'apple'] as const)(
    'joins %s next-request candidate ACK through the actual canonical coordinator route',
    async (provider) => {
      await holdCommittedAnonymousProof(provider);
      const response = await coordinatorObserve(actualCoordinatorRequest());
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.json()).toEqual({ status: 'ready', cursor: { bindingId, version: 1 } });
      expect(fixture.trace.filter((entry) => entry === 'private-finalize')).toHaveLength(1);
      expect(commits).toBe(1);
      expect(aborts).toBe(0);
      expect(fixture.trace).not.toContain('actual-signin-event');
    },
  );
  it('keeps positive anonymous canonical reads separate from B ACK', async () => {
    const started = await start('google');
    expect(started.state).toBeTruthy();
    fixture.commands = [];
    const response = await coordinatorObserve(actualCoordinatorRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', cursor: { bindingId, version: 0 } });
    expect(fixture.commands).toEqual([]);
    expect(commits).toBe(0);
  });
  it.each(['ack-committed', 'ack-drift', 'observer-drift'] as const)(
    'preserves canonical unavailable/conflict on %s without cookies',
    async (fault) => {
      await holdCommittedAnonymousProof();
      fixture.fault = fault;
      const response = await coordinatorObserve(actualCoordinatorRequest());
      expect(response.status).toBe(fault === 'ack-committed' ? 503 : 409);
      expect(await response.json()).toEqual({ status: fault === 'ack-committed' ? 'unavailable' : 'conflict' });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(commits).toBe(1);
    },
  );
  it('copies final private headers before a retaining decorator reads the body', async () => {
    const result = await complete('google', 'header-during-body');
    expect(result.response.status).toBe(200);
    expect(commits).toBe(1);
    expect(result.response.headers.getSetCookie().some((header) => header.includes('browser-proof.forged'))).toBe(
      false,
    );
  });
  it.each(['google', 'apple'] as const)(
    'acknowledges %s only from real next-request B proof and prepared carrier without OAuth state',
    async (provider) => {
      await holdCommittedAnonymousProof(provider);
      const heldCookies = [...cookies];
      expect(await acknowledgeActualRoute()).toBe('recovered');
      expect(commits).toBe(1);
      expect(aborts).toBe(0);
      expect([...cookies]).toEqual(heldCookies);
      expect(fixture.trace).toContain('private-finalize');
      expect(fixture.trace).not.toContain('private-prepare');
      expect(fixture.trace).not.toContain('actual-signin-event');
      expect(fixture.trace).not.toContain('cookie-plan');
    },
  );
  it('does not reconstruct a missing actual next-request B credential from preparation', async () => {
    await holdCommittedAnonymousProof();
    for (const name of cookies.keys()) if (name.startsWith('__Host-boardsesh.browser-proof.')) cookies.delete(name);
    expect(await acknowledgeActualRoute()).toBe('identity_changed');
    expect(commits).toBe(1);
    expect(fixture.trace).not.toContain('private-finalize');
  });
  it.each(['ack-committed', 'ack-drift', 'lost-finalizer'])(
    'does not publish cookies or retry an ACK with %s',
    async (fault) => {
      await holdCommittedAnonymousProof();
      fixture.fault = fault;
      const outcome = await acknowledgeActualRoute();
      expect(outcome).toBe(fault === 'ack-drift' ? 'identity_changed' : 'unavailable');
      expect(fixture.trace.filter((entry) => entry === 'private-finalize')).toHaveLength(1);
      expect(commits).toBe(1);
      expect(aborts).toBe(0);
    },
  );
  it('counts completed and unrelated retained carriers toward the four-carrier bound', async () => {
    await holdCommittedAnonymousProof();
    for (const letter of ['a', 'b', 'c'])
      cookies.set(anonymousProviderFlowCookieName(letter.repeat(64)), 'retained-expired-flow');
    expect(await acknowledgeActualRoute()).toBe('recovered');
    fixture.trace = [];
    cookies.set(anonymousProviderFlowCookieName('d'.repeat(64)), 'retained-expired-flow');
    expect(await acknowledgeActualRoute()).toBe('identity_changed');
    expect(fixture.trace).not.toContain('private-finalize');
  });
  it('rejects public ACK flow or UID assertions without trying a private command', async () => {
    const response = await acknowledgePost(
      new Request(`${fixture.origin}${PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH}`, {
        method: 'POST',
        headers: { Host: new URL(fixture.origin).host, Origin: fixture.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowHash: 'a'.repeat(64), userId: 'claimed-user' }),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fixture.commands).toEqual([]);
  });
  it.each(['google', 'apple'] as const)(
    'composes ordinary %s owned-B sign-in while preserving both actual A credential kinds',
    async (provider) => {
      for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
        const original = await selectOwnedA(kind);
        const result = await complete(provider);
        expect(result.response.status, JSON.stringify(fixture.trace)).toBe(302);
        expect(issuedCandidate?.kind).toBe(kind);
        expect(aborts).toBe(0);
        expect(fixture.writes).toBe(0);
        expect(fixture.commands).toContain('signin-intent');
        expect(fixture.commands).toContain('signin-prepare');
        expect(fixture.commands).toContain('signin-finalize');
        expect(
          result.response.headers.getSetCookie().every((header) => !header.includes('next-auth.session-token')),
        ).toBe(true);
        if (kind === 'legacy-jwe') {
          const claims = await decode({ secret: fixture.secret, token: issuedCandidate!.credential });
          expect(claims).toMatchObject({ sub: 'stable-owner-B', authSessionId: 'backend-distinct-session-B', gen: 8 });
          expect(claims?.auth_time).toBeUndefined();
          expect(claims?.link_guarded).toBeUndefined();
        }
        expect(fixture.selected?.status).toBe('admitted');
        if (fixture.selected?.status === 'admitted')
          expect(captureProviderBrowserContext(fixture.selected)).toEqual(original);
      }
    },
  );
  it.each(['google', 'apple'] as const)('ordinary same-owner %s exits before issuer or events', async (provider) => {
    const original = await selectOwnedA('canonical-token');
    const result = await complete(provider, 'same-owner');
    expect(result.response.status).toBe(302);
    expect(commits).toBe(0);
    expect(aborts).toBe(0);
    expect(issuedCandidate).toBeUndefined();
    expect(fixture.trace).not.toContain('actual-signin-event');
    expect(result.response.headers.getSetCookie().every((header) => !header.includes('browser-proof'))).toBe(true);
    if (fixture.selected?.status === 'admitted')
      expect(captureProviderBrowserContext(fixture.selected)).toEqual(original);
  });
  it.each(['google', 'apple'] as const)(
    'composes explicit %s link through actual flow binding, admission and outer publication',
    async (provider) => {
      const key = await prepareExplicit('link', provider);
      const result = await complete(provider);
      expect(result.response.status, JSON.stringify(fixture.trace)).toBe(302);
      expect(commits).toBe(1);
      expect(result.response.headers.get('Location')).toBe(providerSecurityResumeUrl(fixture.origin, key));
      expect(fixture.commands).toEqual(['bind', 'prepare', 'finalize']);
      expect(issuedCandidate).toEqual({ kind: 'canonical-token', credential: 'Q'.repeat(43) });
      expect(fixture.writes).toBe(0);
    },
  );
  it('composes Google reauthentication as proof-only without issuer, events or new credential', async () => {
    const key = await prepareExplicit('reauthenticate-google', 'apple');
    const result = await complete('google');
    expect(result.response.status, JSON.stringify(fixture.trace)).toBe(302);
    expect(commits).toBe(0);
    expect(issuedCandidate).toBeUndefined();
    expect(fixture.commands).toEqual(['bind-google-reauthentication', 'reauthenticate-google']);
    expect(fixture.trace).not.toContain('actual-signin-event');
    expect(fixture.writes).toBe(0);
    expect(
      result.response.headers
        .getSetCookie()
        .every((header) => !header.includes('session-token') && !header.includes('browser-proof')),
    ).toBe(true);
    remember(result.response);
    const flow = await openProviderSecurityFlow(
      cookies.get(providerSecurityFlowCookieName(key, true))!,
      key,
      fixture.secret,
    );
    expect(flow.reauthenticationToken).toBe('R'.repeat(43));
    expect(flow.googleFlowHash).toBe(result.hash);
    expect(flow.googleNonce).toBeTruthy();
  });
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
  it.each([
    'event',
    'capacity',
    'future-cookie',
    'body-error',
    'drift',
    'cancel',
    'token-reject',
    'callback-clock',
    'prepare-response-lost',
    'observed-capacity',
    'wrong-path-capacity',
    'wrong-domain-capacity',
  ])('withholds every cookie and finalizer on %s', async (fault) => {
    const result = await complete('google', fault);
    expect(result.response.status).toBe(503);
    expect(result.response.headers.getSetCookie()).toEqual([]);
    expect(commits).toBe(0);
    expect(fixture.writes).toBe(0);
    if (['observed-capacity', 'wrong-path-capacity', 'wrong-domain-capacity'].includes(fault))
      expect(fixture.trace).toContain('cookie-plan');
  });
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
  it('refuses partial provider rollback before the actual legacy intent', async () => {
    await selectOwnedA('canonical-token');
    cookies.set(
      '__Secure-next-auth.session-token',
      await encode({
        secret: fixture.secret,
        maxAge: 1800,
        token: { sub: 'unrelated-legacy-A', authSessionId: 'unrelated-legacy-session-A' },
      }),
    );
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'legacy');
    const result = await start('google');
    expect(fixture.trace).not.toContain('legacy-intent');
    expect(fixture.trace).not.toContain('legacy-resolve');
    expect(result.response.status).toBe(503);
    expect(result.response.headers.getSetCookie()).toEqual([]);
    expect(fixture.writes).toBe(0);
    expect(intents).toBe(0);
    expect(commits).toBe(0);
  });
  it.each(['google', 'apple'] as const)(
    'refuses %s callbacks after partial rollback before any legacy resolver or sign-in event',
    async (provider) => {
      await selectOwnedA('canonical-token');
      cookies.set(
        '__Secure-next-auth.session-token',
        await encode({
          secret: fixture.secret,
          maxAge: 1800,
          token: { sub: 'unrelated-legacy-A', authSessionId: 'unrelated-session-A' },
        }),
      );
      const started = await start(provider);
      if (!started.callback) throw new Error('Actual provider callback missing');
      vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'legacy');
      fixture.trace = [];
      const response = await invoke(
        request(started.callback.url, started.callback.method === 'POST' ? started.callback.form : undefined),
      );
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(fixture.trace).not.toContain('legacy-resolve');
      expect(fixture.trace).not.toContain('actual-signin-event');
      expect(fixture.writes).toBe(0);
      expect(commits).toBe(0);
    },
  );
  it.each(['google', 'apple'] as const)(
    'completes %s from an internal proxy URL using only the fixed canonical Host',
    async (provider) => {
      fixture.internalRequestUrl = true;
      const result = await complete(provider);
      expect(result.response.status).toBe(302);
      expect(result.response.headers.get('Location')).toBe(`${fixture.origin}/settings`);
      expect(commits).toBe(1);
      expect(fixture.writes).toBe(0);
      expect(fixture.trace).not.toContain('legacy-intent');
      expect(result.response.headers.getSetCookie().join(';')).toContain('__Host-boardsesh.browser-proof.');
    },
  );
  it.each(['bad-host', 'external-origin'])(
    'refuses internal proxy %s before any provider or identity command',
    async (fault) => {
      fixture.internalRequestUrl = true;
      const result = await start('google', fault);
      expect(result.response.status).toBe(503);
      expect(result.response.headers.getSetCookie()).toEqual([]);
      expect(intents).toBe(0);
      expect(commits).toBe(0);
      expect(fixture.writes).toBe(0);
      expect(fixture.trace).not.toContain('legacy-intent');
    },
  );
  it.each([
    '__Host-boardsesh.browser-binding',
    '__Host-boardsesh.browser-proof.future',
    '__Host-boardsesh.provider-security.future',
    '__Host-boardsesh.provider-signin.future',
    '__Host-boardsesh.provider-signin-pending.future',
    '__Host-boardsesh.anonymous-provider.future',
    '__Host-boardsesh.anonymous-provider-pending.future',
  ])('refuses presented %s even after both selectors roll back', async (cookieName) => {
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
    cookies = new Map([[cookieName, 'retained-selected-material']]);
    const result = await start('google');
    expect(result.response.status).toBe(503);
    expect(result.response.headers.getSetCookie()).toEqual([]);
    expect(fixture.trace).not.toContain('legacy-intent');
    expect(fixture.trace).not.toContain('legacy-resolve');
    expect(fixture.writes).toBe(0);
  });
  it('preserves the actual legacy start with no selected mode or retained material', async () => {
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
    fixture.legacyConsumer = true;
    cookies.clear();
    const result = await start('google');
    expect(result.response.status).toBe(200);
    expect(result.state).not.toBe('');
    expect(fixture.trace).toContain('legacy-intent');
    expect(fixture.writes).toBe(0);
    expect(intents).toBe(0);
    expect(commits).toBe(0);
  });
  it('keeps Facebook closed before provider, identity or cookie work', async () => {
    const response = await invoke(request('callback/facebook?state=not-a-provider-flow'));
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(intents).toBe(0);
    expect(commits).toBe(0);
  });
});
