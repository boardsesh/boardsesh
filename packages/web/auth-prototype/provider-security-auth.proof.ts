// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import * as https from 'node:https';
import * as http from 'node:http';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startConfiguredProviderTransport } from '../../backend/src/auth/current-store/__tests__/fixtures/app-router-providers';
import { verifyLegacyNextAuthJwe } from '../../backend/src/auth/legacy-web-credentials';
import type { ProviderSecurityReply, WebCredentialProof } from '@boardsesh/auth-protocol';

const fixture = vi.hoisted(() => {
  const origin = 'https://www.provider-publication.example.test';
  const secret = 'owned-provider-publication-nextauth-secret';
  process.env.NEXTAUTH_URL = origin;
  process.env.NEXTAUTH_SECRET = secret;
  return { origin, secret, generation: 3, admissionUnavailable: false, trace: [] as string[], writes: 0 };
});
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => {
      fixture.writes += 1;
      throw new Error('Owned legacy profile write refused');
    },
    insert: () => {
      fixture.writes += 1;
      throw new Error('Owned legacy profile insert refused');
    },
  }),
}));
vi.mock('@/app/lib/auth/credential-admission.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/auth/credential-admission.server')>();
  return {
    ...actual,
    admitPresentedWebCredential: async (credential: string) => {
      if (fixture.admissionUnavailable) throw new actual.CredentialAuthorityUnavailable();
      const claims = await decode({ token: credential, secret: fixture.secret });
      fixture.trace.push(`admit:${String(claims?.gen)}`);
      return claims && (claims.gen ?? 0) === fixture.generation ? (claims.sub ?? null) : null;
    },
  };
});

import { authOptions } from '@/app/lib/auth/auth-options';
import { withAuthResponseAdmission } from '@/app/lib/auth/auth-response-admission.server';
import { withPartnerSignInFailureReturn } from '@/app/lib/partner-oauth/sign-in-failure-return';
import { webOAuthFlowHash } from '@/app/lib/auth/web-oauth-continuation.server';
import {
  createProviderSecurityAuthPublication,
  type ProviderSecurityExplicitBoundFlow,
} from '@/app/lib/auth/provider-security-auth.server';
import {
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
  type ProviderSecurityOperationReply,
} from '@/app/lib/auth/provider-security-command-client.server';

