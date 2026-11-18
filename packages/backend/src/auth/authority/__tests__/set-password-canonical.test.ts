/**
 * #7596 B4b over real HTTP and PostgreSQL: set-password on a canonical web
 * session keeps the session id and token, moves it to the new generation, and
 * ends everything else, as the legacy cookie form always has. Only a `login`
 * under five minutes old may do it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  WEB_SESSION_COMMAND_PATHS,
  setPasswordReplySchema,
  webSessionAccessReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import {
  accounts,
  authEmailProjection,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { normalizeAccountEmail } from '@boardsesh/auth-protocol/account-email';
import {
  canonical,
  command,
  harnessDatabase,
  legacyCookie,
  post,
  projectionId,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { reserveEnforcedEmail } from '../../current-store/email-reservations';
import { syncIdentity } from '../sync-identity';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';
import { CARRIED_WEB_SESSION_LINEAGE_PREFIX } from '../web-session';
import { sessionTokenDigest } from '../session-token';
import { AuthCredentialRefusedError } from '../../human-admission';
import { validateToken } from '../../../middleware/auth';

// These writers run with the mirror on and no backend boot (function-level mirror).
recordFunctionLevelIdentityMirrorForTests();

vi.mock('../../admission-pool', async () => {
  const { harnessDatabase: database } = await import('./web-session-http-harness');
  return {
    readOnAdmissionConnection: async (
      mark: () => void,
      read: (handle: ReturnType<typeof database>) => PromiseLike<unknown>,
    ) => {
      mark();
      return read(database());
    },
  };
});
vi.mock('../../../db/client', async () => {
  const { harnessDatabase: database } = await import('./web-session-http-harness');
  return {
    db: new Proxy(
      {},
      {
        get: (_target, property) => {
          const member: unknown = Reflect.get(database(), property);
          return typeof member === 'function'
            ? (...parameters: unknown[]) => Reflect.apply(member, database(), parameters)
            : member;
        },
      },
    ),
  };
});

beforeAll(() => startHarness({ prepareProjection: true }));
beforeEach(() => {
  stubCommandEnvironment();
  vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
});
afterAll(stopHarness);

const PASSWORD = ' a first password ';

/** An account that signs in with Google and has no password yet. */
async function providerClimber() {
  const userId = randomUUID();
  const email = `set-canonical-${userId}@example.test`;
  const database = harnessDatabase();
  await database.insert(users).values({ id: userId, email, name: null });
  await database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    await reserveEnforcedEmail(transaction, {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: manifest.writerEpoch,
      rawEmail: email,
      requestedUserId: userId,
    });
    await transaction
      .insert(accounts)
      .values({ userId, provider: 'google', providerAccountId: randomUUID(), type: 'oauth' });
    await syncIdentity(transaction, userId, 'current-store-to-authority');
  });
  return userId;
}

/** A session row as each writer leaves it, and its cookie token. */
async function sessionFor(userId: string, shape: { lineage?: 'bridge' | 'carried'; signedInAgoMs?: number } = {}) {
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  await harnessDatabase()
    .insert(authSession)
    .values({
      id: sessionId,
      token: sessionTokenDigest(token),
      userId,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      updatedAt: new Date(),
      originalAuthenticatedAt: new Date(Date.now() - (shape.signedInAgoMs ?? 20_000)),
      legacyLineageId:
        shape.lineage === 'bridge'
          ? `session:${randomBytes(32).toString('hex')}`
          : shape.lineage === 'carried'
            ? `${CARRIED_WEB_SESSION_LINEAGE_PREFIX}${sessionId}`
            : null,
      revocationGeneration: 0,
    });
  return { sessionId, token };
}

async function setPassword(userId: string, sessionId: string, presented: PresentedWebSession) {
  const { status, body } = await post(AUTH_COMMAND_PATHS['set-password'], {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'set-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: {
      presented,
      expectedUserId: userId,
      expectedAuthSessionId: sessionId,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    },
  });
  return { status, reply: setPasswordReplySchema.parse(body) };
}

