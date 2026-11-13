import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authSession,
  authSessionDenials,
  authEmailProjection,
  authSubjectCutoffs,
  users,
  userCredentials,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import {
  captureIdentityAuthority,
  readIdentityAuthority,
  switchIdentityAuthority,
  type IdentityAuthorityName,
} from '../router';
import { bindIdentityAuthority, type IdentityAuthority } from '../identity-authority';
import * as authorityAdapter from '../adapter';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let originalHash: string;
let nextHash: string;
const projectionId = randomUUID();
const qualification = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
async function run<T>(authority: IdentityAuthorityName, operation: (storage: IdentityAuthority) => Promise<T>) {
  await environment.database.update(authEmailProjection).set({ writerAuthority: authority });
  return environment.database.transaction(async (tx) =>
    operation(bindIdentityAuthority(tx, await captureIdentityAuthority(tx, qualification))),
  );
}

describe('transaction-bound primary identity implementations', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    originalHash = await hash(' café-山-🧗-password ', 4);
    nextHash = await hash(' distinct-password ', 4);
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      phase: 'enforced',
      writerEpoch: 1,
      preparedAt: new Date(),
    });
  });
  afterAll(async () => environment?.close());
  for (const authority of ['current-store', 'better-auth'] as const) {
    it(`${authority}: preserves stable users, NULL names, verification dates and exact primary bcrypt/provider bytes`, async () => {
      const userId = randomUUID();
      const verifiedAt = new Date('2024-02-03T04:05:06.123Z');
      const subject = `FACEbook-Case:${randomUUID()}`;
      await run(authority, async (storage) => {
        const created = await storage.createUser({
          id: userId,
          email: `storage-${userId}@example.test`,
          name: null,
          emailVerified: verifiedAt,
        });
        expect(created.name).toBeNull();
        expect(created.emailVerified).toEqual(verifiedAt);
        await storage.insertPassword(userId, originalHash, 0);
        expect(await storage.readPassword(userId)).toEqual({ userId, passwordHash: originalHash, generation: 0 });
        await storage.insertProvider({ userId, provider: 'facebook', subject }, 0);
        expect(await storage.findProvider('facebook', subject)).toEqual({
          userId,
          provider: 'facebook',
          subject,
          generation: 0,
        });
      });
      const [stored] = await environment.database.select().from(users).where(eq(users.id, userId));
      expect(stored.emailVerified).toEqual(verifiedAt);
      const legacy = await environment.database
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, userId));
      const canonical = await environment.database.select().from(authAccount).where(eq(authAccount.userId, userId));
      // Implementations perform real primary operations; reverse copy is caller-owned.
      expect(legacy).toHaveLength(authority === 'current-store' ? 1 : 0);
      expect(canonical).toHaveLength(authority === 'better-auth' ? 2 : 0);
      if (authority === 'better-auth')
        expect(canonical.find((account) => account.providerId === 'credential')?.password).toBe(originalHash);
    });
    it(`${authority}: CAS refuses a stale password/generation and injected failure rolls primary writes back`, async () => {
      const userId = randomUUID();
      await run(authority, async (storage) => {
        await storage.createUser({ id: userId, email: `cas-${userId}@example.test`, name: null, emailVerified: null });
        await storage.insertPassword(userId, originalHash, 0);
        expect(await storage.replacePassword({ userId, passwordHash: nextHash, generation: 0 }, nextHash)).toBe(false);
        expect(await storage.replacePassword({ userId, passwordHash: originalHash, generation: 0 }, nextHash)).toBe(
          true,
        );
      });
      await expect(
        run(authority, async (storage) => {
          expect(await storage.replacePassword({ userId, passwordHash: nextHash, generation: 0 }, originalHash)).toBe(
            true,
          );
          throw new Error('injected caller failure');
        }),
      ).rejects.toThrow('injected caller failure');
      expect(await run(authority, (storage) => storage.readPassword(userId))).toEqual({
        userId,
        passwordHash: nextHash,
        generation: 0,
      });
      await environment.database
        .insert(authSubjectCutoffs)
        .values({ userId, generation: 1, revokedThrough: new Date(0), lastOperationId: randomUUID() });
      await expect(
        run(authority, (storage) =>
          storage.replacePassword({ userId, passwordHash: nextHash, generation: 0 }, originalHash),
        ),
      ).rejects.toThrow('IDENTITY_GENERATION_STALE');
      const [stored] = await environment.database.select().from(users).where(eq(users.id, userId));
      expect(stored.emailVerified).toBeNull();
    });
    it(`${authority}: deletion cascades canonical credentials/sessions but preserves denial and cutoff evidence`, async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await run(authority, async (storage) => {
        await storage.createUser({ id: userId, email: `delete-${userId}@example.test` });
        await storage.insertPassword(userId, originalHash, 0);
      });
      await environment.database.insert(authSession).values({
        id: sessionId,
        userId,
        token: randomUUID(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await environment.database
        .insert(authSessionDenials)
        .values({ sessionId, userId, expiresAt: new Date(Date.now() + 60_000) });
      await environment.database.insert(authSubjectCutoffs).values({
        userId,
        generation: 1,
        deletedAt: new Date(),
        revokedThrough: new Date(),
        lastOperationId: randomUUID(),
      });
      expect(await run(authority, (storage) => storage.deleteUser(userId))).toBe(true);
      expect(await environment.database.select().from(authAccount).where(eq(authAccount.userId, userId))).toHaveLength(
        0,
      );
      expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(
        0,
      );
      expect(
        await environment.database.select().from(authSessionDenials).where(eq(authSessionDenials.userId, userId)),
      ).toHaveLength(1);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
      ).toHaveLength(1);
    });
    it(`${authority}: removes only the exact provider owner and rejects namespace/owner conflicts`, async () => {
      const ownerId = randomUUID();
      const otherId = randomUUID();
      const subject = randomUUID();
      await run(authority, async (storage) => {
        await storage.createUser({ id: ownerId, email: `owner-${ownerId}@example.test` });
        await storage.createUser({ id: otherId, email: `other-${otherId}@example.test` });
        await storage.insertProvider({ userId: ownerId, provider: 'facebook', subject }, 0);
        expect(await storage.removeProvider({ userId: otherId, provider: 'facebook', subject }, 0)).toBe(false);
      });
      await expect(
        run(authority, (storage) => storage.insertProvider({ userId: otherId, provider: 'facebook', subject }, 0)),
      ).rejects.toThrow();
      expect(await run(authority, (storage) => storage.findProvider('facebook', subject))).toMatchObject({
        userId: ownerId,
      });
      await expect(
        run(authority, (storage) => storage.insertProvider({ userId: ownerId, provider: 'credential', subject }, 0)),
      ).rejects.toThrow('NAMESPACE');
      expect(
        await run(authority, (storage) =>
          storage.removeProvider({ userId: ownerId, provider: 'facebook', subject }, 0),
        ),
      ).toBe(true);
      expect(
        await environment.database.select().from(accounts).where(eq(accounts.providerAccountId, subject)),
      ).toHaveLength(0);
    });
  }
  it('rejects a stale bound authority before a primary write after a live switch', async () => {
    await environment.database.update(authEmailProjection).set({ writerAuthority: 'current-store' });
    const captured = await readIdentityAuthority(environment.database, qualification);
    await environment.database.transaction((tx) =>
      switchIdentityAuthority(tx, { projectionId, epoch: captured.epoch, from: 'current-store', to: 'better-auth' }),
    );
    const userId = randomUUID();
    await expect(
      environment.database.transaction((tx) =>
        bindIdentityAuthority(tx, captured).createUser({ id: userId, email: `stale-${userId}@example.test` }),
      ),
    ).rejects.toThrow('STALE_AUTHORITY');
    expect(await environment.database.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
  });
  it('fails closed on unqualified canonical generations instead of reading a newer cutoff after the hash', async () => {
    const userId = randomUUID();
    await environment.database.insert(users).values({ id: userId, email: `unqualified-${userId}@example.test` });
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId, generation: 7, revokedThrough: new Date(0), lastOperationId: randomUUID() });
    await environment.database
      .insert(authAccount)
      .values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: originalHash });
    await expect(run('better-auth', (storage) => storage.readPassword(userId))).rejects.toThrow(
      'IDENTITY_CREDENTIAL_UNQUALIFIED',
    );
    await environment.database.update(authAccount).set({ sourceGeneration: 3 }).where(eq(authAccount.userId, userId));
    expect(await run('better-auth', (storage) => storage.readPassword(userId))).toEqual({
      userId,
      passwordHash: originalHash,
      generation: 3,
    });
  });
  it('Better Auth CAS includes the account generation even when cutoff generation still matches', async () => {
    const userId = randomUUID();
    await run('better-auth', async (storage) => {
      await storage.createUser({ id: userId, email: `generation-${userId}@example.test` });
      await storage.insertPassword(userId, originalHash, 0);
    });
    await environment.database.update(authAccount).set({ sourceGeneration: 1 }).where(eq(authAccount.userId, userId));
    expect(
      await run('better-auth', (storage) =>
        storage.replacePassword({ userId, passwordHash: originalHash, generation: 0 }, nextHash),
      ),
    ).toBe(false);
    const [stored] = await environment.database.select().from(authAccount).where(eq(authAccount.userId, userId));
    expect(stored.password).toBe(originalHash);
    expect(stored.sourceGeneration).toBe(1);
  });

  it('delegates primary operations to the real Better Auth adapter inside the caller transaction', async () => {
    const actual = authorityAdapter.createAuthorityAdapter;
    const calls = new Map<string, number>();
    const observer = vi.spyOn(authorityAdapter, 'createAuthorityAdapter').mockImplementation((transaction) => {
      const factory = actual(transaction);
      return (options) =>
        new Proxy(factory(options), {
          get(target, property, receiver) {
            const member: unknown = Reflect.get(target, property, receiver);
            if (typeof member !== 'function') return member;
            return (...arguments_: unknown[]) => {
              const key = String(property);
              calls.set(key, (calls.get(key) ?? 0) + 1);
              return Reflect.apply(member, target, arguments_);
            };
          },
        });
    });
    try {
      const userId = randomUUID();
      await run('better-auth', async (storage) => {
        await storage.createUser({ id: userId, email: `delegate-${userId}@example.test`, emailVerified: null });
        await storage.insertPassword(userId, originalHash, 0);
        expect((await storage.readPassword(userId))?.passwordHash).toBe(originalHash);
        expect(await storage.replacePassword({ userId, passwordHash: originalHash, generation: 0 }, nextHash)).toBe(
          true,
        );
        await storage.insertProvider({ userId, provider: 'facebook', subject: userId }, 0);
        expect(await storage.findProvider('facebook', userId)).toMatchObject({ userId });
        expect(await storage.removeProvider({ userId, provider: 'facebook', subject: userId }, 0)).toBe(true);
        expect(await storage.deleteUser(userId)).toBe(true);
      });
      for (const operation of ['create', 'findMany', 'update', 'findOne', 'deleteMany', 'delete'])
        expect(calls.get(operation)).toBeGreaterThan(0);
    } finally {
      observer.mockRestore();
    }
  });

  it('keeps hash and generation from one adapter snapshot when a second connection resets after its SELECT', async () => {
    const userId = randomUUID();
    await run('better-auth', async (storage) => {
      await storage.createUser({ id: userId, email: `snapshot-${userId}@example.test` });
      await storage.insertPassword(userId, originalHash, 0);
    });
    let selected!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const actual = authorityAdapter.createAuthorityAdapter;
    const observer = vi.spyOn(authorityAdapter, 'createAuthorityAdapter').mockImplementation((transaction) => {
      const factory = actual(transaction);
      return (options) =>
        new Proxy(factory(options), {
          get(target, property, receiver) {
            const member: unknown = Reflect.get(target, property, receiver);
            if (property !== 'findMany' || typeof member !== 'function') return member;
            return async (...arguments_: unknown[]) => {
              const snapshot: unknown = await Reflect.apply(member, target, arguments_);
              selected();
              await proceed;
              return snapshot;
            };
          },
        });
    });
    const pending = run('better-auth', (storage) => storage.readPassword(userId));
    try {
      await reached;
      await environment.database.transaction(async (transaction) => {
        await transaction
          .update(authAccount)
          .set({ password: nextHash, sourceGeneration: 1 })
          .where(eq(authAccount.userId, userId));
        await transaction
          .insert(authSubjectCutoffs)
          .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      });
      resume();
      expect(await pending).toEqual({ userId, passwordHash: originalHash, generation: 0 });
    } finally {
      resume();
      await pending.catch(() => undefined);
      observer.mockRestore();
    }
  });
});
