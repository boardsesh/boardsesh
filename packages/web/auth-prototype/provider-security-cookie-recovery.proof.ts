import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { authProviderSecurityIntents, authSecurityMutationEvents } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import { createProviderSecurityEnvironment } from '../../backend/src/auth/authority/__tests__/provider-security-fixture';
import { describeBrowserBinding } from '../../backend/src/auth/authority/browser-binding';
import { handleBrowserBinding } from '../../backend/src/handlers/browser-binding';
import { handleProviderSecurity } from '../../backend/src/handlers/provider-security';
vi.mock('server-only', () => ({}));
vi.mock('../../backend/src/db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_RECOVERY_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_RECOVERY_DATABASE');
      },
    },
  ),
}));
import { readPresentedBrowserSelection } from '../app/lib/auth/presented-browser-selection.server';
import { createBrowserBindingCommandClient } from '../app/lib/auth/browser-binding-command-client.server';
import {
  createProviderSecurityCommandClient,
  providerCandidateCredentialHash,
} from '../app/lib/auth/provider-security-command-client.server';
import { readProviderSecurityRecoveryInput } from '../app/lib/auth/provider-security-recovery.server';
import { createProviderSecurityDirectPublication } from '../app/lib/auth/provider-security-direct.server';
import {
  captureProviderBrowserContext,
  ProviderSecurityIdentityChangedError,
} from '../app/lib/auth/provider-security-selection.server';
import {
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../app/lib/auth/provider-security-flow.server';
import {
  BROWSER_CORRELATION_COOKIE,
  buildBrowserProofCookieCandidate,
  buildCanonicalCoordinatorCorrelationCookie,
  readBrowserProofCookie,
} from '../app/lib/auth/browser-proof-cookies.server';

const rpcSecret = 'owned-cookie-recovery-private-rpc-secret-6975';
let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let backend: Server;
let server: HttpsServer;
let browser: Browser;
let context: BrowserContext | undefined;
let certificateDirectory: string;
let www: string;
let privateOrigin: string;
let provider: ReturnType<typeof createProviderSecurityCommandClient>;
let binding: ReturnType<typeof createBrowserBindingCommandClient>;
let dropFinalizerReply = false;
let direct: ReturnType<typeof createProviderSecurityDirectPublication>;
let directScenario:
  | {
      readonly operationKey: string;
      readonly actorContextKey: string;
      readonly userId: string;
      readonly authSessionId: string;
      readonly authenticatedAt: string | null;
      readonly expiresAt: string;
      readonly initialHeaders: readonly string[];
      readonly requests: { readonly path: string; readonly method: string; status?: number; dropped?: boolean }[];
    }
  | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
interface Scenario {
  readonly operationKey: string;
  readonly initialHeaders: readonly string[];
  finalHeaders: readonly string[] | null;
  readonly planFinalHeaders: (observedCookieHeader: string | null) => readonly string[];
  readonly userId: string;
  readonly authSessionId: string;
  readonly originalAuthenticatedAt: string | null;
  readonly expiresAt: string;
  readonly originalProof: { readonly kind: ProviderSecurityActor['kind']; readonly rawCredential: string };
  readonly candidateProof: { readonly kind: ProviderSecurityActor['kind']; readonly rawCredential: string };
  readonly bindingId: string;
  readonly initialVersion: number;
  readonly held: ReturnType<typeof deferred>;
  readonly release: ReturnType<typeof deferred>;
  finalize: ((actor: ProviderSecurityActor) => ReturnType<typeof provider.command<'finalize'>>) | null;
  readonly switchToLater: (cookies: string | null) => Promise<readonly string[]>;
}
let scenario: Scenario | undefined;

const pair = (header: string) => header.split(';', 1)[0];
function absolute(headers: readonly string[], expiresAt: string) {
  return headers.map((header) => header.replace(/; Max-Age=\d+$/, `; Expires=${new Date(expiresAt).toUTCString()}`));
}
const readSelection = (cookies: string | null) =>
  readPresentedBrowserSelection(cookies, {
    client: binding,
    environment: { CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging' },
  });
async function observedAck(cookies: string | null, operationKey: string) {
  const input = await readProviderSecurityRecoveryInput(cookies, operationKey, {
    secret: environment.secret,
    readSelection,
  });
  // The input reader has no access to this fixture's captured finalizer or
  // proposed credentials. BOTH raw credentials come from this real request.
  return provider.command('recover', input);
}

async function setup(selected: 'current-store' | 'better-auth', kind: ProviderSecurityActor['kind']) {
  const owner = await environment.actor(selected, kind);
  const prepared = await environment.prepareLink(owner);
  const candidate = await environment.candidate(prepared, kind);
  const later = await environment.actor(selected, kind);
  const descriptor = await describeBrowserBinding(
    environment.database,
    environment.qualification,
    owner.actor.browserBindingToken,
  );
  if (descriptor.status !== 'known') throw new Error('Owned selected binding unavailable');
  const currentCursor = { bindingId: descriptor.cursor.bindingId, version: descriptor.cursor.version };
  const correlation = buildCanonicalCoordinatorCorrelationCookie({
    servingOrigin: www,
    canonicalOrigin: www,
    token: owner.actor.browserBindingToken,
    bindingId: currentCursor.bindingId,
  });
  const old = buildBrowserProofCookieCandidate({
    cursor: currentCursor,
    proof: { kind, rawCredential: owner.actor.credential },
    proofMaxAgeSeconds: 3600,
    observedCookieHeader: pair(correlation),
  });
  const flow: ProviderSecurityFlow = {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: kind,
    actorCredentialHash: providerCandidateCredentialHash(owner.actor),
    browserBindingHash: currentCursor.bindingId,
    browserVersion: currentCursor.version,
    browserBindingExpiresAt: descriptor.cursor.bindingExpiresAt.toISOString(),
    sourceCredentialProof: { ...prepared.credentialProof, generation: prepared.credentialProof.generation - 1 },
    credentialExpiresAt: prepared.credentialExpiresAt.toISOString(),
    intentToken: prepared.intentToken,
    browserIntentToken: prepared.browserIntentToken,
    recoveryToken: prepared.recoveryToken,
    issuedAt: new Date().toISOString(),
    expiresAt: prepared.expiresAt.toISOString(),
    reauthenticationToken: prepared.reauthenticationToken,
    reauthenticationExpiresAt: prepared.expiresAt.toISOString(),
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
  const operationKey = providerSecurityOperationKey(flow.intentToken);
  const carrier = `${providerSecurityFlowCookieName(operationKey, true)}=${await sealProviderSecurityFlow(flow, environment.secret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(flow.expiresAt).toUTCString()}`;
  const initialHeaders = [correlation, ...old.proofHeaders, carrier];
  scenario = {
    operationKey,
    initialHeaders,
    finalHeaders: null,
    planFinalHeaders(observedCookieHeader) {
      const proposed = buildBrowserProofCookieCandidate({
        cursor: { ...currentCursor, version: currentCursor.version + 1 },
        proof: { kind, rawCredential: candidate.credential },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader,
        retainObservedProofCookies: true,
      });
      return absolute(proposed.headers, flow.credentialExpiresAt);
    },
    userId: owner.userId,
    authSessionId: owner.sid,
    originalAuthenticatedAt: flow.sourceCredentialProof.authenticatedAt,
    expiresAt: flow.credentialExpiresAt,
    originalProof: { kind, rawCredential: owner.actor.credential },
    candidateProof: { kind, rawCredential: candidate.credential },
    bindingId: currentCursor.bindingId,
    initialVersion: currentCursor.version,
    held: deferred(),
    release: deferred(),
    finalize: (actor) =>
      provider.command('finalize', {
        actor,
        intentToken: prepared.intentToken,
        browserIntentToken: prepared.browserIntentToken,
        reauthenticationToken: prepared.reauthenticationToken,
        preparationToken: prepared.preparationToken,
        candidate,
      }),
    async switchToLater(cookies) {
      const admitted = await readSelection(cookies);
      if (admitted.status !== 'admitted') throw new Error('Owned later sign-in lacks actual current proof');
      const intent = await binding.intent({
        bindingToken: admitted.bindingToken,
        transition: 'login',
        expectedVersion: admitted.cursor.version,
        expectedIdentity: { userId: admitted.session.userId, authSessionId: admitted.session.authSessionId },
        actor: admitted.actor,
      });
      if (intent.outcome !== 'prepared') throw new Error('Owned later login intent refused');
      const source =
        kind === 'canonical-token'
          ? ({ kind, token: later.actor.credential } as const)
          : ({ kind, credential: later.actor.credential } as const);
      const future = { bindingId: admitted.cursor.bindingId, version: admitted.cursor.version + 1 };
      const plan = buildBrowserProofCookieCandidate({
        cursor: future,
        proof: { kind, rawCredential: later.actor.credential },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: cookies,
        retainObservedProofCookies: true,
      });
      const headers = absolute(plan.headers, later.sourceExpiresAt.toISOString());
      const reply = await binding.login({
        bindingToken: admitted.bindingToken,
        intentToken: intent.intentToken,
        actor: admitted.actor,
        candidate: source,
      });
      if (
        reply.outcome !== 'committed' ||
        reply.cursor.bindingId !== future.bindingId ||
        reply.cursor.version !== future.version
      )
        throw new Error('Owned later login refused');
      return headers;
    },
  };
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === www ? route.continue() : route.abort('blockedbyclient'),
  );
  const page = await context.newPage();
  await page.goto(`${www}/page`);
  expect(await page.evaluate(async () => (await fetch('/fixture/bootstrap', { credentials: 'include' })).status)).toBe(
    200,
  );
  return { current: scenario, page };
}
async function cookies() {
  return (await context!.cookies(www)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
async function recover(page: Page, operationKey: string) {
  return page.evaluate(async (key) => {
    const reply = await fetch(`/fixture/recover/${key}`, { credentials: 'include', cache: 'no-store' });
    return { status: reply.status, body: (await reply.json()) as Record<string, unknown> };
  }, operationKey);
}

async function setupDirect(selected: 'current-store' | 'better-auth', kind: ProviderSecurityActor['kind']) {
  const owner = await environment.actor(selected, kind, { provider: 'apple' });
  const methods = await provider.command('methods', { actor: owner.actor });
  if (methods.outcome !== 'available') throw new Error('Owned unlink methods unavailable');
  const method = methods.providers.find((entry) => entry.provider === 'apple');
  if (!method?.canUnlink) throw new Error('Owned Apple method cannot unlink');
  const intent = await provider.command('intent', {
    actor: owner.actor,
    action: 'unlink',
    provider: 'apple',
    methodId: method.methodId,
  });
  if (intent.outcome !== 'recorded') throw new Error('Owned unlink intent unavailable');
  const proof = await provider.command('reauthenticate-password', {
    actor: owner.actor,
    intentToken: intent.intentToken,
    browserIntentToken: intent.browserIntentToken,
    password: ' exact password ',
  });
  if (proof.outcome !== 'proved') throw new Error('Actual owned password comparison refused');
  const correlation = buildCanonicalCoordinatorCorrelationCookie({
    servingOrigin: www,
    canonicalOrigin: www,
    token: owner.actor.browserBindingToken,
    bindingId: intent.browserCursor.bindingId,
  });
  const original = buildBrowserProofCookieCandidate({
    cursor: { bindingId: intent.browserCursor.bindingId, version: intent.browserCursor.version },
    proof: { kind, rawCredential: owner.actor.credential },
    proofMaxAgeSeconds: 3600,
    observedCookieHeader: pair(correlation),
  });
  const originalHeaders = [correlation, ...original.proofHeaders];
  const observed = await readSelection(originalHeaders.map(pair).join('; '));
  if (observed.status !== 'admitted') throw new Error('Owned direct source missing');
  const current = captureProviderBrowserContext(observed);
  const issuedAt = new Date();
  const frame: ProviderSecurityFlow = {
    version: 1,
    action: 'unlink',
    provider: 'apple',
    methodId: method.methodId,
    actorKind: kind,
    actorCredentialHash: current.credentialHash,
    browserBindingHash: current.browserCursor.bindingId,
    browserVersion: current.browserCursor.version,
    browserBindingExpiresAt: current.browserCursor.bindingExpiresAt,
    sourceCredentialProof: current.sourceCredentialProof,
    credentialExpiresAt: current.credentialExpiresAt,
    intentToken: intent.intentToken,
    browserIntentToken: intent.browserIntentToken,
    recoveryToken: intent.recoveryToken,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(Math.min(Date.parse(intent.expiresAt), issuedAt.getTime() + 15 * 60_000)).toISOString(),
    reauthenticationToken: proof.reauthenticationToken,
    reauthenticationExpiresAt: proof.expiresAt,
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
  const operationKey = providerSecurityOperationKey(frame.intentToken);
  const carrier = `${providerSecurityFlowCookieName(operationKey, true)}=${await sealProviderSecurityFlow(frame, environment.secret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(frame.expiresAt).toUTCString()}`;
  directScenario = {
    operationKey,
    actorContextKey: current.actorContextKey,
    userId: owner.userId,
    authSessionId: owner.sid,
    authenticatedAt: current.sourceCredentialProof.authenticatedAt,
    expiresAt: current.credentialExpiresAt,
    initialHeaders: [...originalHeaders, carrier],
    requests: [],
  };
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === www ? route.continue() : route.abort('blockedbyclient'),
  );
  const page = await context.newPage();
  await page.goto(`${www}/page`);
  expect(
    await page.evaluate(async () => (await fetch('/fixture/direct-bootstrap', { credentials: 'include' })).status),
  ).toBe(200);
  return { page, current: directScenario };
}

beforeAll(async () => {
  if (!process.env.AUTH_PROTOTYPE_DATABASE_URL) throw new Error('Explicit owned AUTH_PROTOTYPE_DATABASE_URL required');
  environment = await createProviderSecurityEnvironment();
  for (const [name, content] of Object.entries({
    CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
    CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_AUTH_PROJECTION_ID: environment.qualification.expectedProjectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-cookie-recovery-deleted-address-key',
    NEXTAUTH_SECRET: environment.secret,
    GOOGLE_CLIENT_ID: 'owned-google-client',
    GOOGLE_CLIENT_SECRET: 'owned-google-secret',
    APPLE_ID: 'owned-apple-client',
    APPLE_SECRET: 'owned-apple-secret',
    CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE: 'off',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    AUTH_IDENTITY_MIRROR: 'off',
    DEBUG_SQL: 'false',
  }))
    vi.stubEnv(name, content);
  backend = createServer((request, response) => {
    const providerRequest = request.url?.includes('/provider-security/');
    if (providerRequest && request.url?.endsWith('/finalize') && dropFinalizerReply) {
      dropFinalizerReply = false;
      response.end = () => {
        response.destroy();
        return response;
      };
    }
    void (
      providerRequest
        ? handleProviderSecurity(request, response, environment.database)
        : handleBrowserBinding(request, response, environment.database)
    ).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const privateAddress = backend.address();
  if (!privateAddress || typeof privateAddress === 'string') throw new Error('Owned private listener unavailable');
  privateOrigin = `http://127.0.0.1:${privateAddress.port}`;
  const clientEnvironment = { ...process.env, CURRENT_STORE_AUTH_BACKEND_ORIGIN: privateOrigin };
  provider = createProviderSecurityCommandClient({ environment: clientEnvironment });
  binding = createBrowserBindingCommandClient({ environment: clientEnvironment });
  direct = createProviderSecurityDirectPublication({
    environment: clientEnvironment,
    ready: () => true,
    readSelection,
    clientFactory: () => provider,
  });
  certificateDirectory = await mkdtemp(join(tmpdir(), '6975-provider-recovery-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=www.boardsesh.test',
      '-addext',
      'subjectAltName=DNS:www.boardsesh.test',
      '-keyout',
      join(certificateDirectory, 'key.pem'),
      '-out',
      join(certificateDirectory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  server = createHttpsServer(
    {
      key: await readFile(join(certificateDirectory, 'key.pem')),
      cert: await readFile(join(certificateDirectory, 'cert.pem')),
    },
    (request, response) => {
      void (async () => {
        const path = new URL(request.url ?? '/', 'https://fixture.invalid').pathname;
        response.setHeader('Cache-Control', 'private, no-store');
        if (path === '/page') {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><body>Owned provider cookie recovery fixture</body>');
          return;
        }
        if (path.startsWith('/fixture/direct-')) {
          const active = directScenario;
          if (!active) {
            response.writeHead(503).end();
            return;
          }
          if (path === '/fixture/direct-bootstrap') {
            response.setHeader('Set-Cookie', [...active.initialHeaders]);
            response.end();
            return;
          }
          const trace: { path: string; method: string; status?: number; dropped?: boolean } = {
            path,
            method: request.method ?? '',
          };
          active.requests.push(trace);
          if (path.endsWith('unknown')) dropFinalizerReply = true;
          const result =
            path === '/fixture/direct-ack'
              ? await direct.acknowledge({
                  cookieHeader: request.headers.cookie ?? null,
                  operationKey: active.operationKey,
                })
              : await direct.unlink({
                  cookieHeader: request.headers.cookie ?? null,
                  operationKey: active.operationKey,
                  actorContextKey: active.actorContextKey,
                });
          trace.status = result.status;
          if (path.endsWith('headers-lost') && result.status === 200) {
            trace.dropped = true;
            response.destroy();
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          if (result.headers.getSetCookie().length) response.setHeader('Set-Cookie', result.headers.getSetCookie());
          response.writeHead(result.status);
          if (path.endsWith('body-lost') && result.status === 200) {
            response.flushHeaders();
            response.write('{"body":"unfinished');
            setTimeout(() => response.destroy(), 50);
            return;
          }
          response.end(await result.text());
          return;
        }
        const current = scenario;
        if (!current) {
          response.writeHead(503).end();
          return;
        }
        if (path === '/fixture/bootstrap') {
          response.setHeader('Set-Cookie', [...current.initialHeaders]);
          response.end();
          return;
        }
        if (path.startsWith('/fixture/recover/')) {
          const reply = await observedAck(request.headers.cookie ?? null, path.slice('/fixture/recover/'.length));
          response.setHeader('Content-Type', 'application/json');
          response.writeHead(reply.outcome === 'recovered' ? 200 : 409).end(JSON.stringify(reply));
          return;
        }
        if (path === '/fixture/later-login') {
          response.setHeader('Set-Cookie', [...(await current.switchToLater(request.headers.cookie ?? null))]);
          response.end();
          return;
        }
        if (path === '/fixture/held-original') {
          if (!current.finalHeaders) {
            response.writeHead(409).end();
            return;
          }
          current.held.resolve();
          await current.release.promise;
          response.setHeader('Set-Cookie', [...current.finalHeaders]);
          response.end();
          return;
        }
        if (path === '/fixture/body-lost' || path === '/fixture/headers-lost' || path === '/fixture/unknown-finalize') {
          const observed = request.headers.cookie ?? null;
          const selection = await readSelection(observed);
          if (selection.status !== 'admitted') throw new ProviderSecurityIdentityChangedError();
          const actor = captureProviderBrowserContext(selection).actor;
          // Budget the ENTIRE actual incoming header before the first write.
          const finalHeaders = current.planFinalHeaders(observed);
          const finalize = current.finalize;
          current.finalize = null;
          if (!finalize) {
            response.writeHead(409).end();
            return;
          }
          current.finalHeaders = finalHeaders;
          if (path.endsWith('unknown-finalize')) dropFinalizerReply = true;
          const committed = await finalize(actor);
          if (committed.outcome !== 'committed') {
            response.writeHead(503).end();
            return;
          }
          if (path.endsWith('headers-lost')) {
            response.destroy();
            return;
          }
          response.setHeader('Set-Cookie', [...finalHeaders]);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.flushHeaders();
          response.write('{"body":"unfinished');
          setTimeout(() => response.destroy(), 50);
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.writeHead(error instanceof ProviderSecurityIdentityChangedError ? 409 : 503).end(
          JSON.stringify({
            outcome: error instanceof ProviderSecurityIdentityChangedError ? 'identity_changed' : 'unavailable',
          }),
        );
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned HTTPS listener unavailable');
  www = `https://www.boardsesh.test:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-background-networking',
      '--no-proxy-server',
      '--host-resolver-rules=MAP *.boardsesh.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ],
  });
});
afterEach(async () => {
  scenario?.release.resolve();
  await context?.close();
  context = undefined;
  scenario = undefined;
  directScenario = undefined;
  dropFinalizerReply = false;
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  backend?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (backend) await new Promise<void>((resolve) => backend.close(() => resolve()));
  await environment?.close();
  vi.unstubAllEnvs();
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

describe('actual next HTTPS request provider result recovery', () => {
  for (const selected of ['current-store', 'better-auth'] as const)
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${selected}/${kind}: lost body retains actual actor/candidate/carrier for exact primary ACK`, async () => {
        const { current, page } = await setup(selected, kind);
        const lost = await page.evaluate(async () => {
          const reply = await fetch('/fixture/body-lost', { credentials: 'include' });
          try {
            await reply.json();
            return { status: reply.status, bodyLost: false };
          } catch {
            return { status: reply.status, bodyLost: true };
          }
        });
        expect(lost).toEqual({ status: 200, bodyLost: true });
        const observed = await cookies();
        expect(
          readBrowserProofCookie(observed, { bindingId: current.bindingId, version: current.initialVersion }),
        ).toEqual({ status: 'present', proof: current.originalProof });
        expect(
          readBrowserProofCookie(observed, { bindingId: current.bindingId, version: current.initialVersion + 1 }),
        ).toEqual({ status: 'present', proof: current.candidateProof });
        expect(observed).toContain(`${providerSecurityFlowCookieName(current.operationKey, true)}=`);
        const reply = await recover(page, current.operationKey);
        expect(reply.status).toBe(200);
        expect(reply.body.outcome).toBe('recovered');
        expect(JSON.stringify(reply.body)).not.toContain(current.candidateProof.rawCredential);
        const admitted = await readSelection(observed);
        expect(admitted.status).toBe('admitted');
        if (admitted.status !== 'admitted') throw new Error('Owned committed source missing');
        expect(admitted.session).toMatchObject({
          userId: current.userId,
          authSessionId: current.authSessionId,
          generation: 1,
          authenticatedAt: current.originalAuthenticatedAt,
          expiresAt: current.expiresAt,
        });
        expect(await page.evaluate(() => document.cookie)).not.toContain('boardsesh.');
      });
      for (const failure of ['headers-lost', 'unknown-finalize'] as const)
        it(`${selected}/${kind}: ${failure} preserves old browser material but cannot reconstruct the missing candidate`, async () => {
          const { current, page } = await setup(selected, kind);
          const before = await cookies();
          await page.evaluate(async (path) => {
            try {
              await (await fetch(`/fixture/${path}`, { credentials: 'include' })).text();
            } catch {
              /* Exact response loss is the fixture. */
            }
          }, failure);
          expect(await cookies()).toBe(before);
          expect((await recover(page, current.operationKey)).status).toBe(409);
          const [stored] = await environment.database
            .select()
            .from(authProviderSecurityIntents)
            .where(eq(authProviderSecurityIntents.intentHash, current.operationKey));
          expect(stored.phase).toBe('committed');
          expect(
            await environment.database
              .select()
              .from(authSecurityMutationEvents)
              .where(
                and(
                  eq(authSecurityMutationEvents.userId, current.userId),
                  eq(authSecurityMutationEvents.kind, 'provider-link'),
                ),
              ),
          ).toHaveLength(1);
        });
      it(`${selected}/${kind}: budgets all actual cookies before committing any provider mutation`, async () => {
        const { current, page } = await setup(selected, kind);
        await context!.addCookies([
          { name: 'unrelated-observed-A', value: 'x'.repeat(3500), url: www, secure: true },
          { name: 'unrelated-observed-B', value: 'y'.repeat(3500), url: www, secure: true },
        ]);
        expect(
          await page.evaluate(async () => (await fetch('/fixture/body-lost', { credentials: 'include' })).status),
        ).toBe(503);
        const [stored] = await environment.database
          .select()
          .from(authProviderSecurityIntents)
          .where(eq(authProviderSecurityIntents.intentHash, current.operationKey));
        expect(stored.phase).toBe('prepared');
        expect(
          await environment.database
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.userId, current.userId)),
        ).toHaveLength(0);
        const admittedAfterBudgetRefusal = await readSelection(await cookies());
        expect(admittedAfterBudgetRefusal.status).toBe('admitted');
        if (admittedAfterBudgetRefusal.status !== 'admitted') throw new Error('Owned source unexpectedly changed');
        expect(admittedAfterBudgetRefusal.session.generation).toBe(0);
      });
      it(`${selected}/${kind}: refuses a missing real old actor before using any captured finalizer state`, async () => {
        const { current, page } = await setup(selected, kind);
        await context!.clearCookies({ name: /^__Host-boardsesh\.browser-proof\./ });
        expect(
          await page.evaluate(async () => (await fetch('/fixture/body-lost', { credentials: 'include' })).status),
        ).toBe(409);
        const [stored] = await environment.database
          .select()
          .from(authProviderSecurityIntents)
          .where(eq(authProviderSecurityIntents.intentHash, current.operationKey));
        expect(stored.phase).toBe('prepared');
        expect(
          await environment.database
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.userId, current.userId)),
        ).toHaveLength(0);
      });
      it(`${selected}/${kind}: delayed original headers after later login cannot displace the primary or recover an old result`, async () => {
        const { current, page } = await setup(selected, kind);
        await page.evaluate(async () => {
          const reply = await fetch('/fixture/body-lost', { credentials: 'include' });
          try {
            await reply.text();
          } catch {
            /* Candidate headers were installed before the lost body. */
          }
        });
        await page.evaluate(() => {
          Object.assign(globalThis, {
            heldProviderReply: fetch('/fixture/held-original', { credentials: 'include' }).then(
              (reply) => reply.status,
            ),
          });
        });
        await current.held.promise;
        expect(
          await page.evaluate(async () => (await fetch('/fixture/later-login', { credentials: 'include' })).status),
        ).toBe(200);
        const before = await readSelection(await cookies());
        expect(before.status).toBe('admitted');
        if (before.status !== 'admitted') throw new Error('Owned later login missing');
        expect(before.session.userId).not.toBe(current.userId);
        current.release.resolve();
        await page.evaluate(async () => {
          await (globalThis as typeof globalThis & { heldProviderReply: Promise<number> }).heldProviderReply;
        });
        const after = await readSelection(await cookies());
        expect(after).toEqual(before);
        expect((await recover(page, current.operationKey)).status).toBe(409);
        expect((await context!.cookies(www)).find((cookie) => cookie.name === BROWSER_CORRELATION_COOKIE)?.value).toBe(
          before.bindingToken,
        );
      });
    }
});

describe('actual direct unlink server composition', () => {
  for (const selected of ['current-store', 'better-auth'] as const)
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${selected}/${kind}: actual password/prepare/issuer/finalize and next-request ACK preserve original authority`, async () => {
        const { page, current } = await setupDirect(selected, kind);
        const before = await cookies();
        const result = await page.evaluate(async () => {
          const response = await fetch('/fixture/direct-body-lost', { method: 'POST', credentials: 'include' });
          try {
            await response.json();
            return { status: response.status, lost: false };
          } catch {
            return { status: response.status, lost: true };
          }
        });
        expect(result).toEqual({ status: 200, lost: true });
        const after = await cookies();
        for (const cookie of before.split('; ')) expect(after).toContain(cookie);
        const admitted = await readSelection(after);
        expect(admitted.status).toBe('admitted');
        if (admitted.status !== 'admitted') throw new Error('Owned direct candidate missing');
        expect(admitted.session).toMatchObject({
          userId: current.userId,
          authSessionId: current.authSessionId,
          generation: 1,
          authenticatedAt: current.authenticatedAt,
          expiresAt: current.expiresAt,
        });
        const ack = await page.evaluate(async () => {
          const response = await fetch('/fixture/direct-ack', { method: 'POST', credentials: 'include' });
          return { status: response.status, body: await response.json() };
        });
        expect(ack).toEqual({ status: 200, body: { outcome: 'completed' } });
        const methods = await provider.command('methods', { actor: captureProviderBrowserContext(admitted).actor });
        expect(methods.outcome).toBe('available');
        if (methods.outcome !== 'available') throw new Error('Owned direct methods missing');
        expect(methods.providers).toEqual([]);
        expect(methods.passwordUsable).toBe(true);
      });
      for (const failure of ['unknown', 'headers-lost'] as const)
        it(`${selected}/${kind}: ${failure} emits no candidate and cannot ACK absent actual bytes`, async () => {
          const { page, current } = await setupDirect(selected, kind);
          const before = await cookies();
          const status = await page.evaluate(async (mode) => {
            try {
              return (await fetch(`/fixture/direct-${mode}`, { method: 'POST', credentials: 'include' })).status;
            } catch {
              return null;
            }
          }, failure);
          if (failure === 'unknown') {
            expect(status).toBe(503);
            expect(current.requests).toEqual([{ path: '/fixture/direct-unknown', method: 'POST', status: 503 }]);
          } else {
            // Chromium can transparently resend even this empty-body POST
            // after losing the complete response. Prove the first result was
            // actually dropped and every resend refuses without another write.
            expect(current.requests[0]).toEqual({
              path: '/fixture/direct-headers-lost',
              method: 'POST',
              status: 200,
              dropped: true,
            });
            expect([null, 409]).toContain(status);
            if (status === 409) expect(current.requests.length).toBeGreaterThan(1);
            for (const retry of current.requests.slice(1))
              expect(retry).toEqual({ path: '/fixture/direct-headers-lost', method: 'POST', status: 409 });
          }
          expect(await cookies()).toBe(before);
          expect(
            await page.evaluate(
              async () => (await fetch('/fixture/direct-ack', { method: 'POST', credentials: 'include' })).status,
            ),
          ).toBe(409);
          const [stored] = await environment.database
            .select()
            .from(authProviderSecurityIntents)
            .where(eq(authProviderSecurityIntents.intentHash, current.operationKey));
          expect(stored.phase).toBe('committed');
          expect(
            await environment.database
              .select()
              .from(authSecurityMutationEvents)
              .where(
                and(
                  eq(authSecurityMutationEvents.userId, current.userId),
                  eq(authSecurityMutationEvents.kind, 'provider-unlink'),
                ),
              ),
          ).toHaveLength(1);
        });
      it(`${selected}/${kind}: entire header overcapacity aborts only preparation and preserves credentials`, async () => {
        const { page, current } = await setupDirect(selected, kind);
        await context!.addCookies([
          { name: 'direct-observed-A', value: 'x'.repeat(3500), url: www, secure: true },
          { name: 'direct-observed-B', value: 'y'.repeat(3500), url: www, secure: true },
        ]);
        expect(
          await page.evaluate(
            async () => (await fetch('/fixture/direct-unlink', { method: 'POST', credentials: 'include' })).status,
          ),
        ).toBe(503);
        expect(
          await environment.database
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.userId, current.userId)),
        ).toHaveLength(0);
        const selectedAfter = await readSelection(await cookies());
        expect(selectedAfter.status).toBe('admitted');
        if (selectedAfter.status !== 'admitted') throw new Error('Owned old source changed');
        expect(selectedAfter.session.generation).toBe(0);
        const methods = await provider.command('methods', {
          actor: captureProviderBrowserContext(selectedAfter).actor,
        });
        expect(methods.outcome).toBe('available');
        if (methods.outcome !== 'available') throw new Error('Owned old methods missing');
        expect(methods.providers).toHaveLength(1);
      });
    }
});
