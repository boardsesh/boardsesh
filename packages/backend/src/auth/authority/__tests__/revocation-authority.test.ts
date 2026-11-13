import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authMigrationEpochs,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  oauthClient,
  oauthRefreshToken,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { revokeAdministrativeCredentials } from '../admin-revocation';
import { denyFirstPartySession } from '../lineage';
import { authenticateIdentityPassword } from '../password-verification';
import { readFirstPartySession, type FirstPartySession } from '../session-reader';
import { revokeNativeCredentials } from '../native-revocation';
import { syncIdentity } from '../sync-identity';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
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
const password = ' café-山-🧗-password ';
const secret = 'isolated-revocation-selected-authority-secret';
let passwordHash: string;
const expected = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: 'js-trim-lower-v1',
  expectedWriterEpoch: 1,
};
type RevocationKind = 'administrative' | 'legacy-signout';

async function fixture(selected: IdentityAuthorityName) {
  const userId = randomUUID();
  const email = `revocation-${userId}@example.test`;
  const refreshHash = randomUUID();
  await environment.database.insert(users).values({ id: userId, email });
  await environment.database.insert(userCredentials).values({ userId, passwordHash });
  await environment.database.insert(accounts).values({
    userId,
    provider: 'google',
    providerAccountId: randomUUID(),
    type: 'oauth',
  });
  await environment.database.insert(authSubjectCutoffs).values({
    userId,
    generation: 0,
    nativeGeneration: 7,
    revokedThrough: new Date(0),
    lastOperationId: randomUUID(),
  });
  await environment.database.transaction((transaction) =>
    syncIdentity(transaction, userId, 'current-store-to-authority'),
  );
  await environment.database.insert(mobileRefreshTokens).values({
    userId,
    tokenHash: refreshHash,
    subjectGeneration: 0,
    nativeGeneration: 7,
    expiresAt: new Date(Date.now() + 3600000),
  });
  const clientId = randomUUID();
  await environment.database
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://partner.example.test/callback'] });
  await environment.database.insert(oauthRefreshToken).values({
    id: randomUUID(),
    userId,
    clientId,
    token: randomUUID(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    scopes: ['logbook:read'],
  });
  if (selected === 'better-auth')
    await environment.database.transaction((transaction) =>
      switchIdentityAuthority(transaction, { projectionId, epoch: 1, from: 'current-store', to: 'better-auth' }),
    );
  const context = { ...expected, expectedWriterEpoch: selected === 'better-auth' ? 2 : 1 };
  const session: FirstPartySession = {
    userId,
    authSessionId: randomUUID(),
    generation: 0,
    authenticatedAt: null,
    expiresAt: new Date(Date.now() + 3600000),
    requiresAccountCutoff: true,
    linkGuarded: false,
  };
  return { userId, email, refreshHash, context, session };
}
type Owner = Awaited<ReturnType<typeof fixture>>;
async function revoke(kind: RevocationKind, owner: Owner) {
  if (kind === 'administrative')
    await revokeAdministrativeCredentials(environment.database, owner.context, owner.userId, 0);
  else await denyFirstPartySession(environment.database, owner.session, new Date(), owner.context);
}
async function stored(owner: Owner) {
  return {
    canonical: await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId)),
    legacy: await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    cutoffs: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, owner.userId)),
    events: await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    refresh: await environment.database
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.userId, owner.userId)),
    partnerRefresh: await environment.database
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, owner.userId)),
  };
}
async function credential(owner: Owner, generation: number) {
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  return new EncryptJWT({ gen: generation, authSessionId: randomUUID() })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(owner.userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .encrypt(key);
}

describe('selected authority generation adoption for explicit revocation', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    passwordHash = await bcrypt.hash(password, 4);
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: expected.expectedNormalizerVersion,
      phase: 'enforced',
      writerEpoch: 1,
      preparedAt: new Date(),
    });
  });
  beforeEach(async () => {
    await environment.database.delete(authMigrationEpochs);
    await environment.database.update(authEmailProjection).set({ writerAuthority: 'current-store', writerEpoch: 1 });
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const)
    for (const kind of ['administrative', 'legacy-signout'] as const)
      it(`${selected} ${kind} keeps exact password login and generations consistent through rollback`, async () => {
        const owner = await fixture(selected);
        const previousCredential = await credential(owner, 0);
        expect(
          (
            await readFirstPartySession(environment.database, {
              kind: 'legacy-jwe',
              credential: previousCredential,
              secret,
            })
          ).status,
        ).toBe('admitted');
        if (selected === 'better-auth') vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
        await revoke(kind, owner);
        const state = await stored(owner);
        expect(state.canonical.every((account) => account.sourceGeneration === 1)).toBe(true);
        expect(state.canonical.find((account) => account.providerId === 'credential')?.password).toBe(passwordHash);
        expect(state.legacy[0].passwordHash).toBe(passwordHash);
        expect(state.cutoffs[0]).toMatchObject({ generation: 1, nativeGeneration: 7 });
        expect(state.events).toHaveLength(1);
        expect(state.partnerRefresh).toHaveLength(kind === 'administrative' ? 0 : 1);
        expect(state.events[0]).toMatchObject({
          kind: kind === 'administrative' ? 'admin-revocation' : 'legacy-signout',
          previousGeneration: 0,
          generation: 1,
          domains: kind === 'administrative' ? ['first-party', 'partner'] : ['first-party'],
          writerEpoch: owner.context.expectedWriterEpoch,
        });
        expect(
          (
            await readFirstPartySession(environment.database, {
              kind: 'legacy-jwe',
              credential: previousCredential,
              secret,
            })
          ).status,
        ).toBe('denied');
        expect(await authenticateIdentityPassword(environment.database, owner.email, password)).toMatchObject({
          userId: owner.userId,
          generation: 1,
        });
        expect(await authenticateIdentityPassword(environment.database, owner.email, password.trim())).toBeNull();
        if (selected === 'better-auth') {
          await environment.database.transaction((transaction) =>
            switchIdentityAuthority(transaction, { projectionId, epoch: 2, from: 'better-auth', to: 'current-store' }),
          );
          expect(await authenticateIdentityPassword(environment.database, owner.email, password)).toMatchObject({
            userId: owner.userId,
            generation: 1,
          });
          expect(
            (
              await readFirstPartySession(environment.database, {
                kind: 'legacy-jwe',
                credential: previousCredential,
                secret,
              })
            ).status,
          ).toBe('denied');
        }
      });

  for (const kind of ['administrative', 'legacy-signout'] as const) {
    it(`${kind} rejects stale canonical imports and rolls back the complete security mutation`, async () => {
      const owner = await fixture('better-auth');
      await environment.database
        .update(authAccount)
        .set({ sourceGeneration: null })
        .where(eq(authAccount.userId, owner.userId));
      const before = await stored(owner);
      await expect(revoke(kind, owner)).rejects.toThrow('AUTH_IDENTITY_CANONICAL_GENERATION_STALE');
      expect(await stored(owner)).toEqual(before);
    });
    it(`${kind} rolls back canonical advancement and cutoff when the reverse mirror fails`, async () => {
      const owner = await fixture('better-auth');
      await environment.database
        .update(userCredentials)
        .set({ passwordHash: 'stale-rollback-copy' })
        .where(eq(userCredentials.userId, owner.userId));
      // Persist the failure function in the suite-owned database so both pool connections see it.
      await environment.database.execute(
        sql`CREATE FUNCTION public.reject_revocation_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture mirror failure'; END $$`,
      );
      await environment.database.execute(
        sql`CREATE TRIGGER reject_revocation_mirror BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION public.reject_revocation_mirror()`,
      );
      const before = await stored(owner);
      try {
        await expect(revoke(kind, owner)).rejects.toThrow();
        expect(await stored(owner)).toEqual(before);
      } finally {
        await environment.database.execute(sql`DROP TRIGGER reject_revocation_mirror ON user_credentials`);
        await environment.database.execute(sql`DROP FUNCTION public.reject_revocation_mirror()`);
      }
    });
  }

  it('delayed legacy logout leaves a genuinely later login and its generation unchanged', async () => {
    const owner = await fixture('better-auth');
    await revoke('legacy-signout', owner);
    const laterCredential = await credential(owner, 1);
    const before = await stored(owner);
    await revoke('legacy-signout', owner);
    expect(await stored(owner)).toEqual(before);
    expect(
      (await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential: laterCredential, secret }))
        .status,
    ).toBe('admitted');
  });

  it('native-only signout keeps the account and canonical identity generation unchanged', async () => {
    const owner = await fixture('better-auth');
    expect(await revokeNativeCredentials(environment.database, owner.refreshHash, 'generation')).toBe(true);
    const state = await stored(owner);
    expect(state.cutoffs[0]).toMatchObject({ generation: 0, nativeGeneration: 8 });
    expect(state.canonical.every((account) => account.sourceGeneration === 0)).toBe(true);
    expect(await authenticateIdentityPassword(environment.database, owner.email, password)).toMatchObject({
      userId: owner.userId,
      generation: 0,
    });
  });
});
