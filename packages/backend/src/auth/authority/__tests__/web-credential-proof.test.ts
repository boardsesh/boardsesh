import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { hash, compare } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  users,
  accounts,
  userCredentials,
  authAccount,
  authSession,
  authEmailProjection,
  authSubjectCutoffs,
  authSecurityMutationEvents,
} from '@boardsesh/db/schema';
import {
  AUTH_PROTOCOL_VERSION,
  WEB_CREDENTIAL_PROOF_VERSION,
  webCredentialProofSchema,
  passwordCommandSchema,
  type SetPasswordCommand,
} from '@boardsesh/auth-protocol';
import { createEnvironment } from './environment';
import { authenticateWebPassword } from '../../current-store/web-password';
import {
  assertWebSessionWriterConfiguration,
  assertWebSessionWriterActivationConfiguration,
} from '../../current-store/web-session-configuration';
import { recordWebOAuthIntent, resolveWebOAuthIdentity } from '../../current-store/web-oauth-identity';
import { setWebPassword } from '../../current-store/set-password';
import * as commandContext from '../../current-store/command-context';
import * as foundationContext from '../../current-store/foundation-context';
import { signOutLegacyWebSession } from '../web-signout';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { bridgeLegacyCredential } from '../bridge';
import { readFirstPartySession } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get: (_target, property) => {
        const member: unknown = Reflect.get(environment.database, property);
        return typeof member === 'function'
          ? (...arguments_: unknown[]) => Reflect.apply(member, environment.database, arguments_)
          : member;
      },
    },
  ),
}));
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
const secret = 'synthetic-web-proof-secret-6975';
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
  emailVerificationEnabled: false,
};
async function cookie(
  userId: string,
  sessionId: string,
  generation = 0,
  ageSeconds: number | null = 10,
  guarded = true,
) {
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT({
    authSessionId: sessionId,
    gen: generation,
    ...(ageSeconds !== null ? { auth_time: now - ageSeconds } : {}),
    ...(guarded ? { link_guarded: true } : {}),
  })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .encrypt(key);
}
async function fixture(withPassword = false) {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const email = `proof-${userId}@example.com`;
  await environment.database.insert(users).values({ id: userId, email, name: null, emailVerified: null });
  await environment.database.transaction((transaction) =>
    reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId }),
  );
  const providerSubject = randomUUID();
  await environment.database
    .insert(accounts)
    .values({ userId, provider: 'google', providerAccountId: providerSubject, type: 'oauth' });
  if (withPassword)
    await environment.database
      .insert(userCredentials)
      .values({ userId, passwordHash: await hash(' original-password ', 4) });
  return { userId, sessionId, email, providerSubject };
}
const command = (
  owner: { userId: string; sessionId: string },
  credential: string,
  password = ' new-password ',
): SetPasswordCommand => ({
  protocolVersion: AUTH_PROTOCOL_VERSION,
  operation: 'set-password' as const,
  requestId: randomUUID(),
  issuedAt: Date.now(),
  payload: {
    credential,
    password,
    confirmPassword: password,
    expectedUserId: owner.userId,
    expectedAuthSessionId: owner.sessionId,
  },
});

