import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authEmailReservations,
  authMigrationEpochs,
  authSecurityMutationEvents,
  authSession,
  authSubjectCutoffs,
  oauthClient,
  oauthRefreshToken,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { captureAccountDeletionCommand, lockReservedDeletionSubject } from '../../current-store/account-deletion';
import { reserveEnforcedEmail } from '../../current-store/email-reservations';
import {
  beginIdentityAccountDeletion,
  deleteIdentityAccount,
  recordIdentityAccountDeletion,
} from '../account-deletion';
import { syncIdentity } from '../sync-identity';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import type { AuthorityTransaction } from '../adapter';
import * as adapterModule from '../adapter';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: 'js-trim-lower-v1',
  expectedWriterEpoch: 1,
};

async function fixture(selected: IdentityAuthorityName) {
  const userId = randomUUID();
  const email = `delete-${userId}@example.test`;
  const providerSubject = randomUUID();
  await environment.database.insert(users).values({ id: userId, email });
  await environment.database.insert(userCredentials).values({ userId, passwordHash: 'exact-owned-password-hash' });
  await environment.database.insert(accounts).values({
    userId,
    type: 'oauth',
    provider: 'google',
    providerAccountId: providerSubject,
  });
  await environment.database.insert(authSubjectCutoffs).values({
    userId,
    generation: 2,
    nativeGeneration: 7,
    revokedThrough: new Date(0),
    lastOperationId: randomUUID(),
  });
  await environment.database.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, requestedUserId: userId, rawEmail: email });
    await syncIdentity(transaction, userId, 'current-store-to-authority');
  });
  await environment.database.insert(authSession).values({
    id: randomUUID(),
    userId,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000),
    revocationGeneration: 2,
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
    expiresAt: new Date(Date.now() + 3600000),
    scopes: ['logbook:read'],
  });
  if (selected === 'better-auth')
    await environment.database.transaction((transaction) =>
      switchIdentityAuthority(transaction, { projectionId, epoch: 1, from: 'current-store', to: 'better-auth' }),
    );
  return {
    userId,
    email,
    providerSubject,
    clientId,
    command: captureAccountDeletionCommand(authority, userId, randomUUID()),
  };
}
type Owner = Awaited<ReturnType<typeof fixture>>;
async function stored(owner: Owner) {
  return {
    users: await environment.database.select().from(users).where(eq(users.id, owner.userId)),
    canonical: await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId)),
    legacy: await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    providers: await environment.database.select().from(accounts).where(eq(accounts.userId, owner.userId)),
    sessions: await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId)),
    partnerRefresh: await environment.database
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, owner.userId)),
    cutoffs: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, owner.userId)),
    events: await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    reservation: await environment.database
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, owner.email)),
  };
}
async function executeDeletion(owner: Owner, beforeBookkeeping?: (transaction: AuthorityTransaction) => Promise<void>) {
  await environment.database.transaction(async (transaction) => {
    const execution = await beginIdentityAccountDeletion(transaction, owner.command);
    const subject = await lockReservedDeletionSubject(transaction, execution.command);
    if (!subject) return;
    await deleteIdentityAccount(transaction, execution);
    if (beforeBookkeeping) await beforeBookkeeping(transaction);
    await recordIdentityAccountDeletion(transaction, execution, subject);
  });
}

describe('account deletion through the selected identity authority', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: authority.expectedNormalizerVersion,
      phase: 'enforced',
      writerEpoch: 1,
      preparedAt: new Date(),
    });
  });
  beforeEach(async () => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-selected-deletion-key-6975');
    await environment.database.delete(authMigrationEpochs);
    await environment.database
      .update(authEmailProjection)
      .set({ phase: 'enforced', writerAuthority: 'current-store', writerEpoch: 1 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected} removes both credential stores and sessions while preserving the privacy tombstone`, async () => {
      const owner = await fixture(selected);
      await executeDeletion(owner);
      const result = await stored(owner);
      expect(result.users).toHaveLength(0);
      expect(result.canonical).toHaveLength(0);
      expect(result.legacy).toHaveLength(0);
      expect(result.providers).toHaveLength(0);
      expect(result.sessions).toHaveLength(0);
      expect(result.partnerRefresh).toHaveLength(0);
      expect(result.reservation).toHaveLength(0);
      expect(result.cutoffs[0]).toMatchObject({ generation: 3, nativeGeneration: 7 });
      expect(result.cutoffs[0].deletedAt).toBeInstanceOf(Date);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        kind: 'account-deletion',
        domains: ['first-party', 'partner'],
        previousGeneration: 2,
        generation: 3,
        writerEpoch: selected === 'better-auth' ? 2 : 1,
      });
      await executeDeletion(owner);
      expect(await stored(owner)).toEqual(result);
    });
    it(`${selected} rolls back the real cascades and all bookkeeping when a later statement fails`, async () => {
      const owner = await fixture(selected);
      const before = await stored(owner);
      await expect(
        executeDeletion(owner, async () => {
          throw new Error('owned post-cascade failure');
        }),
      ).rejects.toThrow('owned post-cascade failure');
      expect(await stored(owner)).toEqual(before);
    });
    it(`${selected} rejects a manifest change after the cascade and restores account ownership`, async () => {
      const owner = await fixture(selected);
      const before = await stored(owner);
      await expect(
        executeDeletion(owner, async (transaction) => {
          await transaction
            .update(authEmailProjection)
            .set({ writerAuthority: selected === 'better-auth' ? 'current-store' : 'better-auth' });
        }),
      ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
      expect(await stored(owner)).toEqual(before);
    });
  }

  it('uses the actual Better Auth adapter delete rather than a legacy-only shortcut', async () => {
    const owner = await fixture('better-auth');
    const factory = adapterModule.createAuthorityAdapter;
    const deletedModels: string[] = [];
    vi.spyOn(adapterModule, 'createAuthorityAdapter').mockImplementation((transaction) => {
      const create = factory(transaction);
      return (configuration) => {
        const adapter = create(configuration);
        const remove = adapter.delete.bind(adapter);
        return {
          ...adapter,
          delete: async (request) => {
            deletedModels.push(request.model);
            return remove(request);
          },
        };
      };
    });
    await executeDeletion(owner);
    expect(deletedModels).toEqual(['user']);
  });

  it('selects the current epoch after writer rollback without pinning an old process epoch', async () => {
    const owner = await fixture('better-auth');
    await environment.database.transaction((transaction) =>
      switchIdentityAuthority(transaction, { projectionId, epoch: 2, from: 'better-auth', to: 'current-store' }),
    );
    await executeDeletion(owner);
    const result = await stored(owner);
    expect(result.users).toHaveLength(0);
    expect(result.events[0]).toMatchObject({ kind: 'account-deletion', writerEpoch: 3 });
  });

  it('rejects an unqualified projection before deleting any account data', async () => {
    const owner = await fixture('better-auth');
    await environment.database.update(authEmailProjection).set({ phase: 'prepared' });
    const before = await stored(owner);
    await expect(executeDeletion(owner)).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ENFORCED' });
    expect(await stored(owner)).toEqual(before);
  });
});
