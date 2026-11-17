/**
 * The private web-session commands over real HTTP and PostgreSQL: login as an
 * extension of the staged password command, guarded sign-out, and roll. The
 * web asks for a session but never names its account; the backend issues it
 * only for the account the password proves.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { hash } from 'bcryptjs';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  WEB_SESSION_COMMAND_PATHS,
  WEB_SESSION_LIFETIME_SECONDS,
  WEB_SESSION_PROTOCOL_VERSION,
  passwordReplySchema,
  webSessionRollReplySchema,
  webSessionSignOutReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import { authEmailProjection, authSession, userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { readFirstPartySession } from '../session-reader';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { createPasswordCompareGate } from '../../current-store/password-compare-gate';
import { createPasswordLoginLimiter, type PasswordLoginLimiter } from '../../current-store/password-login-limits';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleCurrentStoreWebSession } from '../../../handlers/current-store-web-session';

const PASSWORD = 'web session command password';
const rpcSecret = randomBytes(32).toString('base64url');
const nextAuthSecret = 'synthetic-web-session-command-nextauth-secret';
const projectionId = 'web-session-command-projection';
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let origin: string;
let server: Server;
const sockets = new Set<Socket>();
let passwordHash: string;
const admitted = vi.fn<PasswordLoginLimiter['admit']>();
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));

beforeAll(async () => {
  environment = await createEnvironment();
  passwordHash = await hash(PASSWORD, 4);
  await environment.database.insert(authEmailProjection).values({
    projectionId,
    normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    writerEpoch: 1,
    phase: 'enforced',
    preparedAt: new Date(),
  });
  const limiter = createPasswordLoginLimiter({ redis: () => null });
  const guards = {
    limits: { admit: admitted.mockImplementation((attempt) => limiter.admit(attempt)) },
    gate: createPasswordCompareGate(),
  };
  server = createServer((request, response) => {
    const handled = request.url?.startsWith('/api/internal/auth/current-store/web-session/v1/')
      ? handleCurrentStoreWebSession(request, response, environment.database)
      : handleCurrentStoreWebAuth(request, response, environment.database, guards);
    void handled.catch(() => {
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
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  vi.unstubAllEnvs();
  admitted.mockClear();
  for (const [name, content] of Object.entries({
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'synthetic-web-session-command-retired-mailbox-key',
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    EMAIL_VERIFICATION_ENABLED: 'false',
    NEXTAUTH_SECRET: nextAuthSecret,
    DEBUG_SQL: 'false',
  }))
    vi.stubEnv(name, content);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await environment?.close();
});

async function climber(emailVerified: Date | null = new Date()) {
  const id = randomUUID();
  const email = `web-session-command-${id}@example.test`;
  await environment.database.insert(users).values({ id, email, emailVerified });
  await environment.database.insert(userCredentials).values({ userId: id, passwordHash });
  return { id, email };
}

async function post(path: string, body: unknown, authorization = `Bearer ${rpcSecret}`) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function loginCommand(email: string, webSession?: unknown, password = PASSWORD) {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    ...(webSession === undefined ? {} : { webSession }),
    payload: { email, password },
  };
}

async function login(email: string, presented?: PresentedWebSession) {
  const { status, body } = await post(AUTH_COMMAND_PATHS.password, loginCommand(email, { presented }));
  expect(status).toBe(200);
  const reply = passwordReplySchema.parse(body);
  if (reply.outcome !== 'authenticated' || !reply.webSession) throw new Error('No web session issued');
  return reply;
}

function command(operation: 'signout' | 'roll', payload: Record<string, unknown>) {
  return {
    webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  };
}

async function sessionStatus(token: string) {
  return (await readFirstPartySession(environment.database, { kind: 'canonical-token', token })).status;
}

async function legacyCookie(userId: string, authSessionId: string) {
  const key = await hkdf(
    'sha256',
    new TextEncoder().encode(nextAuthSecret),
    '',
    'NextAuth.js Generated Encryption Key',
    32,
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  return new EncryptJWT({ authSessionId })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .encrypt(key);
}

describe('login through the staged password command', () => {
  it('issues a session only for the proved account and revokes the presented one', async () => {
    const [first, second] = [await climber(), await climber()];
    const firstLogin = await login(first.email);
    const firstSession = firstLogin.webSession!;
    expect(firstLogin.user.id).toBe(first.id);
    expect(Date.parse(firstSession.expiresAt) - Date.now()).toBeGreaterThan((WEB_SESSION_LIFETIME_SECONDS - 60) * 1000);
    expect(await sessionStatus(firstSession.token)).toBe('admitted');

    // The second climber signs in on the browser holding the first one's session.
    const secondLogin = await login(second.email, { kind: 'canonical-token', token: firstSession.token });
    expect(secondLogin.user.id).toBe(second.id);
    expect(await sessionStatus(firstSession.token)).toBe('denied');
    const secondSession = await readFirstPartySession(environment.database, {
      kind: 'canonical-token',
      token: secondLogin.webSession!.token,
    });
    expect(secondSession.status === 'admitted' && secondSession.session.userId).toBe(second.id);

    // A wrong password revokes nothing and issues nothing.
    const wrong = await post(
      AUTH_COMMAND_PATHS.password,
      loginCommand(second.email, { presented: { kind: 'canonical-token', token: secondLogin.webSession!.token } }, 'x'),
    );
    expect(wrong.body).toMatchObject({ outcome: 'invalid_credentials' });
    expect(wrong.body).not.toHaveProperty('webSession');
    expect(await sessionStatus(secondLogin.webSession!.token)).toBe('admitted');
  });

  it('revokes a presented legacy cookie through its SID', async () => {
    const [owner, signingIn] = [await climber(), await climber()];
    const cookie = await legacyCookie(owner.id, randomUUID());
    const legacy = { kind: 'legacy-jwe' as const, credential: cookie, secret: nextAuthSecret };
    expect((await readFirstPartySession(environment.database, legacy)).status).toBe('admitted');
    await login(signingIn.email, { kind: 'legacy-jwe', credential: cookie });
    expect((await readFirstPartySession(environment.database, legacy)).status).toBe('denied');
  });

  it('never lets the web name the account', async () => {
    const { id, email } = await climber();
    for (const webSession of [{ userId: id }, { presented: { kind: 'canonical-token', token: 'x', userId: id } }]) {
      const { status, body } = await post(AUTH_COMMAND_PATHS.password, loginCommand(email, webSession));
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'invalid_request' });
    }
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, id))).toEqual([]);
  });

  it('issues no session for an unverified climber when verification is required, and keeps the presented one', async () => {
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
    const [verified, unverified] = [await climber(), await climber(null)];
    const presented = (await login(verified.email)).webSession!;
    const { status, body } = await post(
      AUTH_COMMAND_PATHS.password,
      loginCommand(unverified.email, { presented: { kind: 'canonical-token', token: presented.token } }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ outcome: 'authenticated', verification: { required: true, verified: false } });
    expect(body).not.toHaveProperty('webSession');
    expect(await sessionStatus(presented.token)).toBe('admitted');
  });
});

describe('sign-out and roll', () => {
  it('signs out only the session the tab expected', async () => {
    const { id, email } = await climber();
    const session = (await login(email)).webSession!;
    const signOut = (expectedAuthSessionId: string) =>
      post(
        WEB_SESSION_COMMAND_PATHS.signout,
        command('signout', { token: session.token, expectedUserId: id, expectedAuthSessionId }),
      );

    const changed = await signOut(randomUUID());
    expect(changed.status).toBe(409);
    expect(webSessionSignOutReplySchema.parse(changed.body).outcome).toBe('identity_changed');
    expect(await sessionStatus(session.token)).toBe('admitted');

    const ended = await signOut(session.sessionId);
    expect(ended.status).toBe(200);
    expect(webSessionSignOutReplySchema.parse(ended.body).outcome).toBe('signed_out');
    expect(await sessionStatus(session.token)).toBe('denied');
    // Repeating it is harmless: nothing live is left.
    expect((await signOut(session.sessionId)).status).toBe(200);
  });

  it('rolls a live session when it is due and refuses a dead one', async () => {
    const { id, email } = await climber();
    const session = (await login(email)).webSession!;
    const roll = () => post(WEB_SESSION_COMMAND_PATHS.roll, command('roll', { token: session.token }));

    const fresh = webSessionRollReplySchema.parse((await roll()).body);
    expect(fresh).toMatchObject({ outcome: 'active', userId: id, authSessionId: session.sessionId, rolled: false });

    const tenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await environment.database
      .update(authSession)
      .set({ expiresAt: tenDays })
      .where(eq(authSession.id, session.sessionId));
    const due = webSessionRollReplySchema.parse((await roll()).body);
    expect(due).toMatchObject({ outcome: 'active', rolled: true });
    if (due.outcome === 'active') expect(Date.parse(due.expiresAt)).toBeGreaterThan(tenDays.getTime());

    await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', { token: session.token, expectedUserId: id, expectedAuthSessionId: session.sessionId }),
    );
    const dead = await roll();
    expect(dead.status).toBe(401);
    expect(webSessionRollReplySchema.parse(dead.body).outcome).toBe('unauthenticated');
  });
});

describe('private transport', () => {
  it('answers 404 for every web-session command while the mode is off, before any work', async () => {
    const { email } = await climber();
    for (const mode of [undefined, '', 'legacy']) {
      vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', mode);
      for (const [path, body] of [
        [
          WEB_SESSION_COMMAND_PATHS.signout,
          command('signout', { token: 't', expectedUserId: 'u', expectedAuthSessionId: 's' }),
        ],
        [WEB_SESSION_COMMAND_PATHS.roll, command('roll', { token: 't' })],
        [AUTH_COMMAND_PATHS.password, loginCommand(email, {})],
      ] as const) {
        const response = await post(path, body);
        expect(response).toEqual({ status: 404, body: { error: 'disabled' } });
      }
    }
    expect(admitted).not.toHaveBeenCalled();
    // A plain sign-in is unchanged.
    expect((await post(AUTH_COMMAND_PATHS.password, loginCommand(email))).body).toMatchObject({
      outcome: 'authenticated',
    });
  });

  it('refuses a wrong or missing secret, a browser origin and an unknown mode', async () => {
    const { email } = await climber();
    const roll = command('roll', { token: 't' });
    for (const authorization of ['Bearer wrong-secret-of-the-wrong-length', `Bearer ${rpcSecret}x`, '']) {
      expect(await post(WEB_SESSION_COMMAND_PATHS.roll, roll, authorization)).toEqual({
        status: 401,
        body: { error: 'unauthorized' },
      });
      expect((await post(AUTH_COMMAND_PATHS.password, loginCommand(email, {}), authorization)).status).toBe(401);
    }
    const fromBrowser = await fetch(`${origin}${WEB_SESSION_COMMAND_PATHS.roll}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rpcSecret}`,
        'content-type': 'application/json',
        origin: 'https://www.boardsesh.com',
      },
      body: JSON.stringify(roll),
    });
    expect(fromBrowser.status).toBe(401);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'on');
    expect((await post(WEB_SESSION_COMMAND_PATHS.roll, roll)).status).toBe(503);
    expect((await post(AUTH_COMMAND_PATHS.password, loginCommand(email, {}))).status).toBe(503);
    expect(admitted).not.toHaveBeenCalled();
  });
});