async function accessToken(cookieToken: string) {
  const reply = webSessionAccessReplySchema.parse(
    (await post(WEB_SESSION_COMMAND_PATHS.access, command('access', { presented: canonical(cookieToken) }))).body,
  );
  if (reply.outcome !== 'active') throw new Error(`Access answered ${reply.outcome}`);
  return reply.accessToken;
}

async function admitted(token: string): Promise<boolean> {
  try {
    return (await validateToken(token, { throwOnRefusal: true })) !== null;
  } catch (error) {
    if (error instanceof AuthCredentialRefusedError) return false;
    throw error;
  }
}

async function written(userId: string) {
  const database = harnessDatabase();
  return {
    credentials: await database.select().from(userCredentials).where(eq(userCredentials.userId, userId)),
    cutoffs: await database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    sessions: await database.select().from(authSession).where(eq(authSession.userId, userId)).orderBy(authSession.id),
    refreshTokens: await database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
    denials: await database.select().from(authSessionDenials).where(eq(authSessionDenials.userId, userId)),
  };
}

async function signOut(userId: string, session: { sessionId: string; token: string }) {
  return post(
    WEB_SESSION_COMMAND_PATHS.signout,
    command('signout', { token: session.token, expectedUserId: userId, expectedAuthSessionId: session.sessionId }),
  );
}

