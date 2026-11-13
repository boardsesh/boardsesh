import { randomUUID } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { recordSecurityMutation, type IdentityGenerationMutationReceipt } from '../../current-store/security-mutations';
import { recordCheckedSecurityMutation } from '../../current-store/security-mutation-core';
import { captureIdentityAuthority } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import { syncIdentity } from '../sync-identity';
import { advanceCanonicalIdentityGeneration } from '../reverse-identity';
import type { AuthorityTransaction } from '../adapter';
import * as authorityAdapter from '../adapter';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let originalHash: string;
let nextHash: string;
const projectionId = randomUUID();
const qualification = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const authority = { ...qualification, expectedWriterEpoch: 1 };
async function store(transaction: AuthorityTransaction) {
  return bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
}
async function fixture(mirror = true) {
  const userId = randomUUID();
  const subject = `FACEbook-Case:${randomUUID()}`;
  await environment.database.transaction(async (transaction) => {
    const primary = await store(transaction);
    await primary.createUser({ id: userId, email: `reverse-${userId}@example.test`, name: null, emailVerified: null });
    await primary.insertPassword(userId, originalHash, 0);
    await primary.insertProvider({ userId, provider: 'facebook', subject }, 0);
    if (mirror) await syncIdentity(transaction, userId, 'authority-to-current-store');
  });
  return { userId, subject };
}
async function reset(transaction: AuthorityTransaction, userId: string) {
  const primary = await store(transaction);
  const snapshot = await primary.readPassword(userId);
  if (!snapshot || !(await primary.replacePassword(snapshot, nextHash))) throw new Error('Expected primary reset');
  const mutation = await recordSecurityMutation(transaction, {
    ...authority,
    userId,
    operationId: randomUUID(),
    expectedGeneration: 0,
    kind: 'password-reset',
    domains: ['first-party', 'partner'],
  });
  await advanceCanonicalIdentityGeneration(transaction, userId, mutation.identityGenerationReceipt);
  await syncIdentity(transaction, userId, 'authority-to-current-store');
}

