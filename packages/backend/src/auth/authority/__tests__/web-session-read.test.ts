/**
 * #7596 B1b over real HTTP and PostgreSQL: the session read command writes
 * nothing and answers by the reader's own rules, a legacy cookie can sign out
 * through the command, and a login's proof names the session it issued.
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
  WEB_SESSION_PROTOCOL_VERSION,
  passwordReplySchema,
  webSessionReadReplySchema,
  webSessionSignOutReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import {
  authCredentialLineage,
  authEmailProjection,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { readFirstPartySession } from '../session-reader';
import { sessionTokenDigest } from '../session-token';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { createPasswordCompareGate } from '../../current-store/password-compare-gate';
import { createPasswordLoginLimiter } from '../../current-store/password-login-limits';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleCurrentStoreWebSession } from '../../../handlers/current-store-web-session';

const PASSWORD = 'web session read password';
const rpcSecret = randomBytes(32).toString('base64url');
const nextAuthSecret = 'synthetic-web-session-read-nextauth-secret';
const projectionId = 'web-session-read-projection';
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let origin: string;
let server: Server;
const sockets = new Set<Socket>();
let passwordHash: string;
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
  const guards = { limits: createPasswordLoginLimiter({ redis: () => null }), gate: createPasswordCompareGate() };
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
  for (const [name, content] of Object.entries({
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'synthetic-web-session-read-retired-mailbox-key',
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'compatible',
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

async function climber() {
  const id = randomUUID();
  const email = `web-session-read-${id}@example.test`;
  await environment.database.insert(users).values({ id, email, name: 'Account Name', emailVerified: new Date() });
  await environment.database.insert(userCredentials).values({ userId: id, passwordHash });
  return { id, email };
}

/** Every reply this suite gets must leave the cookie to www. */
async function post(path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  return { status: response.status, body: (await response.json()) as unknown };
}

async function login(email: string, extra: Record<string, unknown> = {}) {
  const { status, body } = await post(AUTH_COMMAND_PATHS.password, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    webSession: {},
    credentialProofVersion: 1,
    payload: { email, password: PASSWORD },
    ...extra,
  });
  expect(status).toBe(200);
  const reply = passwordReplySchema.parse(body);
  if (reply.outcome !== 'authenticated' || !reply.webSession) throw new Error('No web session issued');
  return reply;
}

function command(operation: 'session' | 'signout', payload: Record<string, unknown>) {
  return {
    webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  };
}

const read = (presented: PresentedWebSession) =>
  post(WEB_SESSION_COMMAND_PATHS.session, command('session', { presented }));
const canonical = (token: string): PresentedWebSession => ({ kind: 'canonical-token', token });

async function legacyCookie(userId: string, authSessionId?: string, generation?: number) {
  const key = await hkdf(
    'sha256',
    new TextEncoder().encode(nextAuthSecret),
    '',
    'NextAuth.js Generated Encryption Key',
    32,
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  return new EncryptJWT({
    ...(authSessionId === undefined ? {} : { authSessionId }),
    ...(generation === undefined ? {} : { gen: generation }),
  })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .encrypt(key);
}

async function legacyStatus(credential: string) {
  return (await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret: nextAuthSecret }))
    .status;
}

/** Everything a read could touch for this account. */
async function rows(userId: string) {
  const select = environment.database;
  return {
    users: await select.select().from(users).where(eq(users.id, userId)),
    profiles: await select.select().from(userProfiles).where(eq(userProfiles.userId, userId)),
    sessions: await select.select().from(authSession).where(eq(authSession.userId, userId)).orderBy(authSession.id),
    denials: await select.select().from(authSessionDenials).where(eq(authSessionDenials.userId, userId)),
    lineages: await select.select().from(authCredentialLineage).where(eq(authCredentialLineage.userId, userId)),
    cutoffs: await select.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
  };
}