/** A pending email verification link, as `email-verification.ts` issues it, at generation 0. */
async function pendingVerificationLink(userId: string) {
  const [user] = await harnessDatabase().select({ email: users.email }).from(users).where(eq(users.id, userId));
  const token = `ev1_${randomBytes(32).toString('base64url')}`;
  await harnessDatabase()
    .insert(authEmailVerificationState)
    .values({ userId, purpose: 'email-verification', generation: 1 })
    .onConflictDoNothing();
  await harnessDatabase()
    .insert(authEmailVerificationTokens)
    .values({
      tokenHash: createHash('sha256').update(`email-verification-v1\0${token}`).digest('hex'),
      userId,
      purpose: 'email-verification',
      deliveredEmail: user.email,
      normalizedEmail: normalizeAccountEmail(user.email),
      subjectGeneration: 0,
      issuanceGeneration: 1,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  return token;
}

async function verifyEmail(token: string) {
  const { body } = await post(AUTH_COMMAND_PATHS['verify-email'], {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'verify-email',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token },
  });
  return (body as { outcome?: string }).outcome;
}

describe('set-password on a canonical session', () => {
  it('keeps the session id and token at the new generation and ends everything else', async () => {
    const userId = await providerClimber();
    const session = await sessionFor(userId);
    const other = await sessionFor(userId);
    await harnessDatabase()
      .insert(mobileRefreshTokens)
      .values({ userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) });
    const before = await accessToken(session.token);
    const otherToken = await accessToken(other.token);
    expect(await admitted(before)).toBe(true);

    const { status, reply } = await setPassword(userId, session.sessionId, canonical(session.token));
    expect(status).toBe(200);
    if (reply.outcome !== 'set') throw new Error(`Set-password answered ${reply.outcome}`);
    // The proof only names the new generation: never fresh, and www writes no cookie from it.
    expect(reply.credentialProof).toMatchObject({
      userId,
      authSessionId: session.sessionId,
      generation: 1,
      authenticatedAt: null,
      linkGuarded: false,
    });
    expect(JSON.stringify(reply)).not.toContain(session.token);

    const [row] = await harnessDatabase().select().from(authSession).where(eq(authSession.id, session.sessionId));
    expect(row).toMatchObject({ token: sessionTokenDigest(session.token), revocationGeneration: 1 });
    // The 15-minute token signed at generation 0 dies at once; the same cookie gets a new one.
    expect(await admitted(before)).toBe(false);
    expect(await admitted(await accessToken(session.token))).toBe(true);
    // Every other session and the phone end, as the legacy form always did.
    expect(await admitted(otherToken)).toBe(false);
    const [phone] = await harnessDatabase()
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.userId, userId));
    expect(phone.revokedAt).not.toBeNull();
    const [credential] = (await written(userId)).credentials;
    expect(credential.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('asks a bridged, carried or older login session to reauthenticate, and writes nothing', async () => {
    for (const shape of [
      { lineage: 'bridge' as const },
      { lineage: 'carried' as const },
      { signedInAgoMs: 6 * 60_000 },
    ]) {
      const userId = await providerClimber();
      const session = await sessionFor(userId, shape);
      const before = await written(userId);
      const { status, reply } = await setPassword(userId, session.sessionId, canonical(session.token));
      expect(reply.outcome, JSON.stringify(shape)).toBe('reauthentication_required');
      expect(status).toBe(403);
      expect(await written(userId)).toEqual(before);
    }
  });

  it('answers a dead, foreign or mode-off canonical session without writing', async () => {
    const userId = await providerClimber();
    const session = await sessionFor(userId);
    const before = await written(userId);
    expect((await setPassword(userId, randomUUID(), canonical(session.token))).reply.outcome).toBe('identity_changed');
    expect((await setPassword(userId, session.sessionId, canonical('not-a-live-token'))).reply.outcome).toBe(
      'unauthenticated',
    );
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    expect((await setPassword(userId, session.sessionId, canonical(session.token))).reply.outcome).toBe(
      'unauthenticated',
    );
    expect(await written(userId)).toEqual(before);
  });

  it('treats a presented legacy cookie exactly as the first form', async () => {
    const userId = await providerClimber();
    const sessionId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const credential = await legacyCookie(userId, {
      claims: { authSessionId: sessionId, gen: 0, auth_time: now - 20, link_guarded: true },
    });
    const { reply } = await setPassword(userId, sessionId, { kind: 'legacy-jwe', credential });
    expect(reply).toMatchObject({
      outcome: 'set',
      credentialProof: { userId, authSessionId: sessionId, generation: 1, linkGuarded: true },
    });
  });

  it('ends a pending email verification link, as the legacy form does', async () => {
    const control = await providerClimber();
    expect(await verifyEmail(await pendingVerificationLink(control))).toBe('verified');
    const userId = await providerClimber();
    const link = await pendingVerificationLink(userId);
    const session = await sessionFor(userId);
    expect((await setPassword(userId, session.sessionId, canonical(session.token))).reply.outcome).toBe('set');
    expect(await verifyEmail(link)).toBe('invalid_token');
  });

  it('sets once when one session asks twice at once', async () => {
    const userId = await providerClimber();
    const session = await sessionFor(userId);
    const replies = await Promise.all([
      setPassword(userId, session.sessionId, canonical(session.token)),
      setPassword(userId, session.sessionId, canonical(session.token)),
    ]);
    const outcomes = replies.map(({ reply }) => reply.outcome);
    expect(outcomes.filter((outcome) => outcome === 'set')).toHaveLength(1);
    // The loser saw either the password or the moved generation.
    expect(['already_set', 'unauthenticated']).toContain(outcomes.find((outcome) => outcome !== 'set'));
    const after = await written(userId);
    expect(after.credentials).toHaveLength(1);
    expect(after.cutoffs.map((cutoff) => cutoff.generation)).toEqual([1]);
    const [row] = after.sessions;
    expect(row).toMatchObject({ token: sessionTokenDigest(session.token), revocationGeneration: 1 });
  });

  it('leaves the session ended whichever wins when set-password crosses its sign-out', async () => {
    const userId = await providerClimber();
    const session = await sessionFor(userId);
    const [setReply, signedOut] = await Promise.all([
      setPassword(userId, session.sessionId, canonical(session.token)),
      signOut(userId, session),
    ]);
    expect(signedOut.status).toBe(200);
    expect(['set', 'unauthenticated']).toContain(setReply.reply.outcome);
    const read = await post(
      WEB_SESSION_COMMAND_PATHS.session,
      command('session', { presented: canonical(session.token) }),
    );
    expect(read.status).toBe(401);
    const after = await written(userId);
    expect(after.sessions).toEqual([]);
    expect(after.credentials).toHaveLength(setReply.reply.outcome === 'set' ? 1 : 0);
  });
});