describe('same-transaction canonical primary and legacy rollback mirror', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    originalHash = await hash(' café-山-🧗-password ', 4);
    nextHash = await hash(' distinct-password ', 4);
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      phase: 'enforced',
      writerEpoch: 1,
      writerAuthority: 'better-auth',
      preparedAt: new Date(),
    });
  });
  afterAll(async () => environment?.close());
  it('refuses a legacy import/mirror direction once Better Auth is primary', async () => {
    const owner = await fixture();
    await environment.database
      .update(userCredentials)
      .set({ passwordHash: nextHash })
      .where(eq(userCredentials.userId, owner.userId));
    await expect(
      environment.database.transaction((transaction) =>
        syncIdentity(transaction, owner.userId, 'current-store-to-authority'),
      ),
    ).rejects.toThrow('SOURCE_AUTHORITY_REQUIRED');
    const [canonical] = await environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.providerId, 'credential')));
    expect(canonical.password).toBe(originalHash);
  });
  it('copies exact primary bytes and subjects without modifying NULL user metadata', async () => {
    const owner = await fixture();
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(legacy.passwordHash).toBe(originalHash);
    const [provider] = await environment.database.select().from(accounts).where(eq(accounts.userId, owner.userId));
    expect(provider).toMatchObject({ provider: 'facebook', providerAccountId: owner.subject, userId: owner.userId });
    const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
    expect(user.name).toBeNull();
    expect(user.emailVerified).toBeNull();
  });
  it('preserves unchanged password timestamps/provider token fields and removes only an unlinked provider', async () => {
    const owner = await fixture();
    const originalTime = new Date('2020-01-02T03:04:05.123Z');
    await environment.database
      .update(userCredentials)
      .set({ updatedAt: originalTime })
      .where(eq(userCredentials.userId, owner.userId));
    await environment.database
      .update(accounts)
      .set({ access_token: 'synthetic-existing-token' })
      .where(eq(accounts.userId, owner.userId));
    await environment.database.transaction((transaction) =>
      syncIdentity(transaction, owner.userId, 'authority-to-current-store'),
    );
    const [retained] = await environment.database.select().from(accounts).where(eq(accounts.userId, owner.userId));
    expect(retained.access_token).toBe('synthetic-existing-token');
    await environment.database.transaction(async (transaction) => {
      const primary = await store(transaction);
      expect(await primary.removeProvider({ ...owner, provider: 'facebook' }, 0)).toBe(true);
      await syncIdentity(transaction, owner.userId, 'authority-to-current-store');
    });
    expect(await environment.database.select().from(accounts).where(eq(accounts.userId, owner.userId))).toHaveLength(0);
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(legacy.updatedAt).toEqual(originalTime);
  });
  it('commits actual adapter reset, cutoff, generation metadata and reverse copy together', async () => {
    const owner = await fixture();
    await environment.database.transaction((transaction) => reset(transaction, owner.userId));
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    const canonical = await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId));
    expect(legacy.passwordHash).toBe(nextHash);
    expect(canonical.find((account) => account.providerId === 'credential')?.password).toBe(nextHash);
    expect(canonical.every((account) => account.sourceGeneration === 1)).toBe(true);
    expect(await compare(' café-山-🧗-password ', legacy.passwordHash)).toBe(false);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    ).toHaveLength(1);
  });
  it('rolls primary hash/cutoff/event/metadata back when the legacy mirror fails', async () => {
    const owner = await fixture();
    await environment.client.unsafe(
      "CREATE FUNCTION reject_owned_legacy_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected mirror failure'; END $$; CREATE TRIGGER reject_owned_legacy_update BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION reject_owned_legacy_update()",
    );
    try {
      await expect(
        environment.database.transaction((transaction) => reset(transaction, owner.userId)),
      ).rejects.toThrow();
    } finally {
      await environment.client.unsafe(
        'DROP TRIGGER reject_owned_legacy_update ON user_credentials; DROP FUNCTION reject_owned_legacy_update()',
      );
    }
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    const [canonical] = await environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.providerId, 'credential')));
    expect(legacy.passwordHash).toBe(originalHash);
    expect(canonical.password).toBe(originalHash);
    expect(canonical.sourceGeneration).toBe(0);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    ).toHaveLength(0);
  });
  it('refuses NULL, stale/future canonical generations and unsupported password removal without changing legacy bytes', async () => {
    const owner = await fixture();
    for (const sourceGeneration of [null, -1, 1]) {
      await environment.database
        .update(authAccount)
        .set({ sourceGeneration })
        .where(eq(authAccount.userId, owner.userId));
      await expect(
        environment.database.transaction((transaction) =>
          syncIdentity(transaction, owner.userId, 'authority-to-current-store'),
        ),
      ).rejects.toThrow('CANONICAL_GENERATION_STALE');
    }
    await environment.database
      .update(authAccount)
      .set({ sourceGeneration: 0 })
      .where(eq(authAccount.userId, owner.userId));
    await environment.database
      .delete(authAccount)
      .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.providerId, 'credential')));
    await expect(
      environment.database.transaction((transaction) =>
        syncIdentity(transaction, owner.userId, 'authority-to-current-store'),
      ),
    ).rejects.toThrow('PASSWORD_REMOVAL_UNSUPPORTED');
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(legacy.passwordHash).toBe(originalHash);
  });
  it('never reassigns a provider subject owned by another legacy user or leaves a partial password copy', async () => {
    const owner = await fixture(false);
    const otherId = randomUUID();
    await environment.database.insert(users).values({ id: otherId, email: `other-${otherId}@example.test` });
    await environment.database
      .insert(accounts)
      .values({ userId: otherId, type: 'oauth', provider: 'facebook', providerAccountId: owner.subject });
    await expect(
      environment.database.transaction((transaction) =>
        syncIdentity(transaction, owner.userId, 'authority-to-current-store'),
      ),
    ).rejects.toThrow('PROVIDER_OWNER_CONFLICT');
    expect(
      await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    ).toHaveLength(0);
    const [provider] = await environment.database
      .select()
      .from(accounts)
      .where(eq(accounts.providerAccountId, owner.subject));
    expect(provider.userId).toBe(otherId);
  });
  it('cannot stamp an uncommitted cutoff, downgrade generations or bless an older import', async () => {
    const owner = await fixture();
    await expect(
      environment.database.transaction((transaction) =>
        advanceCanonicalIdentityGeneration(transaction, owner.userId, {
          previousGeneration: 0,
          generation: 1,
        } as unknown as IdentityGenerationMutationReceipt),
      ),
    ).rejects.toThrow('MUTATION_RECEIPT_INVALID');
    await expect(
      environment.database.transaction((transaction) =>
        advanceCanonicalIdentityGeneration(transaction, owner.userId, {
          previousGeneration: 1,
          generation: 0,
        } as unknown as IdentityGenerationMutationReceipt),
      ),
    ).rejects.toThrow('MUTATION_RECEIPT_INVALID');
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: owner.userId, generation: 2, revokedThrough: new Date(), lastOperationId: randomUUID() });
    await expect(
      environment.database.transaction((transaction) =>
        advanceCanonicalIdentityGeneration(transaction, owner.userId, {
          previousGeneration: 1,
          generation: 2,
        } as unknown as IdentityGenerationMutationReceipt),
      ),
    ).rejects.toThrow('MUTATION_RECEIPT_INVALID');
  });
  it('rolls all successful SQL back on an adapter row-count mismatch without a SQL-aborted transaction', async () => {
    const owner = await fixture();
    const actual = authorityAdapter.createAuthorityAdapter;
    let advanced = false;
    const observer = vi.spyOn(authorityAdapter, 'createAuthorityAdapter').mockImplementation((transaction) => {
      const factory = actual(transaction);
      return (options) =>
        new Proxy(factory(options), {
          get(target, property, receiver) {
            const member: unknown = Reflect.get(target, property, receiver);
            if (property !== 'updateMany' || typeof member !== 'function') return member;
            return async (...arguments_: unknown[]) => {
              const changed: unknown = await Reflect.apply(member, target, arguments_);
              if (typeof changed !== 'number') throw new Error('Unexpected adapter count');
              advanced = true;
              return changed - 1;
            };
          },
        });
    });
    try {
      await expect(environment.database.transaction((transaction) => reset(transaction, owner.userId))).rejects.toThrow(
        'CANONICAL_GENERATION_STALE',
      );
      expect(advanced).toBe(true);
    } finally {
      observer.mockRestore();
    }
    const [credential] = await environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.providerId, 'credential')));
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(credential.password).toBe(originalHash);
    expect(credential.sourceGeneration).toBe(0);
    expect(legacy.passwordHash).toBe(originalHash);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    ).toHaveLength(0);
  });

  it('cannot bless a stale canonical password using a cutoff committed in an earlier transaction', async () => {
    const owner = await fixture();
    await environment.database.insert(authSubjectCutoffs).values({
      userId: owner.userId,
      generation: 1,
      revokedThrough: new Date(),
      lastOperationId: randomUUID(),
    });
    await expect(
      environment.database.transaction((transaction) =>
        advanceCanonicalIdentityGeneration(transaction, owner.userId, {
          previousGeneration: 0,
          generation: 1,
        } as unknown as IdentityGenerationMutationReceipt),
      ),
    ).rejects.toThrow();
  });

  it('rejects forged, copied, serialized and wrong-subject receipts while the real same-TX receipt succeeds', async () => {
    const owner = await fixture();
    await environment.database.transaction(async (transaction) => {
      const primary = await store(transaction);
      const snapshot = await primary.readPassword(owner.userId);
      if (!snapshot || !(await primary.replacePassword(snapshot, nextHash))) throw new Error('Expected primary CAS');
      const mutation = await recordSecurityMutation(transaction, {
        ...authority,
        userId: owner.userId,
        operationId: randomUUID(),
        expectedGeneration: 0,
        kind: 'password-reset',
        domains: ['first-party', 'partner'],
      });
      const receipt = mutation.identityGenerationReceipt;
      expect(Object.keys(mutation)).toEqual(['cutoff', 'event']);
      expect({ ...mutation }).not.toHaveProperty('identityGenerationReceipt');
      expect(JSON.parse(JSON.stringify(mutation))).not.toHaveProperty('identityGenerationReceipt');
      expect(Object.getOwnPropertyDescriptor(mutation, 'identityGenerationReceipt')).toMatchObject({
        enumerable: false,
        writable: false,
        configurable: false,
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      const substitutes: unknown[] = [
        {},
        { ...receipt },
        JSON.parse(JSON.stringify(receipt)),
        Object.create(receipt),
        new Proxy(receipt, {}),
      ];
      for (const substitute of substitutes) {
        await expect(
          advanceCanonicalIdentityGeneration(
            transaction,
            owner.userId,
            substitute as IdentityGenerationMutationReceipt,
          ),
        ).rejects.toThrow('MUTATION_RECEIPT_INVALID');
      }
      await expect(advanceCanonicalIdentityGeneration(transaction, randomUUID(), receipt)).rejects.toThrow(
        'MUTATION_RECEIPT_INVALID',
      );
      await advanceCanonicalIdentityGeneration(transaction, owner.userId, receipt);
      await syncIdentity(transaction, owner.userId, 'authority-to-current-store');
    });
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(legacy.passwordHash).toBe(nextHash);
  });
  it('cannot reuse a genuine receipt from an earlier transaction to bless a stale canonical password', async () => {
    const owner = await fixture();
    // Model a committed older writer: legacy reset and checked cutoff changed,
    // while canonical data remained stale. Production retirement is still gated.
    const receipt = await environment.database.transaction(async (transaction) => {
      await transaction
        .update(userCredentials)
        .set({ passwordHash: nextHash })
        .where(eq(userCredentials.userId, owner.userId));
      const mutation = await recordCheckedSecurityMutation(transaction, {
        ...authority,
        userId: owner.userId,
        operationId: randomUUID(),
        expectedGeneration: 0,
        kind: 'password-reset',
        domains: ['first-party', 'partner'],
      });
      return mutation.identityGenerationReceipt;
    });
    await expect(
      environment.database.transaction((transaction) =>
        advanceCanonicalIdentityGeneration(transaction, owner.userId, receipt),
      ),
    ).rejects.toThrow('MUTATION_RECEIPT_INVALID');
    await expect(
      environment.database.transaction((transaction) =>
        syncIdentity(transaction, owner.userId, 'authority-to-current-store'),
      ),
    ).rejects.toThrow('CANONICAL_GENERATION_STALE');
    const [canonical] = await environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.providerId, 'credential')));
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(canonical.password).toBe(originalHash);
    expect(canonical.sourceGeneration).toBe(0);
    expect(legacy.passwordHash).toBe(nextHash);
  });
});
