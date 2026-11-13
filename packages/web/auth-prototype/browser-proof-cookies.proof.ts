import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { decode, encode } from 'next-auth/jwt';
import { eq } from 'drizzle-orm';
import { authSession } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
vi.mock('server-only', () => ({}));
import {
  BROWSER_CORRELATION_COOKIE,
  browserProofCookieName,
  buildBrowserProofCookieCandidate,
  buildCanonicalCoordinatorCorrelationCookie,
  readBrowserProofCookie,
  type BrowserCookieSourceProof,
} from '../app/lib/auth/browser-proof-cookies.server';

interface Identity {
  readonly userId: string;
  readonly authSessionId: string;
  readonly expiresAt: number;
}
interface Issued {
  readonly proof: BrowserCookieSourceProof;
  readonly identity: Identity;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
interface Scenario {
  readonly bindingId: string;
  readonly correlation: string;
  readonly older: Issued;
  readonly first: Issued;
  later: Issued;
  readonly oversized: BrowserCookieSourceProof;
  readonly overBudget: BrowserCookieSourceProof;
  readonly firstVersion: number;
  readonly laterVersion: number;
  readonly firstMaxAge: number;
  readonly laterMaxAge: number;
  readonly held: ReturnType<typeof deferred>;
  readonly release: ReturnType<typeof deferred>;
  selection: { readonly version: number; readonly issued: Issued };
  mutations: number;
  readCookieWrites: number;
  heldNames: string[];
}
const secret = 'owned-browser-cookie-codec-fixture-secret';
const password = 'Owned-browser-codec-password-123!';
const foreignBindingId = createHash('sha256').update('owned-foreign-browser-binding').digest('hex');
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let server: Server;
let browser: Browser;
let context: BrowserContext | undefined;
let certificateDirectory: string;
let www: string;
let app: string;
let scenario: Scenario | undefined;

async function canonicalIdentity(
  email = `${randomUUID()}@example.test`,
  existing = false,
): Promise<{ issued: Issued; email: string }> {
  const result = await environment.withAuthority((auth) =>
    existing
      ? auth.api.signInEmail({ body: { email, password } })
      : auth.api.signUpEmail({ body: { email, password, name: 'Owned cookie proof climber' } }),
  );
  if (!result.token) throw new Error('Owned canonical issuer returned no token');
  const [stored] = await environment.database.select().from(authSession).where(eq(authSession.token, result.token));
  if (!stored) throw new Error('Owned canonical issuer returned no persisted session');
  return {
    email,
    issued: {
      proof: { kind: 'canonical-token', rawCredential: result.token },
      identity: { userId: stored.userId, authSessionId: stored.id, expiresAt: stored.expiresAt.getTime() },
    },
  };
}
async function asJwe(issued: Issued, maxAge = 30, profilePadding = 0): Promise<Issued> {
  const rawCredential = await encode({
    secret,
    maxAge,
    token: {
      sub: issued.identity.userId,
      authSessionId: issued.identity.authSessionId,
      gen: 0,
      auth_time: 1_700_000_000,
      ...(profilePadding ? { profile: 'x'.repeat(profilePadding) } : {}),
    },
  });
  const claims = await decode({ secret, token: rawCredential });
  if (typeof claims?.exp !== 'number') throw new Error('Owned JWE issuer returned no expiry');
  return {
    proof: { kind: 'legacy-jwe', rawCredential },
    identity: { ...issued.identity, expiresAt: claims.exp * 1000 },
  };
}
async function admitted(proof: BrowserCookieSourceProof): Promise<Identity | null> {
  if (proof.kind === 'canonical-token') {
    const [stored] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.token, proof.rawCredential));
    return stored && stored.expiresAt.getTime() > Date.now()
      ? { userId: stored.userId, authSessionId: stored.id, expiresAt: stored.expiresAt.getTime() }
      : null;
  }
  const claims = await decode({ secret, token: proof.rawCredential });
  return typeof claims?.sub === 'string' &&
    typeof claims.authSessionId === 'string' &&
    typeof claims.exp === 'number' &&
    claims.exp * 1000 > Date.now()
    ? { userId: claims.sub, authSessionId: claims.authSessionId, expiresAt: claims.exp * 1000 }
    : null;
}
function candidate(current: Scenario, issued: Issued, version: number, maxAge: number, observed: string | null) {
  return buildBrowserProofCookieCandidate({
    cursor: { bindingId: current.bindingId, version },
    proof: issued.proof,
    proofMaxAgeSeconds: maxAge,
    observedCookieHeader: observed,
  });
}
async function setup(kind: BrowserCookieSourceProof['kind'], sameUser: boolean, sameVersion = false) {
  const first = await canonicalIdentity();
  const later = await canonicalIdentity(sameUser ? first.email : undefined, sameUser);
  const older = await canonicalIdentity();
  const correlation = randomBytes(32).toString('base64url');
  const original = kind === 'legacy-jwe' ? await asJwe(first.issued, sameVersion ? 12 : 30, 1450) : first.issued;
  const newer = kind === 'legacy-jwe' ? await asJwe(sameVersion ? first.issued : later.issued, 30, 1450) : later.issued;
  scenario = {
    bindingId: createHash('sha256').update(correlation).digest('hex'),
    correlation,
    older: kind === 'legacy-jwe' ? await asJwe(older.issued) : older.issued,
    first: original,
    later: newer,
    oversized: {
      kind: 'legacy-jwe',
      rawCredential: await encode({
        secret,
        maxAge: 30,
        token: {
          sub: first.issued.identity.userId,
          authSessionId: first.issued.identity.authSessionId,
          profile: 'x'.repeat(20_000),
        },
      }),
    },
    overBudget: {
      kind: 'legacy-jwe',
      rawCredential: await encode({
        secret,
        maxAge: 30,
        token: {
          sub: first.issued.identity.userId,
          authSessionId: first.issued.identity.authSessionId,
          profile: 'x'.repeat(5_200),
        },
      }),
    },
    firstVersion: 1,
    laterVersion: sameVersion ? 1 : 2,
    firstMaxAge: sameVersion ? 12 : 30,
    laterMaxAge: sameVersion ? 12 : 30,
    held: deferred(),
    release: deferred(),
    selection: { version: 1, issued: original },
    mutations: 0,
    readCookieWrites: 0,
    heldNames: [],
  };
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route('**/*', async (route) =>
    [www, app].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'),
  );
  const firstPage = await context.newPage();
  const laterPage = await context.newPage();
  await firstPage.goto(`${www}/page`);
  await laterPage.goto(`${app}/page`);
  await firstPage.evaluate(async () => {
    await fetch('/fixture/bootstrap', { credentials: 'include', keepalive: false });
  });
  await firstPage.evaluate(async () => {
    await fetch('/fixture/install-initial', { credentials: 'include', keepalive: false });
    await fetch('/fixture/install-older', { credentials: 'include', keepalive: false });
    await fetch('/fixture/install-foreign', { credentials: 'include', keepalive: false });
  });
  return { current: scenario, firstPage, laterPage };
}
async function readFromApp(page: Awaited<ReturnType<BrowserContext['newPage']>>) {
  return page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/fixture/read`, {
      credentials: 'include',
      cache: 'no-store',
      keepalive: false,
    });
    return (await response.json()) as Record<string, unknown>;
  }, www);
}

beforeAll(async () => {
  if (!process.env.AUTH_PROTOTYPE_DATABASE_URL)
    throw new Error('Explicit owned localhost AUTH_PROTOTYPE_DATABASE_URL is required');
  environment = await createEnvironment();
  certificateDirectory = await mkdtemp(join(tmpdir(), '6975-owned-proof-cookie-'));
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
      'subjectAltName=DNS:www.boardsesh.test,DNS:app.boardsesh.test',
      '-keyout',
      join(certificateDirectory, 'key.pem'),
      '-out',
      join(certificateDirectory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  server = createServer(
    {
      key: await readFile(join(certificateDirectory, 'key.pem')),
      cert: await readFile(join(certificateDirectory, 'cert.pem')),
    },
    (request, response) => {
      void (async () => {
        const current = scenario;
        const path = new URL(request.url ?? '/', `https://${request.headers.host}`).pathname;
        if (request.headers.origin === app) {
          response.setHeader('Access-Control-Allow-Origin', app);
          response.setHeader('Access-Control-Allow-Credentials', 'true');
          response.setHeader('Vary', 'Origin');
        }
        response.setHeader('Cache-Control', 'private, no-store');
        if (path === '/page') {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><body>Owned cookie codec fixture</body>');
          return;
        }
        if (!current) {
          response.writeHead(503).end();
          return;
        }
        const observed = request.headers.cookie ?? null;
        if (path === '/fixture/install-foreign') {
          const prepared = buildBrowserProofCookieCandidate({
            cursor: { bindingId: foreignBindingId, version: 0 },
            proof: current.older.proof,
            proofMaxAgeSeconds: 30,
            observedCookieHeader: observed,
          });
          response.setHeader('Set-Cookie', [...prepared.headers]);
          response.end();
          return;
        }
        if (path === '/fixture/bootstrap') {
          response.setHeader(
            'Set-Cookie',
            buildCanonicalCoordinatorCorrelationCookie({
              servingOrigin: www,
              canonicalOrigin: www,
              token: current.correlation,
              bindingId: current.bindingId,
            }),
          );
          response.end();
          return;
        }
        if (path === '/fixture/read') {
          const result = readBrowserProofCookie(observed, {
            bindingId: current.bindingId,
            version: current.selection.version,
          });
          const identity = result.status === 'present' ? await admitted(result.proof) : null;
          const selected = current.selection.issued.identity;
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify(
              identity && identity.userId === selected.userId && identity.authSessionId === selected.authSessionId
                ? { status: 'admitted', ...identity }
                : { status: 'proof-required' },
            ),
          );
          return;
        }
        const isInitial = path === '/fixture/install-initial';
        const isOlder = path === '/fixture/install-older';
        const isFirst = path === '/fixture/held-first';
        const isLater = path === '/fixture/install-later';
        if (isInitial || isOlder || isFirst || isLater) {
          const issued = isOlder ? current.older : isFirst || isInitial ? current.first : current.later;
          const version = isOlder ? 0 : isFirst || isInitial ? current.firstVersion : current.laterVersion;
          const prepared = candidate(
            current,
            issued,
            version,
            Math.min(
              isFirst || isInitial ? current.firstMaxAge : current.laterMaxAge,
              Math.max(1, Math.floor((issued.identity.expiresAt - Date.now()) / 1000)),
            ),
            observed,
          );
          // The owned fixture's only selection mutation happens AFTER complete
          // header construction. This is not a production database receipt proof.
          if (!isOlder) {
            if (!(await admitted(issued.proof))) throw new Error('Owned source expired before publication');
            current.selection = { version, issued };
            current.mutations += 1;
          }
          // The historical old0 response arrives after initialA but cannot
          // change the authoritative selection.
          if (isFirst) {
            current.heldNames = prepared.headers.map((header) => header.slice(0, header.indexOf('=')));
            current.held.resolve();
            await current.release.promise;
          }
          response.setHeader('Set-Cookie', [...prepared.headers]);
          response.end();
          return;
        }
        if (path === '/fixture/oversize-before-mutation' || path === '/fixture/budget-before-mutation') {
          const prepared = buildBrowserProofCookieCandidate({
            cursor: { bindingId: current.bindingId, version: 3 },
            proof: path === '/fixture/oversize-before-mutation' ? current.oversized : current.overBudget,
            proofMaxAgeSeconds: 30,
            observedCookieHeader: observed,
          });
          current.mutations += 1;
          response.setHeader('Set-Cookie', [...prepared.headers]);
          response.end();
          return;
        }
        response.writeHead(404).end();
      })().catch(() => {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned cookie fixture did not bind');
  www = `https://www.boardsesh.test:${address.port}`;
  app = `https://app.boardsesh.test:${address.port}`;
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
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await environment?.close();
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

describe('actual HTTPS canonical-www versioned proof publication', () => {
  for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
    it.each([false, true])(`${kind} held A + late old-name GC preserves later B (same user=%s)`, async (sameUser) => {
      const { current, firstPage, laterPage } = await setup(kind, sameUser);
      await firstPage.evaluate(() => {
        Object.assign(globalThis, {
          heldProofRequest: fetch('/fixture/held-first', { credentials: 'include', keepalive: false }).then(
            (response) => response.status,
          ),
        });
      });
      await current.held.promise;
      await laterPage.evaluate(async (origin) => {
        await fetch(`${origin}/fixture/install-later`, { credentials: 'include', keepalive: false });
      }, www);
      expect(await readFromApp(laterPage)).toMatchObject({
        status: 'admitted',
        userId: current.later.identity.userId,
        authSessionId: current.later.identity.authSessionId,
      });
      current.release.resolve();
      await firstPage.evaluate(async () => {
        await (globalThis as typeof globalThis & { heldProofRequest: Promise<unknown> }).heldProofRequest;
      });
      expect(await readFromApp(laterPage)).toMatchObject({
        status: 'admitted',
        userId: current.later.identity.userId,
        authSessionId: current.later.identity.authSessionId,
      });
      const cookies = await context!.cookies(www);
      const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      expect(readBrowserProofCookie(header, { bindingId: current.bindingId, version: 2 })).toEqual({
        status: 'present',
        proof: current.later.proof,
      });
      expect(cookies.find((cookie) => cookie.name === BROWSER_CORRELATION_COOKIE)?.value).toBe(current.correlation);
      const laterName = browserProofCookieName({ bindingId: current.bindingId, version: 2 });
      expect(current.heldNames.every((name) => name !== laterName && !name.startsWith(`${laterName}.`))).toBe(true);
      if (kind === 'legacy-jwe')
        expect(cookies.filter((cookie) => cookie.name.startsWith(`${laterName}.`))).toHaveLength(2);
      expect(current.heldNames).toContain(browserProofCookieName({ bindingId: current.bindingId, version: 0 }));
      expect(
        cookies.some((cookie) => cookie.name === browserProofCookieName({ bindingId: foreignBindingId, version: 0 })),
      ).toBe(true);
      expect((await context!.cookies(app)).filter((cookie) => cookie.name.startsWith('__Host-boardsesh.'))).toEqual([]);
      expect(await firstPage.evaluate(() => document.cookie)).not.toContain('boardsesh.browser');
    });
  }
  it('known correlation alone cannot retrieve a selected proof or identity', async () => {
    const { current, firstPage, laterPage } = await setup('canonical-token', false);
    await context!.clearCookies();
    await firstPage.evaluate(async () => {
      await fetch('/fixture/bootstrap', { credentials: 'include', keepalive: false });
    });
    current.selection = { version: 2, issued: current.later };
    const readResponse = laterPage.waitForResponse((response) => new URL(response.url()).pathname === '/fixture/read');
    expect(await readFromApp(laterPage)).toEqual({ status: 'proof-required' });
    expect((await (await readResponse).allHeaders())['set-cookie']).toBeUndefined();
    expect((await context!.cookies(www)).map((cookie) => cookie.name)).toEqual([BROWSER_CORRELATION_COOKIE]);
  });
  it.each(['oversize', 'budget'])(
    'rejects an actual signed %s candidate before the owned selection mutation counter changes',
    async (failure) => {
      const { current, laterPage } = await setup('legacy-jwe', false);
      const mutations = current.mutations;
      const status = await laterPage.evaluate(
        async ({ origin, failure }) =>
          (await fetch(`${origin}/fixture/${failure}-before-mutation`, { credentials: 'include', keepalive: false }))
            .status,
        { origin: www, failure },
      );
      expect(status).toBe(503);
      expect(current.mutations).toBe(mutations);
      expect(current.selection.version).toBe(1);
    },
  );
  it('characterizes unresolved same-version renewal expiry regression; codec does not claim to fix it', async () => {
    const { current, firstPage, laterPage } = await setup('legacy-jwe', true, true);
    await firstPage.evaluate(() => {
      Object.assign(globalThis, {
        heldProofRequest: fetch('/fixture/held-first', { credentials: 'include', keepalive: false }).then(
          (response) => response.status,
        ),
      });
    });
    await current.held.promise;
    // Same age/SID/generation and issuer lifetime, issued later. At the old
    // signed deadline the new proof is still valid, so regression is visible.
    await laterPage.waitForTimeout(4_000);
    current.later = await asJwe(current.first, 12, 1450);
    expect(current.later.identity.expiresAt).toBeGreaterThan(current.first.identity.expiresAt);
    await laterPage.evaluate(async (origin) => {
      await fetch(`${origin}/fixture/install-later`, { credentials: 'include', keepalive: false });
    }, www);
    expect(await readFromApp(laterPage)).toMatchObject({
      status: 'admitted',
      authSessionId: current.first.identity.authSessionId,
    });
    current.release.resolve();
    await firstPage.evaluate(async () => {
      await (globalThis as typeof globalThis & { heldProofRequest: Promise<unknown> }).heldProofRequest;
    });
    const cookies = await context!.cookies(www);
    const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    expect(readBrowserProofCookie(header, { bindingId: current.bindingId, version: 1 })).toEqual({
      status: 'present',
      proof: current.first.proof,
    });
    await laterPage.waitForTimeout(Math.max(0, current.first.identity.expiresAt - Date.now() + 150));
    expect(current.later.identity.expiresAt).toBeGreaterThan(Date.now());
    expect(await readFromApp(laterPage)).toEqual({ status: 'proof-required' });
  });
});