type Handler = (request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) => Promise<Response>;
const requestStorage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers(): Promise<Headers>;
  cookies(): Promise<{ getAll(): { name: string; value: string }[] }>;
};
const nextRequire = createRequire(require.resolve('next-auth'));
const oidc = nextRequire('openid-client') as { custom: { setHttpOptionsDefaults(settings: object): void } };
const SESSION = '__Secure-next-auth.session-token';
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0, 500);
const originalTime = '2026-08-01T00:00:00.000Z';
let providers: Awaited<ReturnType<typeof startConfiguredProviderTransport>>;
let cookies: Map<string, string>;
let base: NextAuthOptions;
let original: WebCredentialProof;
let source: string;
let sourceExpiry: string;
const target = { subject: 'owned-new-google-subject', email: 'provider@example.test', emailVerified: true };
const originalUser = {
  id: 'owned-existing-user',
  email: 'stored@example.test',
  name: 'Stored owner',
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
function request(path: string, form?: Record<string, string>): NextRequest {
  return new NextRequest(new URL(`/api/auth/${path}`, fixture.origin), {
    method: form ? 'POST' : 'GET',
    headers: {
      Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
}
async function invoke(options: NextAuthOptions, current: NextRequest): Promise<Response> {
  const handler = NextAuth(options) as Handler;
  return requestStorage.run(current, () =>
    handler(current, {
      params: Promise.resolve({ nextauth: current.nextUrl.pathname.slice('/api/auth/'.length).split('/') }),
    }),
  );
}
async function start(
  kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe',
  providerFault?: 'provider-cancel' | 'provider-reject',
) {
  const csrf = await invoke(base, request('csrf'));
  remember(csrf);
  const csrfToken = ((await csrf.json()) as { csrfToken: string }).csrfToken;
  const returnUrl = `${fixture.origin}/oauth/sign-in?owned=provider`;
  const authorization = await invoke(base, request('signin/google', { csrfToken, callbackUrl: returnUrl }));
  remember(authorization);
  const location = authorization.headers.get('Location');
  if (!location) throw new Error('Owned provider initiation failed');
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error('Owned provider state missing');
  const callback = providers.authorize(location, target, {
    cancel: providerFault === 'provider-cancel',
    rejectToken: providerFault === 'provider-reject',
  });
  if (kind === 'canonical-token') cookies.delete(SESSION);
  const frame: ProviderSecurityExplicitBoundFlow = {
    provider: 'google',
    actor: {
      kind,
      credential: kind === 'legacy-jwe' ? source : 'K'.repeat(43),
      expectedUserId: original.userId,
      expectedAuthSessionId: original.authSessionId,
      browserBindingToken: 'A'.repeat(43),
      browserVersion: 1,
    },
    sourceCredentialProof: original,
    credentialExpiresAt: sourceExpiry,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    reauthenticationToken: 'D'.repeat(43),
    flowHash: webOAuthFlowHash('google', state),
    returnUrl,
  };
  return {
    frame,
    current: new NextRequest(callback.url, {
      headers: { Cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; ') },
    }),
  };
}
function privateClient(frame: ProviderSecurityExplicitBoundFlow, lostReply = false, reuseCanonical = false) {
  let candidate: { kind: 'legacy-jwe' | 'canonical-token'; credential: string } | undefined;
  let commits = 0;
  const cursor = {
    bindingId: createHash('sha256').update(frame.actor.browserBindingToken).digest('hex'),
    version: 1,
    bindingExpiresAt: sourceExpiry,
  };
  const client: ProviderSecurityCommandClient = {
    async command(operation, payload) {
      let reply: ProviderSecurityReply;
      const metadata = { providerSecurityVersion: 1 as const, requestId: '00000000-0000-4000-8000-000000000000' };
      if (operation === 'prepare') {
        fixture.trace.push('prepare');
        expect(payload.actor).toEqual(frame.actor);
        reply = {
          ...metadata,
          operation,
          outcome: 'prepared',
          preparationToken: 'E'.repeat(43),
          credentialProof: { ...original, generation: original.generation + 1 },
          credentialExpiresAt: sourceExpiry,
          expiresAt: new Date(NOW + 300_000).toISOString(),
          browserCursor: cursor,
          proposedCanonicalToken:
            frame.actor.kind === 'canonical-token' ? (reuseCanonical ? frame.actor.credential : 'F'.repeat(43)) : null,
          user: originalUser,
        };
      } else if (operation === 'abort') {
        fixture.trace.push('abort');
        if (!('preparationToken' in payload)) throw new Error('Owned abort phase missing');
        fixture.trace.push(`abort:${payload.preparationToken === null ? 'unprepared' : 'prepared'}`);
        reply = { ...metadata, operation, outcome: 'aborted' };
      } else if (operation === 'finalize' || operation === 'recover') {
        if (!('candidate' in payload)) throw new Error('Owned candidate missing');
        fixture.trace.push(operation);
        if (operation === 'finalize') {
          candidate = { ...payload.candidate };
          if (candidate.kind === 'legacy-jwe') {
            const claims = await decode({ token: candidate.credential, secret: fixture.secret });
            expect(claims).toMatchObject({
              sub: original.userId,
              authSessionId: original.authSessionId,
              gen: original.generation + 1,
              exp: Date.parse(sourceExpiry) / 1000,
            });
          } else expect(candidate.credential).toBe('F'.repeat(43));
          expect(fixture.trace.indexOf('admission-ack')).toBeLessThan(fixture.trace.indexOf('finalize'));
          expect(fixture.trace.indexOf('partner')).toBeLessThan(fixture.trace.indexOf('finalize'));
          commits += 1;
          fixture.generation = original.generation + 1;
          if (lostReply) throw new Error('Owned acknowledged commit reply lost');
        } else expect(payload.candidate).toEqual(candidate);
        const acknowledgment = {
          ...metadata,
          candidateCredentialHash: providerCandidateCredentialHash(payload.candidate),
          browserCursor: { ...cursor, version: 2 },
        };
        reply =
          operation === 'finalize'
            ? { ...acknowledgment, operation: 'finalize', outcome: 'committed' }
            : { ...acknowledgment, operation: 'recover', outcome: 'recovered' };
      } else throw new Error('Unexpected owned provider command');
      return reply as ProviderSecurityOperationReply<typeof operation>;
    },
  };
  return { client, commits: () => commits };
}
async function complete(
  settings: {
    kind?: 'legacy-jwe' | 'canonical-token';
    fault?:
      | 'event'
      | 'encode'
      | 'fresh-age'
      | 'rollover'
      | 'expired-during-encode'
      | 'duplicate'
      | 'body'
      | 'redirect'
      | 'plan'
      | 'missing-ack'
      | 'admission'
      | 'reused-canonical'
      | 'utf8-cookie-budget'
      | 'provider-cancel'
      | 'provider-reject';
    lostReply?: boolean;
  } = {},
) {
  if (settings.fault === 'event')
    base.events = {
      ...base.events,
      signIn: async () => {
        fixture.trace.push('event');
        throw new Error('Owned late event failure');
      },
    };
  if (settings.fault === 'encode')
    base.jwt = {
      ...base.jwt,
      encode: async () => {
        throw new Error('Owned late encoder failure');
      },
    };
  if (settings.fault === 'rollover')
    base.jwt = {
      ...base.jwt,
      encode: async (parameters) => {
        vi.setSystemTime(NOW + 1000);
        return encode(parameters);
      },
    };
  if (settings.fault === 'expired-during-encode')
    base.jwt = {
      ...base.jwt,
      encode: async (parameters) => {
        fixture.trace.push('actual-encode-at-expiry');
        vi.setSystemTime(Date.parse(sourceExpiry));
        return encode(parameters);
      },
    };
  if (settings.fault === 'fresh-age') {
    const callback = base.callbacks?.jwt;
    base.callbacks = {
      ...base.callbacks,
      jwt: async (parameters) => {
        const claims = callback ? await callback(parameters) : parameters.token;
        claims.auth_time = Math.floor(NOW / 1000);
        return claims;
      },
    };
  }
  const { frame, current } = await start(
    settings.kind,
    settings.fault === 'provider-cancel' || settings.fault === 'provider-reject' ? settings.fault : undefined,
  );
  const backend = privateClient(frame, settings.lostReply, settings.fault === 'reused-canonical');
  const publication = createProviderSecurityAuthPublication(base, frame, {
    requestUrl: current.url,
    clientFactory: () => backend.client,
    prepareCookiePublication(input) {
      fixture.trace.push('cookie-plan');
      if (settings.fault === 'plan') throw new Error('Owned cookie capacity failure');
      expect(fixture.generation).toBe(original.generation);
      let headers =
        input.candidate.kind === 'legacy-jwe'
          ? input.frameworkHeaders
          : [
              `__Host-owned-proof=${input.candidate.credential}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(input.credentialExpiresAt).toUTCString()}`,
            ];
      if (input.candidate.kind === 'canonical-token') expect(input.frameworkHeaders).toEqual([]);
      if (settings.fault === 'utf8-cookie-budget') {
        const overBudget = `__Host-owned-proof=${'é'.repeat(2100)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
        expect(overBudget.length).toBeLessThan(4096);
        expect(Buffer.byteLength(overBudget)).toBeGreaterThan(4096);
        headers = [overBudget];
      }
      return {
        headers,
        candidateCredentialHash: providerCandidateCredentialHash(input.candidate),
        cursor: input.cursor,
      };
    },
  });
  const context = { params: Promise.resolve({ nextauth: ['callback', 'google'] }) };
  const response = await requestStorage.run(current, () =>
    publication.run(async () => {
      const admitted = await withAuthResponseAdmission(
        current,
        context,
        async () => {
          const raw = await invoke(publication.options, current);
          if (settings.fault === 'duplicate') {
            const header = raw.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION}=`));
            if (!header) throw new Error('Owned candidate cookie missing');
            raw.headers.append('Set-Cookie', header);
          }
          if (settings.fault === 'admission') fixture.admissionUnavailable = true;
          return publication.quarantine(raw);
        },
        settings.fault === 'missing-ack'
          ? undefined
          : (result) => {
              publication.acknowledgeAdmission(result);
              fixture.trace.push('admission-ack');
            },
      );
      fixture.trace.push('partner');
      const final = await withPartnerSignInFailureReturn(current, admitted);
      if (settings.fault === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: `${fixture.origin}/auth/error?error=OwnedLateError` },
        });
      if (settings.fault === 'body')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Owned late body failure'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      return final;
    }),
  );
  return { response, publication, backend };
}

