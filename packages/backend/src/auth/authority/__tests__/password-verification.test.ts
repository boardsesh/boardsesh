import { decodeJwt } from 'jose';
import type { AuthorityTransaction } from '../adapter';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  authEmailProjection,
  authMigrationEpochs,
  authSubjectCutoffs,
  authAccount,
  userCredentials,
  users,
  mobileRefreshTokens,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { authenticateIdentityPassword } from '../password-verification';
import { captureIdentityAuthority, switchIdentityAuthority } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import { syncIdentity } from '../sync-identity';
import { advanceCanonicalIdentityGeneration } from '../reverse-identity';
import { recordSecurityMutation } from '../../current-store/security-mutations';
import {
  requireHumanSubjectForIssuance,
  PasswordProofStaleError,
  AuthAdmissionUnavailableError,
} from '../../human-admission';
import * as authorityFactory from '../authority';

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
const projectionId = randomUUID();
const qualification = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const authority = { ...qualification, expectedWriterEpoch: 1 };
const password = ' café-山-🧗-password ';
let passwordHash: string;
let nextHash: string;
async function fixture() {
  await environment.database.delete(authMigrationEpochs);
  await environment.database
    .update(authEmailProjection)
    .set({ writerAuthority: 'current-store', writerEpoch: 1, phase: 'enforced', preparedAt: new Date() });
  const userId = randomUUID();
  const email = `password-${userId}@example.test`;
  const createdAt = new Date('2020-01-02T03:04:05.123Z');
  await environment.database.insert(users).values({ id: userId, email, name: null, emailVerified: null, createdAt });
  await environment.database.insert(userCredentials).values({ userId, passwordHash });
  await environment.database.transaction((transaction) =>
    syncIdentity(transaction, userId, 'current-store-to-authority'),
  );
  return { userId, email, createdAt };
}
async function switchToBetterAuth() {
  await environment.database.transaction((transaction) =>
    switchIdentityAuthority(transaction, { projectionId, epoch: 1, from: 'current-store', to: 'better-auth' }),
  );
}
async function resetInTransaction(transaction: AuthorityTransaction, userId: string) {
  const primary = bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
  const snapshot = await primary.readPassword(userId);
  if (!snapshot || !(await primary.replacePassword(snapshot, nextHash))) throw new Error('Expected primary CAS');
  const mutation = await recordSecurityMutation(transaction, {
    ...authority,
    expectedWriterEpoch: primary.receipt.epoch,
    userId,
    operationId: randomUUID(),
    expectedGeneration: snapshot.generation,
    kind: 'password-reset',
    domains: ['first-party', 'partner'],
  });
  await advanceCanonicalIdentityGeneration(transaction, userId, mutation.identityGenerationReceipt);
  await syncIdentity(transaction, userId, 'authority-to-current-store');
}
async function reset(userId: string) {
  await environment.database.transaction((transaction) => resetInTransaction(transaction, userId));
}

