/**
 * Shared setup for the `better-auth` proofs (#7596): the real backend
 * password and web-session handlers over HTTP, the environment both sides
 * read, climbers in PostgreSQL, and the browser steps against the real route.
 * Each proof file declares its own `vi.mock` calls and passes its route in.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { hash } from 'bcryptjs';
import { expect, vi } from 'vite-plus/test';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import type { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../backend/src/auth/current-store/foundation-context';
import { createPasswordCompareGate } from '../../backend/src/auth/current-store/password-compare-gate';
import { createPasswordLoginLimiter } from '../../backend/src/auth/current-store/password-login-limits';
import { handleCurrentStoreWebAuth } from '../../backend/src/handlers/current-store-web-auth';
import { handleCurrentStoreWebSession } from '../../backend/src/handlers/current-store-web-session';
import { handleCurrentStoreWebOAuth } from '../../backend/src/handlers/current-store-web-oauth';
import { handleProviderSecurity } from '../../backend/src/handlers/provider-security';
import { handleFirstPassword } from '../../backend/src/handlers/first-password';
import { viewerMarkerValue } from '@boardsesh/auth-protocol/browser-session-cookie';
import { CookieJar, callRoute, setCookieNames, setCookies, type AuthRoute } from './route-harness';

type Database = Awaited<ReturnType<typeof createEnvironment>>['database'];

export const COOKIE_SECRET = 'web-session-proof-browser-cookie-secret-7596-b1c';
export const PASSWORD = 'web session proof password';
export const LOGIN = '__Secure-boardsesh.session_token';
export const BRIDGED = '__Secure-boardsesh.bridged_session_token';
export const LEGACY = '__Secure-next-auth.session-token';
/** The viewer marker (#7596): readable, written and cleared only beside a session cookie. */
export const MARKER = '__Secure-boardsesh.viewer';
export const SESSION_COOKIE_NAMES = [LOGIN, BRIDGED, LEGACY, 'next-auth.session-token', MARKER];
export const DOMAIN = '.boardsesh.com';

const rpcSecret = randomBytes(32).toString('base64url');
const projectionId = `web-session-proof-${randomUUID()}`;
/** The enforced projection the harness backend runs under, for proofs that issue a session directly. */
export const PROJECTION_ID = projectionId;
/** The same projection, under the name the provider-security fixtures import. */
export const PROOF_PROJECTION_ID = projectionId;
const sockets = new Set<Socket>();

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned command server failed to bind');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export type WebSessionBackend = { origin: string; refusingOrigin: string; close: () => Promise<void> };

/**
 * The real handlers, plus the real web-session handler reached with a browser
 * `Origin`, which answers its own transport 401 `{ error: 'unauthorized' }`.
 */
export async function startWebSessionBackend(database: Database): Promise<WebSessionBackend> {
  await database.insert(authEmailProjection).values({
    projectionId,
    normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    writerEpoch: 1,
    phase: 'enforced',
    preparedAt: new Date(),
  });
  const guards = { limits: createPasswordLoginLimiter({ redis: () => null }), gate: createPasswordCompareGate() };
  const real = await listen((request, response) =>
    request.url?.startsWith('/api/internal/auth/current-store/web-session/v1/')
      ? handleCurrentStoreWebSession(request, response, database)
      : request.url?.startsWith('/api/internal/auth/current-store/web-oauth/v1/')
        ? handleCurrentStoreWebOAuth(request, response, database)
        : request.url?.startsWith('/api/internal/auth/current-store/provider-security/v1/')
          ? handleProviderSecurity(request, response, database)
          : request.url?.startsWith('/api/internal/auth/current-store/first-password/v1/')
            ? handleFirstPassword(request, response, database)
            : handleCurrentStoreWebAuth(request, response, database, guards),
  );
  const refusing = await listen((request, response) => {
    request.headers.origin = 'https://www.boardsesh.com';
    return handleCurrentStoreWebSession(request, response, database);
  });
  return {
    origin: real.origin,
    refusingOrigin: refusing.origin,
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const server of [real.server, refusing.server])
        await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Both sides' variables for `better-auth`, on www and on the backend in this one process. */
export function stubBetterAuthEnvironment(backendOrigin: string): void {
  for (const [name, content] of Object.entries({
    AUTH_BROWSER_SESSION_MODE: 'better-auth',
    AUTH_BROWSER_SESSION_COOKIE_SECRET: COOKIE_SECRET,
    AUTH_BRIDGE_TOKEN_SECRET: 'web-session-proof-bridge-token-secret-7596-b2b',
    AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: backendOrigin,
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
    CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'web-session-proof-retired-mailbox-key',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    EMAIL_VERIFICATION_ENABLED: 'false',
    DEBUG_SQL: 'false',
    PARTNER_OAUTH_MODE: 'off',
  }))
    vi.stubEnv(name, content);
}

export async function createClimber(database: Database, { verified = true } = {}) {
  const id = randomUUID();
  const email = `web-session-proof-${id}@example.test`;
  await database.insert(users).values({ id, email, name: 'Climber', emailVerified: verified ? new Date() : null });
  await database.insert(userCredentials).values({ userId: id, passwordHash: await hash(PASSWORD, 4) });
  return { id, email };
}

/** The backend's reservation of a climber's address, as an account created by the authority has one. */
export async function reserveClimberEmail(database: Database, climber: { id: string; email: string }) {
  const normalizedEmail = climber.email.toLowerCase();
  await database
    .insert(authEmailReservations)
    .values({ normalizedEmail, basisProjectionId: projectionId, state: 'owned', ownerUserId: climber.id });
  await database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: climber.id });
}