beforeAll(async () => {
  providers = await startConfiguredProviderTransport();
  providers.registerRedirect(fixture.origin);
  oidc.custom.setHttpOptionsDefaults({ agent: providers.agent, timeout: 3000 });
  const nativeHttps = require('node:https') as typeof https;
  const nativeHttp = require('node:http') as typeof http;
  const originalRequest = nativeHttps.request;
  mock.method(nativeHttps, 'request', (url: string | URL, options: https.RequestOptions) => {
    const address = new URL(url);
    if (!providers.allowedDestinations.has(`${address.origin}${address.pathname}`) || options.agent !== providers.agent)
      throw new Error('Unowned provider network refused');
    return originalRequest(url, options);
  });
  mock.method(nativeHttp, 'request', () => {
    throw new Error('Unowned HTTP refused');
  });
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requestStorage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [],
  }));
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  vi.stubGlobal('fetch', async () => {
    throw new Error('Unowned fetch refused');
  });
  fixture.generation = 3;
  fixture.admissionUnavailable = false;
  fixture.trace = [];
  fixture.writes = 0;
  original = {
    version: 1,
    userId: originalUser.id,
    authSessionId: 'owned-stable-session',
    generation: 3,
    authenticatedAt: originalTime,
    linkGuarded: true,
    requiresAccountCutoff: true,
  };
  source = await encode({
    secret: fixture.secret,
    maxAge: 3600,
    token: {
      sub: original.userId,
      authSessionId: original.authSessionId,
      gen: 3,
      auth_time: Date.parse(originalTime) / 1000,
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
    ],
    callbacks: {
      ...authOptions.callbacks,
      signIn: async () => {
        fixture.writes += 1;
        throw new Error('Legacy profile callback must not run');
      },
    },
    events: {
      signIn: async () => {
        fixture.trace.push('event');
      },
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  mock.restoreAll();
  vi.restoreAllMocks();
  oidc.custom.setHttpOptionsDefaults({ agent: undefined });
  await providers.close();
});

describe('unmounted explicit provider publication with actual NextAuth OAuth and codec', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'buffers %s until final admission, partner and cookie work finish',
    async (kind) => {
      const current = await complete({ kind });
      expect(current.response.status).toBe(302);
      expect(current.backend.commits()).toBe(1);
      expect(fixture.writes).toBe(0);
      expect(fixture.trace).toContain('cookie-plan');
      expect(fixture.trace.at(-1)).toBe('finalize');
      expect(fixture.trace).not.toContain('admit:4');
      expect(current.response.headers.getSetCookie().length).toBeGreaterThan(0);
      if (kind === 'legacy-jwe') {
        const header = current.response.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION}=`));
        const raw = header?.split(';', 1)[0].slice(SESSION.length + 1);
        const claims = await decode({ token: raw, secret: fixture.secret });
        expect(claims?.auth_time).toBe(Date.parse(originalTime) / 1000);
        expect(claims?.legacy_no_sid).toBe(true);
        expect(claims?.exp).toBe(Date.parse(sourceExpiry) / 1000);
        expect(header).toContain(`Expires=${new Date(sourceExpiry).toUTCString()}`);
      }
    },
  );
  it.each([
    'event',
    'encode',
    'fresh-age',
    'rollover',
    'expired-during-encode',
    'duplicate',
    'body',
    'redirect',
    'plan',
    'missing-ack',
    'admission',
    'utf8-cookie-budget',
  ] as const)('publishes no cookie or mutation after a late %s failure', async (fault) => {
    const current = await complete({ fault });
    expect(current.response.status).toBe(503);
    expect(current.response.headers.getSetCookie()).toEqual([]);
    expect(current.backend.commits()).toBe(0);
    expect(fixture.generation).toBe(3);
    expect(fixture.writes).toBe(0);
    if (fault === 'expired-during-encode') expect(fixture.trace).toContain('actual-encode-at-expiry');
  });
  it.each(['provider-cancel', 'provider-reject'] as const)(
    'terminalizes a validated flow after actual OAuth %s before preparation',
    async (fault) => {
      const current = await complete({ fault });
      expect(current.response.headers.getSetCookie().some((header) => header.startsWith(SESSION))).toBe(false);
      expect(current.backend.commits()).toBe(0);
      expect(fixture.trace).not.toContain('prepare');
      expect(fixture.trace).not.toContain('finalize');
      expect(fixture.trace).toContain('abort:unprepared');
      expect(fixture.generation).toBe(3);
      expect(fixture.writes).toBe(0);
    },
  );
  it('preserves unknown original authentication age through the actual callback and encoder', async () => {
    original = { ...original, authenticatedAt: null, linkGuarded: false };
    source = await encode({
      secret: fixture.secret,
      maxAge: 3600,
      token: {
        sub: original.userId,
        authSessionId: original.authSessionId,
        gen: original.generation,
        legacy_no_sid: true,
      },
    });
    cookies.set(SESSION, source);
    const current = await complete();
    expect(current.response.status).toBe(302);
    const header = current.response.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION}=`));
    const raw = header?.split(';', 1)[0].slice(SESSION.length + 1);
    const claims = await decode({ token: raw, secret: fixture.secret });
    expect(claims?.auth_time).toBeUndefined();
    expect(claims?.link_guarded).toBeUndefined();
    expect(claims?.legacy_no_sid).toBe(true);
    expect(claims?.exp).toBe(Date.parse(sourceExpiry) / 1000);
    expect(current.backend.commits()).toBe(1);
  });
  it.each(['missing-sid-gen', 'unguarded-age'] as const)(
    'preserves conservative primary provenance of actual historical %s through OAuth callback issuance',
    async (historical) => {
      source = await encode({
        secret: fixture.secret,
        maxAge: 3600,
        token: {
          sub: originalUser.id,
          ...(historical === 'unguarded-age'
            ? { authSessionId: 'owned-stable-session', gen: 3, auth_time: Date.parse(originalTime) / 1000 }
            : {}),
        },
      });
      const verified = await verifyLegacyNextAuthJwe(source, fixture.secret, new Date(NOW));
      if (!verified) throw new Error('Owned actual historical source was not verified');
      original = {
        version: 1,
        userId: verified.userId,
        authSessionId: verified.authSessionId ?? verified.lineageId,
        generation: verified.generation,
        authenticatedAt: null,
        linkGuarded: false,
        ...(verified.requiresAccountCutoff ? { requiresAccountCutoff: true } : {}),
      };
      fixture.generation = original.generation;
      cookies.set(SESSION, source);
      const current = await complete();
      expect(current.response.status).toBe(302);
      expect(current.backend.commits()).toBe(1);
      const header = current.response.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION}=`));
      const raw = header?.split(';', 1)[0].slice(SESSION.length + 1);
      const claims = await decode({ token: raw, secret: fixture.secret });
      expect(claims).toMatchObject({
        sub: original.userId,
        authSessionId: original.authSessionId,
        gen: original.generation + 1,
        exp: verified.expiresAt.getTime() / 1000,
      });
      expect(claims?.auth_time).toBeUndefined();
      expect(claims?.link_guarded).toBeUndefined();
      expect(claims?.legacy_no_sid).toBe(historical === 'missing-sid-gen' ? true : undefined);
      if (historical === 'missing-sid-gen') {
        const old = await decode({ token: source, secret: fixture.secret });
        expect(claims?.authSessionId).not.toBe(old?.jti);
      }
    },
  );
  it('refuses a reused canonical bearer and aborts its prepared intent before any mutation', async () => {
    const current = await complete({ kind: 'canonical-token', fault: 'reused-canonical' });
    expect(current.response.status).toBe(503);
    expect(current.response.headers.getSetCookie()).toEqual([]);
    expect(current.backend.commits()).toBe(0);
    expect(fixture.generation).toBe(3);
    expect(fixture.trace).toContain('abort');
  });
  it('requires explicit ACK recovery of the same retained candidate after an unknown finalizer result', async () => {
    const current = await complete({ lostReply: true });
    expect(current.response.status).toBe(503);
    expect(current.response.headers.getSetCookie()).toEqual([]);
    expect(current.backend.commits()).toBe(1);
    expect(fixture.trace).not.toContain('abort');
    const recovered = await current.publication.recover('R'.repeat(43));
    expect(recovered.status).toBe(302);
    expect(current.backend.commits()).toBe(1);
    expect(recovered.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(fixture.trace.filter((phase) => phase === 'prepare')).toHaveLength(1);
    expect(fixture.trace.filter((phase) => phase === 'finalize')).toHaveLength(1);
  });
});