describe('session read', () => {
  it('answers with the session and the NextAuth user fields, and writes nothing', async () => {
    const { id, email } = await climber();
    const issued = (await login(email)).webSession!;
    // Due for a roll: a read must still not roll it.
    await environment.database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() + 2 * 86_400_000) })
      .where(eq(authSession.id, issued.sessionId));
    await environment.database
      .insert(userProfiles)
      .values({ userId: id, displayName: 'Profile Name', avatarUrl: 'https://cdn.example.test/avatar.png' });
    const before = await rows(id);
    const { status, body } = await read(canonical(issued.token));
    expect(status).toBe(200);
    expect(webSessionReadReplySchema.parse(body)).toMatchObject({
      outcome: 'active',
      userId: id,
      authSessionId: issued.sessionId,
      generation: 0,
      source: 'login',
      linkGuarded: true,
      user: { id, email, name: 'Profile Name', image: 'https://cdn.example.test/avatar.png' },
    });
    expect(await rows(id)).toEqual(before);
  });

  it('answers a legacy cookie by its own rules, without bridging it', async () => {
    const { id, email } = await climber();
    const sessionId = randomUUID();
    const before = await rows(id);
    const { status, body } = await read({ kind: 'legacy-jwe', credential: await legacyCookie(id, sessionId) });
    expect(status).toBe(200);
    expect(webSessionReadReplySchema.parse(body)).toMatchObject({
      outcome: 'active',
      userId: id,
      authSessionId: sessionId,
      source: 'login',
      user: { id, email, name: 'Account Name', image: null },
    });
    expect(await rows(id)).toEqual(before);
  });

  it('answers 401 for a revoked, expired, wrong-generation or deleted session and for a stored digest', async () => {
    const dead: PresentedWebSession[] = [];
    const revoked = await climber();
    const revokedSession = (await login(revoked.email)).webSession!;
    await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', {
        token: revokedSession.token,
        expectedUserId: revoked.id,
        expectedAuthSessionId: revokedSession.sessionId,
      }),
    );
    dead.push(canonical(revokedSession.token));

    const expired = await climber();
    const expiredSession = (await login(expired.email)).webSession!;
    await environment.database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, expiredSession.sessionId));
    dead.push(canonical(expiredSession.token));

    for (const deletedAt of [null, new Date()]) {
      const cutOff = await climber();
      const session = (await login(cutOff.email)).webSession!;
      await environment.database.insert(authSubjectCutoffs).values({
        userId: cutOff.id,
        generation: 1,
        revokedThrough: new Date(),
        deletedAt,
        lastOperationId: randomUUID(),
      });
      dead.push(canonical(session.token));
    }

    const stolen = await climber();
    const stolenSession = (await login(stolen.email)).webSession!;
    dead.push(canonical(sessionTokenDigest(stolenSession.token)));
    expect((await read(canonical(stolenSession.token))).status).toBe(200);

    for (const presented of dead) {
      const { status, body } = await read(presented);
      expect(status).toBe(401);
      expect(webSessionReadReplySchema.parse(body)).toMatchObject({ outcome: 'unauthenticated' });
    }
  });

  it('answers 401 for a legacy cookie that was signed out, cut off or deleted, and writes nothing', async () => {
    const dead: { userId: string; credential: string }[] = [];
    const signedOut = await climber();
    const signedOutSession = randomUUID();
    const signedOutCookie = await legacyCookie(signedOut.id, signedOutSession);
    await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', {
        presented: { kind: 'legacy-jwe', credential: signedOutCookie },
        expectedUserId: signedOut.id,
        expectedAuthSessionId: signedOutSession,
      }),
    );
    dead.push({ userId: signedOut.id, credential: signedOutCookie });
    for (const deletedAt of [null, new Date()]) {
      const cutOff = await climber();
      const credential = await legacyCookie(cutOff.id, randomUUID());
      await environment.database.insert(authSubjectCutoffs).values({
        userId: cutOff.id,
        generation: 1,
        revokedThrough: new Date(),
        deletedAt,
        lastOperationId: randomUUID(),
      });
      dead.push({ userId: cutOff.id, credential });
    }
    for (const { userId, credential } of dead) {
      const before = await rows(userId);
      const { status, body } = await read({ kind: 'legacy-jwe', credential });
      expect(status).toBe(401);
      expect(webSessionReadReplySchema.parse(body)).toMatchObject({ outcome: 'unauthenticated' });
      expect(await rows(userId)).toEqual(before);
    }
  });

  it('admits a legacy cookie only at its account generation: a zero, missing or higher stamp on a moved account is 401', async () => {
    const moved = await climber();
    await environment.database.insert(authSubjectCutoffs).values({
      userId: moved.id,
      generation: 1,
      revokedThrough: new Date(),
      deletedAt: null,
      lastOperationId: randomUUID(),
    });
    for (const stamp of [undefined, 0, 2]) {
      const { status } = await read({
        kind: 'legacy-jwe',
        credential: await legacyCookie(moved.id, randomUUID(), stamp),
      });
      expect(status, `stamp ${String(stamp)}`).toBe(401);
    }
    const current = await read({ kind: 'legacy-jwe', credential: await legacyCookie(moved.id, randomUUID(), 1) });
    expect(current.status).toBe(200);
  });

  it('answers 503 for a legacy cookie when the backend cannot read one', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, randomUUID());
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const { status, body } = await read({ kind: 'legacy-jwe', credential });
    expect(status).toBe(503);
    expect(webSessionReadReplySchema.parse(body)).toMatchObject({ outcome: 'error', code: 'unavailable' });
  });
});

