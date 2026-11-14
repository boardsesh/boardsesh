// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import * as https from 'node:https';
import * as http from 'node:http';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import AppleProvider from 'next-auth/providers/apple';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startConfiguredProviderTransport } from '../../backend/src/auth/current-store/__tests__/fixtures/app-router-providers';
import type { ProviderSecurityReply, WebCredentialProof } from '@boardsesh/auth-protocol';
import type { AdmittedBrowserSelection } from '@/app/lib/auth/presented-browser-selection.server';

const fixture = vi.hoisted(() => {
  const origin = 'https://www.owned-signin.example.test';
  const secret = 'owned-provider-signin-nextauth-secret-6975';
  process.env.NEXTAUTH_URL = origin;
  process.env.NEXTAUTH_SECRET = secret;
  return {
    origin,
    secret,
    selected: undefined as AdmittedBrowserSelection | undefined,
    unavailable: false,
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
vi.mock('@/app/lib/auth/browser-consumers.server', async (original) => {
  const actual = await original<typeof import('@/app/lib/auth/browser-consumers.server')>();
  return {
    ...actual,
    browserConsumerFacade: {
      ...actual.browserConsumerFacade,
      observe: async () => {
        fixture.trace.push('selected-admission-A');
        return fixture.unavailable ? { status: 'unavailable' } : fixture.selected;
      },
    },
  };
});
import { authOptions } from '@/app/lib/auth/auth-options';
import { withAuthResponseAdmission } from '@/app/lib/auth/auth-response-admission.server';
import { withPartnerSignInFailureReturn } from '@/app/lib/partner-oauth/sign-in-failure-return';
import { createProviderOwnedSigninAuthPublication } from '@/app/lib/auth/provider-owned-signin-auth.server';
import {
  providerOwnedSigninCookieName,
  providerOwnedSigninPendingCookieName,
  type ProviderOwnedSigninFlow,
} from '@/app/lib/auth/provider-owned-signin-flow.server';
import { captureProviderBrowserContext } from '@/app/lib/auth/provider-security-selection.server';
import {
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
  type ProviderSecurityOperationReply,
} from '@/app/lib/auth/provider-security-command-client.server';
import { buildBrowserProofCookieCandidate } from '@/app/lib/auth/browser-proof-cookies.server';
import { webOAuthFlowHash } from '@/app/lib/auth/web-oauth-continuation.server';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0, 100);
const SESSION = '__Secure-next-auth.session-token';
type Handler = (request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) => Promise<Response>;
const storage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers(): Promise<Headers>;
  cookies(): Promise<{ getAll(): { name: string; value: string }[] }>;
};
const nextRequire = createRequire(require.resolve('next-auth'));
const oidc = nextRequire('openid-client') as { custom: { setHttpOptionsDefaults(settings: object): void } };
let providers: Awaited<ReturnType<typeof startConfiguredProviderTransport>>;
let cookies: Map<string, string>;
let base: NextAuthOptions;
let source: string;
let sourceProof: WebCredentialProof;
let sourceExpiry: string;
const userB = {
  id: 'owner-B',
  email: 'stored-B@example.test',
  name: 'Stored B',
  image: null,
  emailVerified: null,
  createdAt: '2019-01-01T00:00:00.000Z',
};
function remember(response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
function request(path: string, fields?: Record<string, string>) {
  return new NextRequest(`${fixture.origin}/api/auth/${path}`, {
    method: fields ? 'POST' : 'GET',
    headers: {
      Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
      ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
}
function invoke(options: NextAuthOptions, current: NextRequest): Promise<Response> {
  const handler = NextAuth(options) as Handler;
  return storage.run(current, () =>
    handler(current, {
      params: Promise.resolve({
        nextauth: current.nextUrl.pathname.slice('/api/auth/'.length).split('/'),
      }),
    }),
  );
}
async function start(provider: 'google' | 'apple', kind: 'legacy-jwe' | 'canonical-token', fault?: string) {
  remember(await invoke(base, request('csrf')));
  const csrf = await invoke(base, request('csrf'));
  const csrfToken = ((await csrf.json()) as { csrfToken: string }).csrfToken;
  const configured = base.providers.find((entry) => entry.id === provider);
  if (!configured || configured.type !== 'oauth') throw new Error('Owned provider missing');
  const startOptions: NextAuthOptions = {
    ...base,
    providers: [
      {
        ...configured,
        ...(provider === 'google' ? { checks: ['state', 'pkce', 'nonce'] } : {}),
        options: {
          ...configured.options,
          clientId: providers.clients[provider].id,
          clientSecret: providers.clients[provider].secret,
          ...(provider === 'google' ? { checks: ['state', 'pkce', 'nonce'] } : {}),
        },
      },
    ],
  };
  const response = await invoke(
    startOptions,
    request(`signin/${provider}`, { csrfToken, callbackUrl: `${fixture.origin}/settings` }),
  );
  remember(response);
  const location = response.headers.get('Location');
  if (!location) throw new Error('Owned provider initiation failed');
  const url = new URL(location);
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Actual state missing');
  const callback = providers.authorize(
    location,
    { subject: 'owned-B-subject', email: 'provider@example.test', emailVerified: true },
    { cancel: fault === 'cancel', rejectToken: fault === 'token-reject' },
  );
  const selected: AdmittedBrowserSelection = {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: {
      version: 2,
      credential: kind === 'legacy-jwe' ? { kind, credential: source } : { kind, token: 'actual-opaque-A' },
    },
    cursor: {
      bindingId: createHash('sha256').update('A'.repeat(43)).digest('hex'),
      version: 2,
      bindingExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    },
    session: {
      userId: sourceProof.userId,
      authSessionId: sourceProof.authSessionId,
      generation: sourceProof.generation,
      authenticatedAt: sourceProof.authenticatedAt,
      linkGuarded: sourceProof.linkGuarded,
      requiresAccountCutoff: true,
      expiresAt: sourceExpiry,
    },
    user: { id: sourceProof.userId, email: 'stored-A@example.test', name: 'Stored A', image: null },
  };
  fixture.selected = selected;
  const actor = captureProviderBrowserContext(selected);
  const flow: ProviderOwnedSigninFlow = {
    version: 1,
    provider,
    actorKind: kind,
    actorCredentialHash: actor.credentialHash,
    browserBindingHash: actor.browserCursor.bindingId,
    browserVersion: actor.browserCursor.version,
    browserBindingExpiresAt: actor.browserCursor.bindingExpiresAt,
    sourceCredentialProof: actor.sourceCredentialProof,
    credentialExpiresAt: actor.credentialExpiresAt,
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    flowHash: webOAuthFlowHash(provider, state),
    nonce: url.searchParams.get('nonce'),
    returnUrl: `${fixture.origin}/settings`,
    preparationToken: null,
    preparation: null,
  };
  const current =
    callback.method === 'POST'
      ? new NextRequest(callback.url, {
          method: 'POST',
          headers: {
            Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(callback.form),
        })
      : new NextRequest(callback.url, {
          headers: {
            Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
          },
        });
  return { flow, actor, current };
}
async function complete(provider: 'google' | 'apple', kind: 'legacy-jwe' | 'canonical-token', fault?: string) {
  if (fault === 'observed-capacity') cookies.set('retained-browser-cookie', 'p'.repeat(5200));
  if (fault === 'event')
    base.events = {
      signIn: async () => {
        throw new Error('Late event');
      },
    };
  if (fault === 'clock-age') {
    const jwt = base.callbacks!.jwt!;
    base.callbacks = {
      ...base.callbacks,
      jwt: async (parameters) => {
        const claims = await jwt(parameters);
        claims.auth_time = Math.floor(NOW / 1000);
        claims.link_guarded = true;
        return claims;
      },
    };
  }
  if (fault === 'rollover')
    base.jwt = {
      ...base.jwt,
      encode: async (parameters) => {
        vi.setSystemTime(NOW + 1000);
        return encode(parameters);
      },
    };
  const { flow, actor, current } = await start(provider, kind, fault);
  let commits = 0;
  let aborts = 0;
  let issuedCandidate: { kind: 'legacy-jwe' | 'canonical-token'; credential: string } | undefined;
  const proof: WebCredentialProof = {
    version: 1,
    userId: userB.id,
    authSessionId: 'distinct-B-session',
    generation: 8,
    authenticatedAt: null,
    linkGuarded: false,
  };
  const targetExpiry = new Date(Math.floor((NOW + 3_600_000) / 1000) * 1000).toISOString();
  const client: ProviderSecurityCommandClient = {
    async command(operation, payload) {
      const metadata = { providerSecurityVersion: 1 as const, requestId: '00000000-0000-4000-8000-000000000000' };
      let reply: ProviderSecurityReply;
      expect(payload.actor).toEqual(actor.actor);
      if (operation === 'signin-prepare') {
        fixture.trace.push('prepare');
        if (!('providerProof' in payload) || !payload.providerProof || !('nonce' in payload.providerProof))
          throw new Error('Missing verified provider');
        expect(payload.providerProof.provider).toBe(provider);
        expect(payload.providerProof.subject).toBe('owned-B-subject');
        expect(payload.providerProof.nonce).toBe(provider === 'google' ? flow.nonce : null);
        if (fault === 'same-owner')
          reply = {
            ...metadata,
            operation,
            outcome: 'same-owner',
            credentialProof: sourceProof,
            credentialExpiresAt: sourceExpiry,
            browserCursor: actor.browserCursor,
            user: { ...userB, id: sourceProof.userId },
          };
        else if (fault === 'unknown-owner')
          reply = { ...metadata, operation, outcome: 'denied', code: 'ownership_conflict' };
        else
          reply = {
            ...metadata,
            operation,
            outcome: 'prepared',
            preparationToken: 'D'.repeat(43),
            browserCursor: actor.browserCursor,
            user: userB,
            proposedCanonicalToken: kind === 'canonical-token' ? 'E'.repeat(43) : null,
            preparation: {
              provider,
              subject: 'owned-B-subject',
              credentialProof: proof,
              credentialExpiresAt: targetExpiry,
              expiresAt: flow.expiresAt,
              proposedCanonicalTokenHash:
                kind === 'canonical-token'
                  ? providerCandidateCredentialHash({ kind, credential: 'E'.repeat(43) })
                  : null,
            },
          };
      } else if (operation === 'signin-abort') {
        fixture.trace.push('abort');
        aborts += 1;
        reply = { ...metadata, operation, outcome: 'aborted' };
      } else if (operation === 'signin-finalize') {
        fixture.trace.push('finalize');
        if (!('candidate' in payload)) throw new Error('Missing actual candidate');
        issuedCandidate = payload.candidate;
        expect(fixture.trace).toContain('admission-ack');
        expect(fixture.trace).toContain('partner-finished');
        expect(fixture.trace).toContain('cookie-plan');
        commits += 1;
        if (fault === 'lost-finalizer') throw new Error('Unknown committed result');
        reply = {
          ...metadata,
          operation,
          outcome: 'committed',
          candidateCredentialHash: providerCandidateCredentialHash(payload.candidate),
          browserCursor: { ...actor.browserCursor, version: actor.browserCursor.version + 1 },
        };
      } else throw new Error('Unexpected private operation');
      return reply as ProviderSecurityOperationReply<typeof operation>;
    },
  };
  const publication = createProviderOwnedSigninAuthPublication(base, current, flow, actor, {
    environment: { NEXTAUTH_SECRET: fixture.secret },
    clientFactory: () => client,
    readSelection: async (actualCookies) => {
      expect(actualCookies).toBe(current.headers.get('cookie'));
      fixture.trace.push('primary-A');
      return fixture.unavailable ? { status: 'unavailable' } : fixture.selected!;
    },
    prepareCookiePublication(input) {
      fixture.trace.push('cookie-plan');
      expect(commits).toBe(0);
      if (fault === 'capacity') throw new Error('Whole header full');
      const planned = buildBrowserProofCookieCandidate({
        cursor: { bindingId: input.cursor.bindingId, version: input.cursor.version },
        proof: { kind: input.candidate.kind, rawCredential: input.candidate.credential },
        proofMaxAgeSeconds: Math.floor((Date.parse(input.credentialExpiresAt) - Date.now()) / 1000),
        observedCookieHeader: current.headers.get('cookie'),
        retainObservedProofCookies: true,
      });
      fixture.trace.push('proof-plan-fits');
      return {
        headers: planned.headers,
        cursor: input.cursor,
        candidateCredentialHash: providerCandidateCredentialHash(input.candidate),
      };
    },
  });
  const context = { params: Promise.resolve({ nextauth: ['callback', provider] }) };
  const response = await publication.run(async () => {
    const admitted = await withAuthResponseAdmission(
      current,
      context,
      async () => {
        const raw = await invoke(publication.options, current);
        const pending = providerOwnedSigninPendingCookieName(flow.flowHash);
        if (fault === 'duplicate') {
          const header = raw.headers.getSetCookie().find((entry) => entry.startsWith(`${pending}=`));
          if (!header) throw new Error('Pending candidate absent');
          raw.headers.append('Set-Cookie', header);
        }
        const safe = publication.quarantine(raw);
        expect(safe.headers.getSetCookie().every((header) => !header.startsWith(pending))).toBe(true);
        if (fault === 'admission') fixture.unavailable = true;
        return safe;
      },
      fault === 'missing-ack'
        ? undefined
        : (safe) => {
            publication.acknowledgeAdmission(safe);
            fixture.trace.push('admission-ack');
          },
    );
    const final = await withPartnerSignInFailureReturn(current, admitted);
    fixture.trace.push('partner-finished');
    if (fault === 'late-cookie')
      final.headers.append('Set-Cookie', '__Host-boardsesh.browser-proof.injected=bad; Path=/; Secure');
    if (fault === 'redirect')
      return new Response(null, { status: 302, headers: { Location: `${fixture.origin}/auth/error` } });
    if (fault === 'body')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('Late body'));
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    if (fault === 'header-during-body') {
      let retained: Response;
      const stream = new ReadableStream(
        {
          pull(controller) {
            retained.headers.append('Set-Cookie', '__Host-boardsesh.browser-proof.forged=bad; Path=/; Secure');
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ url: flow.returnUrl })));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      retained = new Response(stream, { headers: { 'Content-Type': 'application/json' } });
      return retained;
    }
    return final;
  });
  return { response, commits, aborts, candidate: issuedCandidate, flow, proof, targetExpiry };
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
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  fixture.trace = [];
  fixture.writes = 0;
  fixture.unavailable = false;
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  sourceProof = {
    version: 1,
    userId: 'owner-A',
    authSessionId: 'session-A',
    generation: 3,
    authenticatedAt: '2026-08-01T00:00:00.000Z',
    linkGuarded: true,
    requiresAccountCutoff: true,
  };
  source = await encode({
    secret: fixture.secret,
    maxAge: 1800,
    token: {
      sub: sourceProof.userId,
      authSessionId: sourceProof.authSessionId,
      gen: 3,
      auth_time: Date.parse(sourceProof.authenticatedAt!) / 1000,
      link_guarded: true,
      legacy_no_sid: true,
    },
  });
  const claims = await decode({ secret: fixture.secret, token: source });
  sourceExpiry = new Date(Number(claims?.exp) * 1000).toISOString();
  cookies = new Map([[SESSION, source]]);
  base = {
    ...authOptions,
    secret: fixture.secret,
    providers: [
      GoogleProvider({ clientId: providers.clients.google.id, clientSecret: providers.clients.google.secret }),
      AppleProvider({
        clientId: providers.clients.apple.id,
        clientSecret: providers.clients.apple.secret,
        checks: ['pkce', 'state'],
      }),
    ],
    callbacks: {
      ...authOptions.callbacks,
      signIn: async () => {
        fixture.writes += 1;
        throw new Error('Old writer');
      },
    },
    events: {
      signIn: async () => {
        fixture.trace.push('sign-in-event');
      },
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

describe('actual installed NextAuth owned-provider pending publication', () => {
  it.each(['google', 'apple'] as const)(
    'prepares %s B with both source kinds without admitting or publishing a pending credential',
    async (provider) => {
      for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
        const result = await complete(provider, kind);
        expect(result.response.status, JSON.stringify(fixture.trace)).toBe(302);
        expect(result.commits).toBe(1);
        expect(result.aborts).toBe(0);
        expect(fixture.writes).toBe(0);
        expect(
          result.response.headers
            .getSetCookie()
            .some((header) => header.startsWith(providerOwnedSigninPendingCookieName(result.flow.flowHash))),
        ).toBe(false);
        expect(
          result.response.headers
            .getSetCookie()
            .some((header) => header.startsWith(providerOwnedSigninCookieName(result.flow.flowHash))),
        ).toBe(true);
        if (kind === 'legacy-jwe') {
          const claims = await decode({ secret: fixture.secret, token: result.candidate!.credential });
          expect(claims).toMatchObject({
            sub: 'owner-B',
            authSessionId: result.proof.authSessionId,
            gen: 8,
            exp: Date.parse(result.targetExpiry) / 1000,
          });
          expect(claims?.auth_time).toBeUndefined();
          expect(claims?.link_guarded).toBeUndefined();
        } else expect(result.candidate!.credential).toBe('E'.repeat(43));
      }
    },
  );
  it.each(['google', 'apple'] as const)(
    'same-owner %s returns STRING before encoder and keeps source exactly',
    async (provider) => {
      const result = await complete(provider, 'legacy-jwe', 'same-owner');
      expect(result.response.status).toBe(302);
      expect(result.commits).toBe(0);
      expect(result.aborts).toBe(0);
      expect(
        result.response.headers
          .getSetCookie()
          .every((header) => !header.includes('session-token') && !header.includes('browser-proof')),
      ).toBe(true);
      expect(fixture.trace).not.toContain('sign-in-event');
      expect(fixture.writes).toBe(0);
    },
  );
  it.each([
    'event',
    'clock-age',
    'rollover',
    'duplicate',
    'capacity',
    'missing-ack',
    'admission',
    'late-cookie',
    'redirect',
    'body',
    'cancel',
    'token-reject',
    'unknown-owner',
    'observed-capacity',
  ])('refuses %s without future or partial proof and before finalization', async (fault) => {
    const result = await complete('google', 'legacy-jwe', fault);
    expect(result.response.status).toBe(503);
    expect(result.response.headers.getSetCookie()).toEqual([]);
    expect(result.commits).toBe(0);
    expect(result.aborts).toBe(1);
    expect(fixture.writes).toBe(0);
    if (fault === 'observed-capacity') expect(fixture.trace).toContain('proof-plan-fits');
  });
  it('does not abort or replay after an unknown committed finalizer', async () => {
    const result = await complete('google', 'legacy-jwe', 'lost-finalizer');
    expect(result.response.status).toBe(503);
    expect(result.response.headers.getSetCookie()).toEqual([]);
    expect(result.commits).toBe(1);
    expect(result.aborts).toBe(0);
    expect(fixture.trace.filter((step) => step === 'finalize')).toHaveLength(1);
  });
  it('publishes the private header snapshot after an abort-ignoring retained response mutates during body read', async () => {
    const result = await complete('google', 'legacy-jwe', 'header-during-body');
    expect(result.response.status).toBe(200);
    expect(result.commits).toBe(1);
    expect(result.response.headers.getSetCookie().some((header) => header.includes('proof.forged'))).toBe(false);
  });
});