describe('backend-issued web generation/freshness proofs', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
  });
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-proof-deleted-mailbox-key-6975');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => environment?.close());

  it('captures password generation/SID/time under the actual lock; a reset after reply cannot upgrade it', async () => {
    const owner = await fixture(true);
    const reply = await authenticateWebPassword(environment.database, authority, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      credentialProofVersion: WEB_CREDENTIAL_PROOF_VERSION,
      payload: { email: owner.email, password: ' original-password ' },
    });
    if (reply.outcome !== 'authenticated' || !reply.credentialProof) throw new Error('Missing backend proof');
    expect(reply.credentialProof).toMatchObject({ userId: owner.userId, generation: 0, linkGuarded: true });
    const signed = await cookie(owner.userId, reply.credentialProof.authSessionId, reply.credentialProof.generation);
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: owner.userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
    expect(
      await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential: signed, secret }),
    ).toEqual({ status: 'denied' });
    expect(reply.credentialProof.generation).toBe(0);
  });

  it('keeps legacy reply shapes only in compatible/off modes and rejects old requests when proofs are required', async () => {
    const owner = await fixture(true);
    const login = () =>
      authenticateWebPassword(environment.database, authority, {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { email: owner.email, password: ' original-password ' },
      });
    await expect(login()).rejects.toThrow('Versioned web credential proof required');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'compatible');
    expect(await login()).not.toHaveProperty('credentialProof');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
    expect(await login()).not.toHaveProperty('credentialProof');
  });

  it.each([
    [null, true],
    [600, true],
    [10, false],
    [-60, true],
  ] as const)('requires reauthentication for age %s / guarded %s', async (age, guarded) => {
    const owner = await fixture();
    const reply = await setWebPassword(
      environment.database,
      authority,
      command(owner, await cookie(owner.userId, owner.sessionId, 0, age, guarded)),
    );
    expect(reply.outcome).toBe('reauthentication_required');
    expect(
      await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    ).toHaveLength(0);
  });

  it('sets exact password bytes with cutoff+mirror in one commit, preserving age, SID and unverified status', async () => {
    const owner = await fixture();
    const credential = await cookie(owner.userId, owner.sessionId);
    const before = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (before.status !== 'admitted') throw new Error('Missing source session');
    const reply = await setWebPassword(environment.database, authority, command(owner, credential));
    if (reply.outcome !== 'set') throw new Error('Set password failed');
    expect(reply.credentialProof).toMatchObject({
      userId: owner.userId,
      authSessionId: owner.sessionId,
      generation: 1,
      authenticatedAt: before.session.authenticatedAt?.toISOString(),
      linkGuarded: true,
    });
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    const [canonical] = await environment.database
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, owner.userId));
    expect(await compare(' new-password ', legacy.passwordHash)).toBe(true);
    expect(await compare('new-password', legacy.passwordHash)).toBe(false);
    expect(canonical.password).toBe(legacy.passwordHash);
    expect(
      (await environment.database.select().from(users).where(eq(users.id, owner.userId)))[0].emailVerified,
    ).toBeNull();
    expect((await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret })).status).toBe(
      'denied',
    );
  });

  it('rolls credential, generation and audit back when the canonical mirror fails', async () => {
    const owner = await fixture();
    await environment.client.unsafe(
      "CREATE FUNCTION reject_web_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic mirror failure'; END $$",
    );
    await environment.client.unsafe(
      'CREATE TRIGGER reject_web_mirror BEFORE INSERT ON auth_account FOR EACH ROW EXECUTE FUNCTION reject_web_mirror()',
    );
    try {
      await expect(
        setWebPassword(environment.database, authority, command(owner, await cookie(owner.userId, owner.sessionId))),
      ).rejects.toThrow();
      expect(
        await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(authSecurityMutationEvents)
          .where(eq(authSecurityMutationEvents.userId, owner.userId)),
      ).toHaveLength(0);
    } finally {
      await environment.client.unsafe('DROP TRIGGER reject_web_mirror ON auth_account');
      await environment.client.unsafe('DROP FUNCTION reject_web_mirror()');
    }
  });

  it('rechecks a SID denial committed between initial admission and the subject lock', async () => {
    const owner = await fixture();
    const credential = await cookie(owner.userId, owner.sessionId);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualLock = foundationContext.lockSubjectRow;
    const lock = vi.spyOn(foundationContext, 'lockSubjectRow').mockImplementation(async (transaction, userId) => {
      entered();
      await continueLock;
      return actualLock(transaction, userId);
    });
    const pending = setWebPassword(environment.database, authority, command(owner, credential));
    try {
      await paused;
      expect((await signOutLegacyWebSession(environment.database, credential, secret)).status).toBe('signed-out');
      release();
      expect((await pending).outcome).toBe('unauthenticated');
      expect(
        await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
      ).toHaveLength(0);
    } finally {
      release();
      await pending.catch(() => undefined);
      lock.mockRestore();
    }
  });

  it('rejects unknown proof versions, coercions, extra claims and unnegotiated request versions', () => {
    const proof = {
      version: 1,
      userId: 'synthetic-owner',
      authSessionId: 'synthetic-sid',
      generation: 0,
      authenticatedAt: null,
      linkGuarded: false,
    };
    expect(webCredentialProofSchema.safeParse(proof).success).toBe(true);
    for (const malformed of [
      { ...proof, version: 2 },
      { ...proof, generation: '0' },
      { ...proof, generation: -1 },
      { ...proof, generation: 0.5 },
      { ...proof, generation: 2147483648 },
      { ...proof, accessToken: 'never-copy' },
      { ...proof, authenticatedAt: 'unknown' },
      { ...proof, linkGuarded: undefined },
    ])
      expect(webCredentialProofSchema.safeParse(malformed).success).toBe(false);
    const request = {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: 'synthetic@example.test', password: 'password' },
    };
    expect(passwordCommandSchema.safeParse(request).success).toBe(true);
    expect(passwordCommandSchema.safeParse({ ...request, credentialProofVersion: 2 }).success).toBe(false);
  });

  it('rolls successful credential/cutoff/mirror SQL back on a final semantic refusal', async () => {
    const owner = await fixture();
    const credential = await cookie(owner.userId, owner.sessionId);
    const finalCheck = vi.spyOn(commandContext, 'assertFresh').mockImplementation(() => {
      throw new Error('synthetic final semantic refusal');
    });
    try {
      await expect(setWebPassword(environment.database, authority, command(owner, credential))).rejects.toThrow(
        'synthetic final semantic refusal',
      );
      expect(finalCheck).toHaveBeenCalled();
      expect(
        await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(authSecurityMutationEvents)
          .where(eq(authSecurityMutationEvents.userId, owner.userId)),
      ).toHaveLength(0);
    } finally {
      finalCheck.mockRestore();
    }
  });

  it('rejects forged/denied credentials and never treats a raw user ID as a session', async () => {
    const owner = await fixture();
    expect((await setWebPassword(environment.database, authority, command(owner, owner.userId))).outcome).toBe(
      'unauthenticated',
    );
    await environment.database.transaction(async (transaction) =>
      expect((await readLockedWebSubjectState(transaction, owner.userId))?.generation).toBe(0),
    );
  });
  it.each([
    [600, true],
    [10, false],
    [null, true],
  ] as const)(
    'provider callback inherits actor age %s / guard %s instead of proving a new owner login',
    async (age, guarded) => {
      const owner = await fixture();
      const actorCookie = await cookie(owner.userId, owner.sessionId, 0, age, guarded);
      const before = await readFirstPartySession(environment.database, {
        kind: 'legacy-jwe',
        credential: actorCookie,
        secret,
      });
      if (before.status !== 'admitted') throw new Error('Missing actor proof');
      const flow = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      await recordWebOAuthIntent(environment.database, authority, secret, {
        webOAuthProtocolVersion: 1,
        operation: 'intent',
        requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        payload: { provider: 'google', flow, actorCookie },
      });
      const reply = await resolveWebOAuthIdentity(environment.database, authority, secret, {
        webOAuthProtocolVersion: 1,
        operation: 'resolve',
        requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        credentialProofVersion: 1,
        payload: {
          provider: 'google',
          flow,
          actorCookie,
          subject: owner.providerSubject,
          email: owner.email,
          name: null,
          image: null,
        },
      });
      if (reply.outcome !== 'resolved') throw new Error('Expected existing linked owner');
      expect(reply.credentialProof).toMatchObject({
        userId: owner.userId,
        authSessionId: owner.sessionId,
        generation: 0,
        authenticatedAt: before.session.authenticatedAt?.toISOString() ?? null,
        linkGuarded: guarded,
      });
    },
  );

  it('treats client identity only as a negative binding and never mutates a different fresh cookie owner', async () => {
    const displayed = await fixture();
    const cookieOwner = await fixture();
    const credential = await cookie(cookieOwner.userId, cookieOwner.sessionId);
    expect((await setWebPassword(environment.database, authority, command(displayed, credential))).outcome).toBe(
      'identity_changed',
    );
    expect(
      await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, cookieOwner.userId)),
    ).toHaveLength(0);
  });

  it('rotates an already bridged opaque token atomically, preserving SID and age without resurrecting the old token', async () => {
    const owner = await fixture();
    const credential = await cookie(owner.userId, owner.sessionId);
    const bridged = await bridgeLegacyCredential(environment.database, credential, secret, 'on');
    if (bridged.status !== 'bridged') throw new Error('Expected owned canonical session');
    const old = bridged.session;
    expect((await setWebPassword(environment.database, authority, command(owner, credential))).outcome).toBe('set');
    const [next] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sessionId));
    expect(next.token).not.toBe(old.token);
    expect(next.revocationGeneration).toBe(1);
    expect(next.originalAuthenticatedAt).toEqual(old.originalAuthenticatedAt);
    expect(next.createdAt).toEqual(old.createdAt);
    expect(next.expiresAt.getTime()).toBeLessThanOrEqual(old.expiresAt.getTime());
    expect(
      (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: old.token })).status,
    ).toBe('denied');
    expect(
      (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: next.token })).status,
    ).toBe('admitted');
  });

  it('the exported server refuses unqualified SID activation before external initialization', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'backend-staging');
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'synthetic-distinct-rpc-secret-at-least-32-bytes');
    const { pubsub } = await import('../../../pubsub/index');
    const initialize = vi.spyOn(pubsub, 'initialize').mockRejectedValue(new Error('UNEXPECTED_STARTUP_IO'));
    try {
      const { startServer } = await import('../../../server');
      await expect(startServer()).rejects.toThrow('historical issuer retirement');
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      initialize.mockRestore();
    }
  });

  it('keeps new writers dark and refuses bridge-on without an enforced SID writer and distinct RPC secret', () => {
    expect(() => assertWebSessionWriterConfiguration({})).not.toThrow();
    expect(() => assertWebSessionWriterActivationConfiguration({})).not.toThrow();
    expect(() =>
      assertWebSessionWriterActivationConfiguration({
        CURRENT_STORE_WEB_SIGNOUT_MODE: 'backend-staging',
        AUTH_CUTOFF_ENFORCEMENT: 'enforce',
        CURRENT_STORE_AUTH_RPC_SECRET: 'synthetic-distinct-rpc-secret-at-least-32-bytes',
        NEXTAUTH_SECRET: secret,
      }),
    ).toThrow('historical issuer retirement');
    expect(() => assertWebSessionWriterConfiguration({ AUTH_LEGACY_BRIDGE_MODE: 'on' })).toThrow();
    expect(() =>
      assertWebSessionWriterConfiguration({
        CURRENT_STORE_WEB_SIGNOUT_MODE: 'backend-staging',
        AUTH_CUTOFF_ENFORCEMENT: 'observe',
      }),
    ).toThrow();
    expect(() =>
      assertWebSessionWriterConfiguration({
        CURRENT_STORE_WEB_SIGNOUT_MODE: 'backend-staging',
        CURRENT_STORE_AUTH_RPC_SECRET: secret,
        NEXTAUTH_SECRET: secret,
      }),
    ).toThrow();
  });
});
