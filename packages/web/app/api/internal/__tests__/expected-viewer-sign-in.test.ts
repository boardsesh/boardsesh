// @vitest-environment node
/**
 * The browser and the server must build the same viewer key, or every guarded
 * press answers 409. Both ends run here for real: the NextAuth `jwt` and
 * `session` callbacks from auth-options, NextAuth's own `/api/auth/session`
 * handler (what the www session provider reads), getAdmittedServerSession, the
 * www session guard and the four route handlers. Faked: the database (one
 * climber's rows in memory), the backend's credential admission (it decodes
 * the cookie) and Next's request I/O.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import NextAuth from 'next-auth';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const fixture = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  // auth-options reads both when it loads.
  vi.stubEnv('NEXTAUTH_SECRET', 'expected-viewer-sign-in-fixture-secret');
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
  return {
    tables: new Map<unknown, Record<string, unknown>[]>(),
    // The request each route or NextAuth call is serving, for Next's request I/O.
    requests: new AsyncLocalStorage<import('next/server').NextRequest>(),
  };
});

type Row = Record<string, unknown>;
function rowsOf(table: unknown): Row[] {
  let rows = fixture.tables.get(table);
  if (!rows) {
    rows = [];
    fixture.tables.set(table, rows);
  }
  return rows;
}

vi.mock('server-only', () => ({}));
// Our modules import Next's request I/O; NextAuth requires it (patched below).
vi.mock('next/headers', async (original) => ({
  ...(await original<typeof import('next/headers')>()),
  cookies: async () => ({ getAll: () => fixture.requests.getStore()?.cookies.getAll() ?? [] }),
  headers: async () => fixture.requests.getStore()?.headers ?? new Headers(),
}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
// One climber, so a query's conditions never pick between rows.
vi.mock('@/app/lib/db/db', () => {
  const read = (table: unknown) => rowsOf(table).map((row) => ({ ...row }));
  const database = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Object.assign(Promise.resolve(read(table)), { limit: async () => read(table) }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...values };
        rowsOf(table).push(row);
        return Object.assign(Promise.resolve(), { returning: async () => [row] });
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        rowsOf(table).length = 0;
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    transaction: async (work: (transaction: unknown) => Promise<unknown>) => work(database),
  };
  return { getDb: () => database };
});
vi.mock('@/app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/credential-admission.server')>()),
  // The backend admits a cookie it can decode; this is that answer.
  admitPresentedWebCredential: async (credential: string) => {
    const token = await decode({ token: credential, secret: process.env.NEXTAUTH_SECRET ?? '' });
    return typeof token?.sub === 'string' ? token.sub : null;
  },
}));

import { authOptions } from '@/app/lib/auth/auth-options';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { admittedViewerKey } from '@/app/lib/auth/expected-viewer.server';
import { users } from '@/app/lib/db/schema';
import { webLogger } from '@/app/lib/observability/logger';
import {
  createSessionGuard,
  isSessionSuperseded,
  readProbedViewer,
  sessionViewerKey,
  sessionViewerOf,
  type SessionGuard,
} from '@/app/lib/auth/session-guard';
import * as controllersRoute from '../controllers/route';
import * as profileRoute from '../profile/route';
import * as setPasswordRoute from '../set-password/route';
import * as wsAuthRoute from '../ws-auth/route';

const ORIGIN = 'http://localhost:3000';
const COOKIE_NAME = 'next-auth.session-token';
const climber = { id: 'climber-a', email: 'climber@example.test', name: 'Climber' };

// NextAuth's own require of Next's request I/O, patched as the NextAuth route tests do.
const requestStorage = fixture.requests;
const nextIo = createRequire(import.meta.url)('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};
/** The browser's cookie jar: one shared session cookie. */
let sessionCookie = '';

function browserRequest(path: string, init: RequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set('cookie', `${COOKIE_NAME}=${sessionCookie}`);
  return new NextRequest(new URL(path, ORIGIN), { ...init, headers } as ConstructorParameters<typeof NextRequest>[1]);
}

/**
 * The cookies a browser holds when this ships. `current`: a login made through
 * today's jwt callback, which names its auth session. `legacy`: a login from
 * before that claim, with only NextAuth's own `jti`; the jwt callback derives
 * the auth session from it on every read (auth-options.ts, `legacy_no_sid`).
 */
type CookieShape = 'current' | 'legacy';

async function signIn(shape: CookieShape = 'current'): Promise<void> {
  if (shape === 'legacy') {
    sessionCookie = await encode({
      token: { name: climber.name, email: climber.email, picture: null, sub: climber.id },
      secret: process.env.NEXTAUTH_SECRET ?? '',
      maxAge: 3600,
    });
    return;
  }
  const jwt = authOptions.callbacks?.jwt;
  if (!jwt) throw new Error('auth-options has no jwt callback');
  const token = await jwt({
    token: { name: climber.name, email: climber.email, picture: null, sub: climber.id },
    user: { id: climber.id, email: climber.email, name: climber.name },
    account: { provider: 'credentials', type: 'credentials', providerAccountId: climber.id },
    trigger: 'signIn',
    isNewUser: false,
  });
  sessionCookie = await encode({ token, secret: process.env.NEXTAUTH_SECRET ?? '', maxAge: 3600 });
}