describe('actual manifest-selected password proof and native issuance', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    passwordHash = await hash(password, 4);
    nextHash = await hash(' next-password ', 4);
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      phase: 'enforced',
      writerEpoch: 1,
      preparedAt: new Date(),
    });
  });
  afterAll(async () => environment?.close());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('preserves legacy pre-activation matching/age without manufacturing a manifest receipt, and rejects mixed case when canonical', async () => {
    const owner = await fixture();
    await environment.database.update(authEmailProjection).set({ phase: 'prepared' });
    await environment.database
      .update(users)
      .set({ email: owner.email.toUpperCase() })
      .where(eq(users.id, owner.userId));
    expect(await authenticateIdentityPassword(environment.database, ` ${owner.email} `, password)).toEqual({
      userId: owner.userId,
      createdAt: owner.createdAt,
      passwordHash,
      generation: 0,
    });
    await environment.database.update(authEmailProjection).set({ phase: 'enforced' });
    await switchToBetterAuth();
    await expect(authenticateIdentityPassword(environment.database, owner.email, password)).rejects.toBeInstanceOf(
      AuthAdmissionUnavailableError,
    );
  });
  it('selects real canonical primary bytes across a live switch and rollback without an environment epoch pin', async () => {
    const owner = await fixture();
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    const legacy = await authenticateIdentityPassword(environment.database, owner.email, password);
    expect(legacy).toMatchObject({
      userId: owner.userId,
      createdAt: owner.createdAt,
      generation: 0,
      authorityReceipt: { authority: 'current-store', epoch: 1 },
    });
    await switchToBetterAuth();
    await reset(owner.userId);
    // Prove the verifier and final issuer use canonical primary, not the mirror.
    await environment.database
      .update(userCredentials)
      .set({ passwordHash })
      .where(eq(userCredentials.userId, owner.userId));
    const canonical = await authenticateIdentityPassword(environment.database, owner.email, ' next-password ');
    expect(canonical).toMatchObject({
      userId: owner.userId,
      createdAt: owner.createdAt,
      generation: 1,
      authorityReceipt: { authority: 'better-auth', epoch: 2 },
    });
    if (!canonical) throw new Error('Expected canonical proof');
    await environment.database.transaction((transaction) =>
      requireHumanSubjectForIssuance(transaction, owner.userId, canonical),
    );
    expect(await authenticateIdentityPassword(environment.database, owner.email, password)).toBeNull();
    await environment.database.transaction((transaction) =>
      syncIdentity(transaction, owner.userId, 'authority-to-current-store'),
    );
    await environment.database.transaction((transaction) =>
      switchIdentityAuthority(transaction, { projectionId, epoch: 2, from: 'better-auth', to: 'current-store' }),
    );
    expect(await authenticateIdentityPassword(environment.database, owner.email, ' next-password ')).toMatchObject({
      authorityReceipt: { authority: 'current-store', epoch: 3 },
      generation: 1,
    });
  });
  it('uses the production-configured Better Auth verifier only after releasing the snapshot transaction', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    const actual = authorityFactory.verifyAuthorityPassword;
    const observedIdleTransactions: number[] = [];
    const observed = vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementation(async (input) => {
      const [activity] = await environment.client<
        { waiting: number }[]
      >`SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`;
      observedIdleTransactions.push(activity.waiting);
      return actual(input);
    });
    expect(await authenticateIdentityPassword(environment.database, owner.email.toUpperCase(), password)).toMatchObject(
      { userId: owner.userId },
    );
    expect(observed).toHaveBeenCalled();
    expect(observedIdleTransactions.every((count) => count === 0)).toBe(true);
  });
  it('rejects reset and authority changes between password proof and issuance without stamping newer state', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    const proved = await authenticateIdentityPassword(environment.database, owner.email, password);
    if (!proved) throw new Error('Expected proof');
    await reset(owner.userId);
    await expect(
      environment.database.transaction((transaction) =>
        requireHumanSubjectForIssuance(transaction, owner.userId, proved),
      ),
    ).rejects.toBeInstanceOf(PasswordProofStaleError);
    const fresh = await authenticateIdentityPassword(environment.database, owner.email, ' next-password ');
    if (!fresh) throw new Error('Expected current proof');
    await environment.database.transaction((transaction) =>
      switchIdentityAuthority(transaction, { projectionId, epoch: 2, from: 'better-auth', to: 'current-store' }),
    );
    await expect(
      environment.database.transaction((transaction) =>
        requireHumanSubjectForIssuance(transaction, owner.userId, fresh),
      ),
    ).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
    expect(
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, owner.userId)),
    ).toHaveLength(0);
  });
  it('an actual switch after bcrypt gives the native HTTP request a sanitized503 and its next request observes rollback without restart', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    vi.stubEnv('NEXTAUTH_SECRET', 'isolated-manifest-native-password-proof-secret');
    vi.stubEnv('AUTH_NATIVE_CANONICAL_BRIDGE_MODE', 'off');
    vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
    const actual = authorityFactory.verifyAuthorityPassword;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementation(async (input) => {
      const matched = await actual(input);
      await environment.database.transaction((transaction) =>
        switchIdentityAuthority(transaction, { projectionId, epoch: 2, from: 'better-auth', to: 'current-store' }),
      );
      return matched;
    });
    const { handleNativeAuthCredentials } = await import('../../../handlers/native-auth');
    const server = createServer((request, response) => {
      void handleNativeAuthCredentials(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected owned listener');
      const send = () =>
        fetch(`http://127.0.0.1:${address.port}/auth/native/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: owner.email, password }),
        });
      const stale = await send();
      expect(stale.status).toBe(503);
      await stale.arrayBuffer();
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, owner.userId)),
      ).toHaveLength(0);
      const current = await send();
      expect(current.status).toBe(200);
      await current.arrayBuffer();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it('keeps unqualified canonical generations and SQL evidence logging unavailable', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    await environment.database
      .update(authAccount)
      .set({ sourceGeneration: null })
      .where(eq(authAccount.userId, owner.userId));
    await expect(authenticateIdentityPassword(environment.database, owner.email, password)).rejects.toBeInstanceOf(
      AuthAdmissionUnavailableError,
    );
    vi.stubEnv('DEBUG_SQL', 'true');
    await expect(authenticateIdentityPassword(environment.database, owner.email, password)).rejects.toBeInstanceOf(
      AuthAdmissionUnavailableError,
    );
  });
  it('a real native request waiting for the user lock sees a committed reset and cannot mint the old hash at a new generation', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    vi.stubEnv('NEXTAUTH_SECRET', 'isolated-manifest-native-password-proof-secret');
    vi.stubEnv('AUTH_NATIVE_CANONICAL_BRIDGE_MODE', 'off');
    vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
    const { handleNativeAuthCredentials } = await import('../../../handlers/native-auth');
    const server = createServer((request, response) => {
      void handleNativeAuthCredentials(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected owned listener');
    let markHeld = () => {};
    let releaseWriter = () => {};
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = environment.database.transaction(async (transaction) => {
      await captureIdentityAuthority(transaction, qualification);
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for('update');
      markHeld();
      await proceed;
      await resetInTransaction(transaction, owner.userId);
    });
    try {
      await held;
      const request = fetch(`http://127.0.0.1:${address.port}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password }),
      });
      let waited = false;
      for (let attempt = 0; attempt < 200 && !waited; attempt++) {
        waited = await environment.hasWaitingUserKeyShare();
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waited).toBe(true);
      releaseWriter();
      await writer;
      const response = await request;
      expect([401, 503]).toContain(response.status);
      await response.arrayBuffer();
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, owner.userId)),
      ).toHaveLength(0);
      const [canonical] = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, owner.userId));
      expect(canonical.password).toBe(nextHash);
      expect(canonical.sourceGeneration).toBe(1);
    } finally {
      releaseWriter();
      await writer.catch(() => {});
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it('the real native credentials handler keeps its frozen reply and stable age/IDs under both authorities', async () => {
    const owner = await fixture();
    vi.stubEnv('NEXTAUTH_SECRET', 'isolated-manifest-native-password-proof-secret');
    vi.stubEnv('AUTH_NATIVE_CANONICAL_BRIDGE_MODE', 'off');
    vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
    const { handleNativeAuthCredentials } = await import('../../../handlers/native-auth');
    const server = createServer((request, response) => {
      void handleNativeAuthCredentials(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected owned listener');
      for (const engine of ['current-store', 'better-auth'] as const) {
        if (engine === 'better-auth') await switchToBetterAuth();
        const response = await fetch(`http://127.0.0.1:${address.port}/auth/native/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: owner.email, password }),
        });
        expect(response.status).toBe(200);
        const reply: unknown = await response.json();
        if (!reply || typeof reply !== 'object') throw new Error('Expected native reply');
        expect(Object.keys(reply).sort()).toEqual(['accountCreation', 'expiresAt', 'jwt', 'refreshToken', 'userId']);
        expect(reply).toMatchObject({
          userId: owner.userId,
          accountCreation: {
            userId: owner.userId,
            accountCreated: false,
            provider: 'email',
            createdAt: owner.createdAt.toISOString(),
          },
        });
        expect(reply).not.toHaveProperty('authorityReceipt');
        expect(reply).not.toHaveProperty('identityGenerationReceipt');
        if (!('jwt' in reply) || typeof reply.jwt !== 'string') throw new Error('Expected native JWT');
        expect(Object.keys(decodeJwt(reply.jwt)).sort()).toEqual([
          'aud',
          'auth_time',
          'exp',
          'gen',
          'iat',
          'iss',
          'ngen',
          'sid',
          'sub',
        ]);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it.each(['hash', 'source-generation'] as const)(
    'rejects a changed canonical %s even when the cutoff still equals the proved generation',
    async (kind) => {
      const owner = await fixture();
      await switchToBetterAuth();
      const proved = await authenticateIdentityPassword(environment.database, owner.email, password);
      if (!proved) throw new Error('Expected initial proof');
      await environment.database
        .update(authAccount)
        .set(kind === 'hash' ? { password: nextHash } : { sourceGeneration: 1 })
        .where(eq(authAccount.userId, owner.userId));
      await expect(
        environment.database.transaction((transaction) =>
          requireHumanSubjectForIssuance(transaction, owner.userId, proved),
        ),
      ).rejects.toBeInstanceOf(PasswordProofStaleError);
    },
  );
  it('never issues from a future canonical source stamp when the actual cutoff has not advanced', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    await environment.database
      .update(authAccount)
      .set({ sourceGeneration: 1 })
      .where(eq(authAccount.userId, owner.userId));
    const proved = await authenticateIdentityPassword(environment.database, owner.email, password);
    if (!proved) throw new Error('Expected canonical snapshot');
    expect(proved.generation).toBe(1);
    await expect(
      environment.database.transaction((transaction) =>
        requireHumanSubjectForIssuance(transaction, owner.userId, proved),
      ),
    ).rejects.toBeInstanceOf(PasswordProofStaleError);
  });
  it('bounds the actual canonical native login user-lock wait without issuing any refresh row', async () => {
    const owner = await fixture();
    await switchToBetterAuth();
    vi.stubEnv('NEXTAUTH_SECRET', 'isolated-bounded-login-secret');
    vi.stubEnv('AUTH_NATIVE_CANONICAL_BRIDGE_MODE', 'off');
    vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
    const { handleNativeAuthCredentials } = await import('../../../handlers/native-auth');
    const server = createServer((request, response) => {
      void handleNativeAuthCredentials(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected owned listener');
    let markHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = environment.database.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, owner.userId)).for('update');
      markHeld();
      await proceed;
    });
    try {
      await held;
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password }),
      });
      expect(response.status).toBe(503);
      await response.arrayBuffer();
      expect(performance.now() - started).toBeLessThan(1500);
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, owner.userId)),
      ).toHaveLength(0);
    } finally {
      release();
      await writer;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('refuses an unreceipted legacy proof after the writer becomes canonical', async () => {
    const owner = await fixture();
    await environment.database.update(authEmailProjection).set({ phase: 'prepared' });
    const proved = await authenticateIdentityPassword(environment.database, owner.email, password);
    if (!proved) throw new Error('Expected legacy proof');
    expect(proved.authorityReceipt).toBeUndefined();
    await environment.database.update(authEmailProjection).set({ phase: 'enforced' });
    await switchToBetterAuth();
    await expect(
      environment.database.transaction((transaction) =>
        requireHumanSubjectForIssuance(transaction, owner.userId, proved),
      ),
    ).rejects.toBeInstanceOf(PasswordProofStaleError);
  });
  it.each(['hash', 'cutoff'] as const)(
    'the actual HTTP issuer rereads the changed %s after its writer commits, with an independent successful login control',
    async (kind) => {
      const owner = await fixture();
      await switchToBetterAuth();
      vi.stubEnv('NEXTAUTH_SECRET', 'isolated-final-proof-revalidation-key');
      vi.stubEnv('AUTH_NATIVE_CANONICAL_BRIDGE_MODE', 'off');
      vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
      const actual = authorityFactory.verifyAuthorityPassword;
      const observer = vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (input) => {
        const matched = await actual(input);
        await environment.database.transaction(async (transaction) => {
          await captureIdentityAuthority(transaction, qualification);
          await transaction.select().from(users).where(eq(users.id, owner.userId)).for('update');
          if (kind === 'hash')
            await transaction
              .update(authAccount)
              .set({ password: nextHash })
              .where(eq(authAccount.userId, owner.userId));
          else
            await transaction.insert(authSubjectCutoffs).values({
              userId: owner.userId,
              generation: 1,
              revokedThrough: new Date(),
              lastOperationId: randomUUID(),
            });
        });
        return matched;
      });
      const { handleNativeAuthCredentials, __resetNativeAuthStateForTests } =
        await import('../../../handlers/native-auth');
      __resetNativeAuthStateForTests();
      const server = createServer((request, response) => {
        void handleNativeAuthCredentials(request, response);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected owned listener');
      const send = (submitted: string) =>
        fetch(`http://127.0.0.1:${address.port}/auth/native/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: owner.email, password: submitted }),
        });
      try {
        const stale = await send(password);
        expect(stale.status).toBe(401);
        await stale.arrayBuffer();
        expect(
          await environment.database
            .select()
            .from(mobileRefreshTokens)
            .where(eq(mobileRefreshTokens.userId, owner.userId)),
        ).toHaveLength(0);
        observer.mockRestore();
        if (kind === 'cutoff')
          await environment.database
            .update(authAccount)
            .set({ sourceGeneration: 1 })
            .where(eq(authAccount.userId, owner.userId));
        const admitted = await send(kind === 'hash' ? ' next-password ' : password);
        expect(admitted.status).toBe(200);
        await admitted.arrayBuffer();
      } finally {
        observer.mockRestore();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
  );
});
