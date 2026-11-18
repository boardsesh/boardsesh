// @vitest-environment node
/**
 * #7596 B3b: `/api/internal/ws-auth` hands browser JavaScript the backend's
 * 15-minute access token under `AUTH_BROWSER_SESSION_MODE=better-auth`, through
 * the real route exports, the real backend web-session handlers over HTTP, the
 * real backend GraphQL endpoint (Yoga, in process) and real PostgreSQL.
 * Nothing scripts a backend reply. With the mode unset or `legacy` the route
 * answers exactly as on main (the snapshot below was written from main's route).
 * The www cutover list is replaced through its test seam, never from the env.
 */
import { randomUUID } from 'node:crypto';
import { encode, type JWT } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, normalizedResponse, patchNextRequestIo, setCookies } from './route-harness';
import {
  BRIDGED,
  COOKIE_SECRET,
  DOMAIN,
  LEGACY,
  LOGIN,
  browserSteps,
  createClimber,
  randomClientAddress,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'ws-auth-access-token-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({ getDb: () => holder.database }));
vi.mock('../../backend/src/db/client', () => ({
  get db() {
    return holder.database;
  },
}));
vi.mock('../../backend/src/auth/admission-pool', () => ({
  readOnAdmissionConnection: async (mark: () => void, read: (database: unknown) => PromiseLike<unknown>) => {
    mark();
    return read(holder.database);
  },
}));
// The legacy cookie's admission, answered by the backend's own reader.
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));
// The test seam: the preconditions alone, as once the www cutover list is empty.
vi.mock('../app/lib/auth/browser-session-mode.server', async (original) => {
  const actual = await original<typeof import('../app/lib/auth/browser-session-mode.server')>();
  return { ...actual, browserSessionRouteMode: actual.browserSessionRouteModeResolver([]) };
});

import * as authRoute from '../app/api/auth/[...nextauth]/route';
import { GET as wsAuthRoute } from '../app/api/internal/ws-auth/route';

const secret = 'ws-auth-access-token-proof-nextauth-secret-7596';
const ACCESS_SECRET = 'ws-auth-access-token-proof-access-secret-7596-b3b';
const { login, readSession, signOut } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let graphqlFetch: (request: Request) => Promise<Response>;

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  patchNextRequestIo();
  const { createYogaInstance } = await import('../../backend/src/graphql/yoga');
  const yoga = createYogaInstance();
  graphqlFetch = async (request) => yoga.fetch(request);
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  await environment?.close();
});

function betterAuth(): void {
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', ACCESS_SECRET);
}

type WsAuthBody = {
  token: string | null;
  authenticated?: boolean;
  userId?: string;
  authSessionId?: string;
  expiresAt?: string;
};
type SessionJson = { user?: { id: string }; authSessionId?: string };

async function wsAuth(cookie: string, clientAddress = randomClientAddress()): Promise<Response> {
  return wsAuthRoute(
    new NextRequest(new URL('/api/internal/ws-auth', ORIGIN), {
      headers: { cookie, 'x-forwarded-for': clientAddress },
    }),
  );
}

/** The backend's own GraphQL endpoint, asked who the bearer is. */
async function graphqlViewer(bearer: string) {
  const response = await graphqlFetch(
    new Request('http://backend.invalid/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query: '{ authenticatedUserId }' }),
    }),
  );
  return { status: response.status, body: (await response.json()) as { data?: { authenticatedUserId?: string } } };
}

/** Status, body and every `Set-Cookie`, with a string token replaced. */
async function normalizedWsAuth(response: Response) {
  const normalized = await normalizedResponse(response);
  const body = normalized.body as Record<string, unknown>;
  return { ...normalized, body: typeof body.token === 'string' ? { ...body, token: '<token>' } : body };
}

/** A NextAuth cookie from before the switch: a login with its own session id. */
async function legacyLogin(claims: Partial<JWT> = {}) {
  const climber = await createClimber(environment.database);
  const authSessionId = randomUUID();
  const credential = await encode({
    token: { sub: climber.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000), ...claims },
    secret,
    maxAge: 3600,
  });
  return { climber, authSessionId, credential };
}

describe('ws-auth with the mode unset or legacy', () => {
  it.each([undefined, '', 'legacy'])('answers as on main (mode %j)', async (mode) => {
    if (mode !== undefined) vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const signedIn = await wsAuth(jar.header());
    const body = (await signedIn.clone().json()) as WsAuthBody;
    // The raw NextAuth JWE, as on main.
    expect(body.token).toBe(jar.get(LEGACY, DOMAIN));
    expect(await normalizedWsAuth(signedIn)).toMatchInlineSnapshot(`
      {
        "body": {
          "authSessionId": "<uuid>",
          "authenticated": true,
          "token": "<token>",
          "userId": "<uuid>",
        },
        "cacheControl": "private, no-store",
        "location": null,
        "setCookies": [],
        "status": 200,
      }
    `);
    expect(await normalizedWsAuth(await wsAuth(''))).toMatchInlineSnapshot(`
      {
        "body": {
          "authenticated": false,
          "token": null,
        },
        "cacheControl": "private, no-store",
        "location": null,
        "setCookies": [],
        "status": 200,
      }
    `);
  });
});