export function sessionCookieNamesIn(response: Response): string[] {
  return setCookieNames(response).filter((name) => SESSION_COOKIE_NAMES.includes(name));
}

/** A documentation-range IPv6 address in its own /64, so each caller gets its own limit bucket. */
export function randomClientAddress(): string {
  const group = () => randomBytes(2).toString('hex');
  return `2001:db8:${group()}:${group()}::1`;
}

/** A browser's steps against the real route. */
export function browserSteps(route: AuthRoute) {
  async function csrf(jar: CookieJar): Promise<string> {
    const response = await callRoute(route, '/api/auth/csrf', { cookie: jar.header() });
    expect(sessionCookieNamesIn(response)).toEqual([]);
    jar.apply(response);
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  }
  async function login(jar: CookieJar, email: string, password = PASSWORD, cookie?: string) {
    const csrfToken = await csrf(jar);
    const response = await callRoute(route, '/api/auth/callback/credentials', {
      cookie: cookie === undefined ? jar.header() : `${cookie}; ${jar.header()}`,
      form: { csrfToken, email, password, json: 'true', callbackUrl: 'https://www.boardsesh.com/' },
    });
    jar.apply(response);
    return response;
  }
  /**
   * Session GET or POST, from its own client address unless one is given (the
   * bridge limit keys on it). Asserts no session cookie is written or cleared,
   * apart from the bridged cookie when `bridges` is set; `writes` leaves the
   * `Set-Cookie` list to the caller (a bridge that clears cookies).
   */
  async function readSession(
    cookie: string,
    method: 'GET' | 'POST' = 'GET',
    csrfToken = '',
    {
      bridges = false,
      writes = false,
      clientAddress = randomClientAddress(),
    }: { bridges?: boolean; writes?: boolean; clientAddress?: string } = {},
  ) {
    const response = await callRoute(route, '/api/auth/session', {
      cookie,
      headers: { 'x-forwarded-for': clientAddress },
      ...(method === 'POST' ? { form: { csrfToken } } : {}),
    });
    const allowed = bridges ? [BRIDGED, MARKER] : [];
    if (!writes) expect(sessionCookieNamesIn(response).filter((name) => !allowed.includes(name))).toEqual([]);
    return response;
  }
  async function signOut(
    jar: CookieJar,
    expected: { userId: string; authSessionId: string },
    options: { csrfToken?: string; cookie?: string } = {},
  ) {
    const csrfToken = options.csrfToken ?? (await csrf(jar));
    return callRoute(route, '/api/auth/signout', {
      cookie: options.cookie === undefined ? jar.header() : `${options.cookie}; ${jar.header()}`,
      form: {
        csrfToken,
        callbackUrl: 'https://www.boardsesh.com/',
        json: 'true',
        expectedUserId: expected.userId,
        expectedAuthSessionId: expected.authSessionId,
      },
    });
  }
  return { csrf, login, readSession, signOut };
}

/**
 * The response writes the viewer marker for `authSessionId` exactly once,
 * after the session cookie it rides with, in the production shape: Domain,
 * the session cookie's Max-Age, SameSite=Lax, Secure, and never HttpOnly.
 * (A provider callback appends NextAuth's own nonce clear after both.)
 */
export function expectViewerMarkerFor(response: Response, authSessionId: string): void {
  const headers = setCookies(response);
  const writes = headers.filter((header) => header.startsWith(`${MARKER}=`) && !header.startsWith(`${MARKER}=;`));
  expect(writes).toEqual([
    `${MARKER}=${viewerMarkerValue(authSessionId)}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; SameSite=Lax; Secure`,
  ]);
  const isSessionWrite = (header: string) =>
    [LOGIN, BRIDGED].some((name) => header.startsWith(`${name}=`) && !header.startsWith(`${name}=;`));
  const sessionWrite = headers.map(isSessionWrite).lastIndexOf(true);
  expect(sessionWrite).toBeGreaterThanOrEqual(0);
  expect(headers.indexOf(writes[0] ?? '')).toBeGreaterThan(sessionWrite);
}

/** The raw session token inside the Domain-scoped login cookie the jar holds. */
export function loginToken(jar: CookieJar): string {
  const signed = jar.get(LOGIN, DOMAIN);
  if (!signed) throw new Error('No login cookie');
  return signed.slice(0, signed.indexOf('.'));
}

export async function canonicalStatus(database: Database, token: string) {
  return (await readFirstPartySession(database, { kind: 'canonical-token', token })).status;
}

export async function legacyStatus(database: Database, credential: string, secret: string) {
  return (await readFirstPartySession(database, { kind: 'legacy-jwe', credential, secret })).status;
}
