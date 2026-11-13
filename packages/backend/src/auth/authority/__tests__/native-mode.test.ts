import { revokeNativeCredentials } from '../native-revocation';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import {
  authCredentialLineage,
  authSecurityMutationEvents,
  authSession,
  authSubjectCutoffs,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import {
  assertNativeRevocationActivationConfiguration,
  currentNativeRevocationMode,
} from '../native-revocation-configuration';

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
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => environment?.close());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('the actual default native handler preserves watch JWT admission and cutoff generations exactly', async () => {
  vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', '');
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  const secret = 'isolated-default-native-handler-key';
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  const userId = randomUUID();
  const rawRefresh = randomUUID();
  const canonicalId = randomUUID();
  const lineageId = `native-refresh:${randomUUID()}`;
  await environment.database.insert(users).values({ id: userId, email: `native-mode-${userId}@example.test` });
  await environment.database.insert(mobileRefreshTokens).values({
    userId,
    tokenHash: createHash('sha256').update(rawRefresh).digest('hex'),
    expiresAt: new Date(Date.now() + 86400000),
  });
  await environment.database.insert(authSession).values({
    id: canonicalId,
    userId,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(0),
    updatedAt: new Date(),
    legacyLineageId: lineageId,
    revocationGeneration: 0,
  });
  await environment.database
    .insert(authCredentialLineage)
    .values({ id: lineageId, userId, sessionId: canonicalId, originalExpiresAt: new Date(Date.now() + 86400000) });
  const watchJwt = await new SignJWT({ sub: userId, gen: 0, ngen: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  const { validateMobileJwt } = await import('../../../middleware/auth');
  const { handleNativeAuthRevoke } = await import('../../../handlers/native-auth');
  expect((await validateMobileJwt(watchJwt))?.userId).toBe(userId);
  const server = createServer((request, response) => {
    void handleNativeAuthRevoke(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OWNED_HTTP_ADDRESS_REQUIRED');
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/native/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rawRefresh }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect((await validateMobileJwt(watchJwt))?.userId).toBe(userId);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, userId)),
    ).toHaveLength(0);
    expect(await environment.database.select().from(authSession).where(eq(authSession.id, canonicalId))).toHaveLength(
      1,
    );
    expect(
      (
        await environment.database.select().from(authCredentialLineage).where(eq(authCredentialLineage.id, lineageId))
      )[0].revokedAt,
    ).toBeNull();
    expect(
      (await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)))[0]
        .revokedAt,
    ).not.toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

it.each(['production', 'test', 'development'])(
  'hard-refuses generation startup with NODE_ENV=%s',
  (nodeEnvironment) => {
    expect(currentNativeRevocationMode({})).toBe('legacy');
    expect(() =>
      assertNativeRevocationActivationConfiguration({
        NODE_ENV: nodeEnvironment,
        AUTH_NATIVE_REVOCATION_MODE: 'generation',
      }),
    ).toThrow('NATIVE_REVOCATION_ACTIVATION_BLOCKED');
  },
);

it('refuses native canonical issuance without a generation revocation writer', () => {
  expect(() => assertNativeRevocationActivationConfiguration({ AUTH_LEGACY_BRIDGE_MODE: 'on' })).toThrow(
    'NATIVE_CANONICAL_ISSUANCE_REQUIRES_GENERATION_REVOCATION',
  );
});

it('the actual server startup refuses the staged mode before any external initialization', async () => {
  vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'generation');
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  const { pubsub } = await import('../../../pubsub/index');
  const initialize = vi.spyOn(pubsub, 'initialize').mockRejectedValue(new Error('UNEXPECTED_STARTUP_IO'));
  const { startServer } = await import('../../../server');
  await expect(startServer()).rejects.toThrow('NATIVE_REVOCATION_ACTIVATION_BLOCKED');
  expect(initialize).not.toHaveBeenCalled();
});

it('the core helper also defaults to legacy cleanup when its caller omits the mode', async () => {
  const userId = randomUUID();
  const tokenHash = randomUUID();
  await environment.database
    .insert(users)
    .values({ id: userId, email: `synthetic-core-default-${userId}@example.test` });
  await environment.database
    .insert(mobileRefreshTokens)
    .values({ userId, tokenHash, expiresAt: new Date(Date.now() + 86400000) });
  expect(await revokeNativeCredentials(environment.database, tokenHash)).toBe(true);
  expect(
    await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
  ).toHaveLength(0);
  expect(
    await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, userId)),
  ).toHaveLength(0);
});