/**
 * What the www session provider reads and hands to the guard. NextAuth rewrites
 * the cookie on this read; a browser keeps the new one unless it is lost.
 */
async function readClientSession(keepRewrittenCookie = true) {
  const request = browserRequest('/api/auth/session');
  const handler = NextAuth(authOptions);
  const response: Response = await requestStorage.run(request, () =>
    handler(request, { params: Promise.resolve({ nextauth: ['session'] }) }),
  );
  expect(response.status).toBe(200);
  const rewritten = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .find((pair) => pair.startsWith(`${COOKIE_NAME}=`));
  if (keepRewrittenCookie && rewritten) sessionCookie = rewritten.slice(COOKIE_NAME.length + 1);
  return response.json();
}

/** The three keys that must agree: the guard's, the focus probe's (ws-auth) and the routes'. */
async function viewerKeys() {
  const probeRequest = browserRequest('/api/internal/ws-auth');
  const probe = await requestStorage.run(probeRequest, async () => (await wsAuthRoute.GET(probeRequest)).json());
  const probed = readProbedViewer(probe);
  const routeRequest = browserRequest('/api/internal/controllers');
  const server = await requestStorage.run(routeRequest, () => getAdmittedServerSession());
  return {
    guard: guard.viewerKey(),
    probe: probed === undefined ? 'unproven' : sessionViewerKey(probed),
    routes: admittedViewerKey(server),
  };
}

const send: typeof fetch = async (input, init) => {
  const request = browserRequest(input instanceof Request ? input.url : String(input), init);
  const { pathname } = request.nextUrl;
  return requestStorage.run(request, async () => {
    if (pathname === '/api/internal/profile') return profileRoute.GET(request);
    if (pathname === '/api/internal/set-password') return setPasswordRoute.POST(request);
    if (request.method === 'POST') return controllersRoute.POST(request);
    if (request.method === 'DELETE') return controllersRoute.DELETE(request);
    return controllersRoute.GET(request);
  });
};

let guard: SessionGuard;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requestStorage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [],
  }));
});

async function openSettings(shape: CookieShape, keepRewrittenCookie = true) {
  await signIn(shape);
  guard = createSessionGuard({ reloadPage: vi.fn(), requestSessionCheck: vi.fn(), pageOrigin: () => ORIGIN, send });
  guard.accept(sessionViewerOf(await readClientSession(keepRewrittenCookie)));
}

beforeEach(() => {
  fixture.tables.clear();
  rowsOf(users).push({ ...climber, image: null, emailVerified: new Date() });
  warn = vi.spyOn(webLogger, 'warn');
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('a signed-in www page and the cookie routes', () => {
  it.each([
    ['a current login', 'current', true],
    ['a login from before the auth-session claim', 'legacy', true],
    ['a login from before the claim whose rewritten cookie was lost', 'legacy', false],
  ] as const)(
    'agree on the viewer for %s: list, register, delete, profile and set-password all go through',
    async (_label, shape, keep) => {
      await openSettings(shape, keep);
      expect(guard.viewerKey()).toMatch(/^climber-a:[0-9a-f-]{36}$/);
      const keys = await viewerKeys();
      expect(keys).toEqual({ guard: guard.viewerKey(), probe: guard.viewerKey(), routes: guard.viewerKey() });

      const empty = await guard.fetch('/api/internal/controllers');
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ controllers: [] });

      const registered = await guard.fetch('/api/internal/controllers', {
        method: 'POST',
        ...json({ name: 'Projector', boardName: 'spray' }),
      });
      expect(registered.status).toBe(200);
      const { controllerId, apiKey } = (await registered.json()) as { controllerId: string; apiKey: string };
      expect(apiKey).toMatch(/^[0-9a-f]{64}$/);

      const listed = (await (await guard.fetch('/api/internal/controllers')).json()) as {
        controllers: { id: string }[];
      };
      expect(listed.controllers.map((controller) => controller.id)).toEqual([controllerId]);

      const deleted = await guard.fetch('/api/internal/controllers', { method: 'DELETE', ...json({ controllerId }) });
      expect(deleted.status).toBe(200);

      const profile = await guard.fetch('/api/internal/profile');
      expect(profile.status).toBe(200);
      expect(await profile.json()).toMatchObject({ id: climber.id, hasPassword: false });

      const password = await guard.fetch('/api/internal/set-password', {
        method: 'POST',
        ...json({ password: 'fixture-password-1', confirmPassword: 'fixture-password-1' }),
      });
      expect(password.status).toBe(200);

      expect(warn).not.toHaveBeenCalledWith('expected viewer refused', expect.anything());
    },
  );

  it('still refuses once the climber signs in again elsewhere, so the agreement above is not vacuous', async () => {
    await openSettings('current');
    await signIn();

    await expect(guard.fetch('/api/internal/controllers')).rejects.toSatisfy(isSessionSuperseded);
    expect(warn).toHaveBeenCalledWith(
      'expected viewer refused',
      expect.objectContaining({ route: '/api/internal/controllers', reason: 'other_session' }),
    );
  });
});