describe('login and sign-out', () => {
  it('gives the proof the id and generation of the session it issued', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'compatible');
    const { id, email } = await climber();
    const reply = await login(email, { credentialProofVersion: 1 });
    expect(reply.credentialProof).toMatchObject({
      userId: id,
      authSessionId: reply.webSession!.sessionId,
      generation: reply.webSession!.generation,
    });
  });

  it('signs out a legacy cookie: that login ends and nothing else', async () => {
    const { id, email } = await climber();
    const [ending, staying] = [randomUUID(), randomUUID()];
    const [endingCookie, stayingCookie] = [await legacyCookie(id, ending), await legacyCookie(id, staying)];
    const canonicalSession = (await login(email)).webSession!;
    const signOut = (expectedAuthSessionId: string) =>
      post(
        WEB_SESSION_COMMAND_PATHS.signout,
        command('signout', {
          presented: { kind: 'legacy-jwe', credential: endingCookie },
          expectedUserId: id,
          expectedAuthSessionId,
        }),
      );

    const changed = await signOut(staying);
    expect(changed.status).toBe(409);
    expect(await legacyStatus(endingCookie)).toBe('admitted');

    const ended = await signOut(ending);
    expect(ended.status).toBe(200);
    expect(webSessionSignOutReplySchema.parse(ended.body)).toMatchObject({ outcome: 'signed_out' });
    expect(await legacyStatus(endingCookie)).toBe('denied');
    expect(await legacyStatus(stayingCookie)).toBe('admitted');
    expect((await read(canonical(canonicalSession.token))).status).toBe(200);
    expect((await rows(id)).cutoffs).toEqual([]);
  });

  it('signs out a no-SID legacy cookie by a denial of its own id and nothing else', async () => {
    const { id, email } = await climber();
    await login(email);
    const noSid = await legacyCookie(id);
    const session = (await read({ kind: 'legacy-jwe', credential: noSid })).body;
    const authSessionId = webSessionReadReplySchema.parse(session);
    if (authSessionId.outcome !== 'active') throw new Error('No-SID cookie not admitted');
    const before = await rows(id);
    const { status } = await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', {
        presented: { kind: 'legacy-jwe', credential: noSid },
        expectedUserId: id,
        expectedAuthSessionId: authSessionId.authSessionId,
      }),
    );
    expect(status).toBe(200);
    const after = await rows(id);
    expect(after.denials.map((denial) => denial.sessionId)).toEqual([authSessionId.authSessionId]);
    expect({ ...after, denials: [] }).toEqual({ ...before, denials: [] });
  });

  it('still accepts the first sign-out body, a bare token', async () => {
    const { id, email } = await climber();
    const session = (await login(email)).webSession!;
    const { status } = await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', { token: session.token, expectedUserId: id, expectedAuthSessionId: session.sessionId }),
    );
    expect(status).toBe(200);
    expect((await read(canonical(session.token))).status).toBe(401);
  });
});
