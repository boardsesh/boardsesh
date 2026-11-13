// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as https from 'node:https';
import { eq } from 'drizzle-orm';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSecurityMutationEvents,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from '../../backend/src/auth/authority/__tests__/provider-security-fixture';
import { startConfiguredProviderTransport } from '../../backend/src/auth/current-store/__tests__/fixtures/app-router-providers';
import { handleBrowserBinding } from '../../backend/src/handlers/browser-binding';
import { handleProviderSecurity } from '../../backend/src/handlers/provider-security';
import { providerTokenHash } from '../../backend/src/auth/authority/provider-security-context';

const control = vi.hoisted(() => {
  process.env.NEXTAUTH_URL = 'https://www.provider-reauth.example.test';
  process.env.NEXTAUTH_SECRET = 'provider-finalization-owned-cookie-secret';
  return { observe: vi.fn(), legacyCalls: 0 };
});
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () =>
    new Proxy(
      {},
      {
        get() {
          control.legacyCalls += 1;
          throw new Error('UNEXPECTED_CONTENT_DATABASE');
        },
      },
    ),
}));
vi.mock('../../backend/src/db/client', () => ({ db: {}, dbRead: {} }));
vi.mock('@/app/lib/auth/browser-consumers.server', async (original) => {
  const actual = await original<typeof import('@/app/lib/auth/browser-consumers.server')>();
  return { ...actual, browserConsumerFacade: { ...actual.browserConsumerFacade, observe: control.observe } };
});
import { authOptions } from '../app/lib/auth/auth-options';
import { withAuthResponseAdmission } from '../app/lib/auth/auth-response-admission.server';
import { withPartnerSignInFailureReturn } from '../app/lib/partner-oauth/sign-in-failure-return';
import { withWebOAuthIdentity } from '../app/lib/auth/web-oauth-request.server';
import { readPresentedBrowserSelection } from '../app/lib/auth/presented-browser-selection.server';
import { captureProviderBrowserContext } from '../app/lib/auth/provider-security-selection.server';
import { createBrowserBindingCommandClient } from '../app/lib/auth/browser-binding-command-client.server';
import { createProviderSecurityCommandClient } from '../app/lib/auth/provider-security-command-client.server';
import { createProviderSecurityGoogleReauthentication } from '../app/lib/auth/provider-security-google-reauth.server';
import {
  BROWSER_CORRELATION_COOKIE,
  buildBrowserProofCookieCandidate,
  buildCanonicalCoordinatorCorrelationCookie,
} from '../app/lib/auth/browser-proof-cookies.server';
import {
  openProviderSecurityFlow,
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../app/lib/auth/provider-security-flow.server';

type Handler = (request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) => Promise<Response>;
type Kind = 'legacy-jwe' | 'canonical-token';
type Authority = 'current-store' | 'better-auth';
type Fault =
  | 'missing-auth-time'
  | 'old-auth-time'
  | 'foreign-subject'
  | 'foreign-owned-subject'
  | 'nonce'
  | 'state'
  | 'pkce'
  | 'late-cookie'
  | 'late-cookie-during-body'
  | 'late-location-during-body'
  | 'late-state'
  | 'late-nonce'
  | 'late-body'
  | 'late-redirect'
  | 'missing-ack'
  | 'owner-drift'
  | 'unavailable';
const www = 'https://www.provider-reauth.example.test';
const rpcSecret = 'owned-google-reauth-private-rpc-secret-6975';
const requestStorage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers(): Promise<Headers>;
  cookies(): Promise<{ getAll(): { name: string; value: string }[] }>;
};
const nextRequire = createRequire(require.resolve('next-auth'));
const oidc = nextRequire('openid-client') as { custom: { setHttpOptionsDefaults(settings: object): void } };
const nativeFetch = globalThis.fetch;
let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let providers: Awaited<ReturnType<typeof startConfiguredProviderTransport>>;
let backend: Server;
let privateOrigin: string;
let clientEnvironment: Readonly<Record<string, string | undefined>>;
let binding: ReturnType<typeof createBrowserBindingCommandClient>;
let provider: ReturnType<typeof createProviderSecurityCommandClient>;
let denied = false;
let issuerCalls = 0;
let retainedHeadersChanged = false;
let scenarioNumber = 0;
let cookies = new Map<string, string>();
const cookieHeader = () => [...cookies].map(([name, content]) => `${name}=${content}`).join('; ');
function remember(response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (/; Max-Age=0(?:;|$)/i.test(header)) cookies.delete(pair.slice(0, separator));
    else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
function request(path: string, form?: Record<string, string>) {
  return new NextRequest(new URL(`/api/auth/${path}`, www), {
    method: form ? 'POST' : 'GET',
    headers: {
      Host: new URL(www).host,
      // Each independent scenario represents its own ingress-observed peer;
      // preserve the actual twenty-start limiter instead of exhausting one
      // shared unknown-client bucket while exercising all callback cases.
      'X-Forwarded-For': `192.0.2.${scenarioNumber}`,
      Cookie: cookieHeader(),
      ...(form ? { Origin: www, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
}
async function invoke(options: NextAuthOptions, current: NextRequest) {
  return requestStorage.run(current, () =>
    (NextAuth(options) as Handler)(current, {
      params: Promise.resolve({ nextauth: current.nextUrl.pathname.slice('/api/auth/'.length).split('/') }),
    }),
  );
}
const readSelection = (header: string | null) =>
  denied
    ? Promise.resolve({ status: 'unavailable' } as const)
    : readPresentedBrowserSelection(header, { client: binding, environment: clientEnvironment });
function base(): NextAuthOptions {
  const forbidden = async (): Promise<never> => {
    issuerCalls += 1;
    throw new Error('Legacy issuer must never run');
  };
  return {
    ...authOptions,
    secret: environment.secret,
    providers: [
      GoogleProvider({ clientId: providers.clients.google.id, clientSecret: providers.clients.google.secret }),
    ],
    callbacks: { ...authOptions.callbacks, signIn: forbidden, jwt: forbidden, session: forbidden },
    events: { signIn: forbidden, createUser: forbidden, linkAccount: forbidden },
  };
}
async function pipeline(current: NextRequest, flow: ProviderSecurityFlow, fault?: Fault, ready = true) {
  const publication = createProviderSecurityGoogleReauthentication(base(), current, flow, {
    environment: clientEnvironment,
    ready: () => ready,
    readSelection,
    clientFactory: () => provider,
  });
  const options = publication.options;
  // The actual installed callback must not even reach its request-local issuer.
  for (const operation of ['encode', 'decode'] as const) {
    const original = options.jwt?.[operation];
    if (!original || !options.jwt) throw new Error('Missing forbidden issuer');
    options.jwt[operation] = async () => {
      issuerCalls += 1;
      throw new Error('Unexpected session codec');
    };
  }
  const context = {
    params: Promise.resolve({ nextauth: current.nextUrl.pathname.slice('/api/auth/'.length).split('/') }),
  };
  const response = await publication.run(async (selectedOptions) => {
    const admitted = await withAuthResponseAdmission(
      current,
      context,
      async () => {
        const response = await withWebOAuthIdentity(
          current,
          context,
          selectedOptions,
          (request, options) => invoke(options, request),
          {
            start: (input) => publication.bindStart(input),
            callback: (input) => input.invoke(input.request, input.options),
          },
        );
        return publication.quarantine(response);
      },
      fault === 'missing-ack' ? undefined : (completed) => publication.acknowledgeAdmission(completed),
    );
    const final = await withPartnerSignInFailureReturn(current, admitted);
    if (fault === 'late-cookie')
      final.headers.append(
        'Set-Cookie',
        '__Host-boardsesh.browser-proof.' + 'a'.repeat(64) + '.99=forged; Path=/; Secure; HttpOnly',
      );
    if (fault === 'late-state' || fault === 'late-nonce') {
      const destination = new URL(final.headers.get('Location') ?? 'https://accounts.google.com/o/oauth2/v2/auth');
      destination.searchParams.set(fault === 'late-state' ? 'state' : 'nonce', 'forged');
      final.headers.set('Location', destination.href);
    }
    if (fault === 'late-redirect')
      return new Response(null, { status: 302, headers: { Location: `${www}/settings?unbound=1` } });
    if (fault === 'late-body')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('Actual late body read'));
          },
        }),
      );
    if (fault === 'late-cookie-during-body' || fault === 'late-location-during-body') {
      let retained: Response;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            if (fault === 'late-cookie-during-body')
              retained.headers.append(
                'Set-Cookie',
                '__Host-boardsesh.browser-binding=forged; Path=/; Secure; HttpOnly',
              );
            else retained.headers.set('Location', 'https://foreign.example.test/');
            retainedHeadersChanged = true;
            controller.close();
          }, 0);
        },
      });
      retained = new Response(body, { status: final.status, headers: final.headers });
      return retained;
    }
    if (fault === 'unavailable') denied = true;
    if (fault === 'owner-drift') {
      const selected = await readSelection(cookieHeader());
      if (selected.status !== 'admitted') throw new Error('Actual logout actor unavailable');
      const intent = await binding.intent({
        bindingToken: selected.bindingToken,
        actor: selected.actor,
        expectedVersion: selected.cursor.version,
        transition: 'logout',
      });
      if (intent.outcome !== 'prepared') throw new Error('Actual logout intent refused');
      const logout = await binding.logout({
        bindingToken: selected.bindingToken,
        actor: selected.actor,
        intentToken: intent.intentToken,
      });
      expect(logout.outcome).toBe('committed');
    }
    return final;
  });
  return { response, publication };
}
async function begin(selected: Authority, kind: Kind, startFault?: Fault, unknownAge = false) {
  scenarioNumber += 1;
  denied = false;
  issuerCalls = 0;
  retainedHeadersChanged = false;
  const subject = randomUUID();
  const owner = await environment.actor(selected, kind, { provider: 'google', subject, password: false, unknownAge });
  cookies = new Map();
  const initial = [
    buildCanonicalCoordinatorCorrelationCookie({
      servingOrigin: www,
      canonicalOrigin: www,
      token: owner.actor.browserBindingToken,
      bindingId: providerTokenHash(owner.actor.browserBindingToken),
    }),
    ...buildBrowserProofCookieCandidate({
      cursor: { bindingId: providerTokenHash(owner.actor.browserBindingToken), version: owner.actor.browserVersion },
      proof: { kind, rawCredential: owner.actor.credential },
      proofMaxAgeSeconds: 3500,
      observedCookieHeader: null,
    }).headers,
  ];
  remember(
    new Response(null, {
      headers: initial.reduce((headers, header) => {
        headers.append('Set-Cookie', header);
        return headers;
      }, new Headers()),
    }),
  );
  expect(cookies.has(BROWSER_CORRELATION_COOKIE)).toBe(true);
  const before = await readSelection(cookieHeader());
  if (before.status !== 'admitted') throw new Error('Owned source did not admit');
  const captured = captureProviderBrowserContext(before);
  const intent = await provider.command('intent', {
    actor: captured.actor,
    action: 'link',
    provider: 'apple',
    methodId: null,
  });
  if (intent.outcome !== 'recorded') throw new Error('Owned intent refused');
  const issuedAt = new Date();
  const flow: ProviderSecurityFlow = {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: kind,
    actorCredentialHash: captured.credentialHash,
    browserBindingHash: captured.browserCursor.bindingId,
    browserVersion: captured.browserCursor.version,
    browserBindingExpiresAt: captured.browserCursor.bindingExpiresAt,
    sourceCredentialProof: captured.sourceCredentialProof,
    credentialExpiresAt: captured.credentialExpiresAt,
    intentToken: intent.intentToken,
    browserIntentToken: intent.browserIntentToken,
    recoveryToken: intent.recoveryToken,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(Math.min(Date.parse(intent.expiresAt), issuedAt.getTime() + 900_000)).toISOString(),
    reauthenticationToken: null,
    reauthenticationExpiresAt: null,
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
  const operationKey = providerSecurityOperationKey(flow.intentToken);
  cookies.set(
    providerSecurityFlowCookieName(operationKey, true),
    await sealProviderSecurityFlow(flow, environment.secret),
  );
  const csrf = await invoke(base(), request('csrf'));
  remember(csrf);
  const csrfToken = ((await csrf.json()) as { csrfToken: string }).csrfToken;
  const initiated = await pipeline(request('signin/google', { csrfToken }), flow, startFault);
  if (startFault) return { owner, before, flow, subject, initiated };
  expect(initiated.response.status).toBe(302);
  remember(initiated.response);
  const sealed = cookies.get(providerSecurityFlowCookieName(operationKey, true));
  if (!sealed) throw new Error('Bound operation cookie absent');
  const bound = await openProviderSecurityFlow(sealed, operationKey, environment.secret);
  return { owner, before, flow: bound, subject, initiated };
}
async function finish(selected: Authority, kind: Kind, fault?: Fault, unknownAge = false) {
  const started = await begin(selected, kind, undefined, unknownAge);
  const location = started.initiated.response.headers.get('Location');
  if (!location) throw new Error('Google destination missing');
  const foreignSubject = randomUUID();
  if (fault === 'foreign-owned-subject')
    await environment.actor(selected, kind, { provider: 'google', subject: foreignSubject });
  const identity = {
    subject: fault === 'foreign-subject' || fault === 'foreign-owned-subject' ? foreignSubject : started.subject,
    email: 'unrelated-identity@example.test',
    emailVerified: true,
    ...(fault === 'missing-auth-time'
      ? {}
      : { authenticationTime: Math.floor(Date.now() / 1000) - (fault === 'old-auth-time' ? 301 : 30) }),
  };
  const callback = providers.authorize(location, identity);
  if (fault === 'nonce' || fault === 'state' || fault === 'pkce') {
    const key = [...cookies.keys()].find((name) => name.includes(fault === 'pkce' ? 'pkce.code_verifier' : fault));
    if (!key) throw new Error('Scoped authentication cookie missing');
    cookies.set(key, 'forged');
  }
  const current = new NextRequest(callback.url, { headers: { Host: new URL(www).host, Cookie: cookieHeader() } });
  const oldCookies = cookieHeader();
  const completed = await pipeline(current, started.flow, fault);
  return { ...started, ...completed, oldCookies };
}
async function receipts(intentToken: string) {
  return environment.database
    .select()
    .from(authProviderReauthenticationReceipts)
    .where(eq(authProviderReauthenticationReceipts.intentHash, providerTokenHash(intentToken)));
}

beforeAll(async () => {
  if (!process.env.AUTH_PROTOTYPE_DATABASE_URL) throw new Error('Explicit owned PostgreSQL required');
  environment = await createProviderSecurityEnvironment();
  providers = await startConfiguredProviderTransport();
  providers.registerRedirect(www);
  oidc.custom.setHttpOptionsDefaults({ agent: providers.agent, timeout: 3000 });
  for (const [name, content] of Object.entries({
    CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
    CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
    CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_AUTH_PROJECTION_ID: environment.qualification.expectedProjectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-google-reauth-deleted-address-secret',
    NEXTAUTH_SECRET: environment.secret,
    NEXTAUTH_URL: www,
    GOOGLE_CLIENT_ID: providers.clients.google.id,
    GOOGLE_CLIENT_SECRET: providers.clients.google.secret,
    APPLE_ID: providers.clients.apple.id,
    APPLE_SECRET: providers.clients.apple.secret,
    CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE: 'auth-time-staging',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    AUTH_IDENTITY_MIRROR: 'off',
    DEBUG_SQL: 'false',
  }))
    vi.stubEnv(name, content);
  backend = createServer((request, response) => {
    void (
      request.url?.includes('/provider-security/')
        ? handleProviderSecurity(request, response, environment.database)
        : handleBrowserBinding(request, response, environment.database)
    ).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('Owned RPC unavailable');
  privateOrigin = `http://127.0.0.1:${address.port}`;
  clientEnvironment = { ...process.env, CURRENT_STORE_AUTH_BACKEND_ORIGIN: privateOrigin };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${privateOrigin}/`)) return nativeFetch(input, init);
    if (url !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unowned Google proof network');
    return new Promise<Response>((resolve, reject) => {
      const request = https.request(url, { agent: providers.agent }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        );
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });
  });
  provider = createProviderSecurityCommandClient({ environment: clientEnvironment });
  binding = createBrowserBindingCommandClient({ environment: clientEnvironment });
  control.observe.mockImplementation(readSelection);
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requestStorage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [],
  }));
});
afterEach(() => {
  denied = false;
});
afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  oidc.custom.setHttpOptionsDefaults({ agent: undefined });
  await new Promise<void>((resolve) => backend?.close(() => resolve()));
  await providers?.close();
  await environment?.close();
});

describe('proof-only actual Google callback with scoped nonce/state/PKCE and durable primary receipts', () => {
  for (const selected of ['current-store', 'better-auth'] as const)
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${selected}/${kind}: returns a fixed Settings STRING before any credential issuer and preserves original source`, async () => {
        const completed = await finish(selected, kind);
        expect(completed.response.status).toBe(302);
        expect(completed.response.headers.get('Location')).toBe(completed.publication.returnUrl);
        expect(issuerCalls).toBe(0);
        const headers = completed.response.headers.getSetCookie();
        expect(headers.some((header) => header.startsWith('__Host-boardsesh.provider-security.'))).toBe(true);
        expect(headers.some((header) => /browser-proof|browser-binding|session-token/.test(header))).toBe(false);
        expect(headers.some((header) => /next-auth\.nonce\.[a-f0-9]{32}=;/.test(header))).toBe(true);
        remember(completed.response);
        const current = await readSelection(cookieHeader());
        expect(current).toEqual(completed.before);
        const proof = await receipts(completed.flow.intentToken);
        expect(proof).toHaveLength(1);
        expect(proof[0]).toMatchObject({
          method: 'google-auth-time',
          proofProviderSubject: completed.subject,
          consumedAt: null,
        });
        const operationKey = providerSecurityOperationKey(completed.flow.intentToken);
        const frame = await openProviderSecurityFlow(
          cookies.get(providerSecurityFlowCookieName(operationKey, true))!,
          operationKey,
          environment.secret,
        );
        expect(frame.sourceCredentialProof).toEqual(completed.flow.sourceCredentialProof);
        expect(frame.credentialExpiresAt).toBe(completed.flow.credentialExpiresAt);
        expect(frame.reauthenticationToken).not.toBeNull();
        expect(frame.reauthenticationExpiresAt).toBe(proof[0].expiresAt.toISOString());
        expect(
          await environment.database
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.userId, completed.owner.userId)),
        ).toEqual([]);
      });
    }
  it.each([
    'missing-auth-time',
    'old-auth-time',
    'foreign-subject',
    'foreign-owned-subject',
    'nonce',
    'state',
    'pkce',
  ] as const)('refuses %s without a proof or credential change', async (fault) => {
    const completed = await finish('better-auth', 'canonical-token', fault);
    expect(completed.response.status).toBe(503);
    expect(completed.response.headers.getSetCookie()).toEqual([]);
    expect(await receipts(completed.flow.intentToken)).toEqual([]);
    expect(await readSelection(completed.oldCookies)).toEqual(completed.before);
    expect(issuerCalls).toBe(0);
    const [intent] = await environment.database
      .select()
      .from(authProviderSecurityIntents)
      .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(completed.flow.intentToken)));
    expect(intent.consumedAt).toBeNull();
  });
  it.each(['late-cookie-during-body', 'late-location-during-body'] as const)(
    'snapshots final headers before held body work against %s',
    async (fault) => {
      const completed = await finish('better-auth', 'canonical-token', fault);
      expect(retainedHeadersChanged).toBe(true);
      expect(completed.response.status).toBe(302);
      expect(completed.response.headers.get('Location')).toBe(completed.publication.returnUrl);
      expect(
        completed.response.headers
          .getSetCookie()
          .some((header) => /browser-binding|browser-proof|session-token/.test(header)),
      ).toBe(false);
      expect(await receipts(completed.flow.intentToken)).toHaveLength(1);
    },
  );
  it.each(['late-state', 'late-nonce'] as const)(
    'refuses post-bind %s before publishing the bound carrier',
    async (fault) => {
      const started = await begin('current-store', 'legacy-jwe', fault);
      expect(started.initiated.response.status).toBe(503);
      expect(started.initiated.response.headers.getSetCookie()).toEqual([]);
      expect(await receipts(started.flow.intentToken)).toEqual([]);
    },
  );
  it.each(['late-cookie', 'late-body', 'late-redirect', 'missing-ack', 'owner-drift', 'unavailable'] as const)(
    'withholds proof publication after %s',
    async (fault) => {
      const completed = await finish('current-store', 'canonical-token', fault);
      expect(completed.response.status).toBe(503);
      expect(completed.response.headers.getSetCookie()).toEqual([]);
      expect(issuerCalls).toBe(0);
    },
  );
  it('qualifies actual Google evidence without promoting an unknown original source age', async () => {
    const completed = await finish('better-auth', 'canonical-token', undefined, true);
    expect(completed.response.status).toBe(302);
    remember(completed.response);
    const selected = await readSelection(cookieHeader());
    expect(selected).toEqual(completed.before);
    if (selected.status !== 'admitted') throw new Error('Actual original source refused');
    expect(selected.session.authenticatedAt).toBeNull();
    expect(selected.session.linkGuarded).toBe(false);
    expect(await receipts(completed.flow.intentToken)).toHaveLength(1);
  });
  it('keeps the public readiness floor false before any NextAuth or private request', async () => {
    const started = await begin('current-store', 'canonical-token');
    const current = request('signin/google', { csrfToken: 'untrusted' });
    const publication = createProviderSecurityGoogleReauthentication(
      base(),
      current,
      { ...started.flow, googleFlowHash: null, googleNonce: null },
      { environment: clientEnvironment },
    );
    const invoke = vi.fn(async () => new Response(null));
    expect((await publication.run(invoke)).status).toBe(503);
    expect(invoke).not.toHaveBeenCalled();
  });
});
