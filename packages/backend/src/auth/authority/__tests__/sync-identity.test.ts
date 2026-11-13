import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authSecurityMutationEvents,
  authMigrationEpochs,
  authSession,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { syncIdentity, mirrorIdentityIfEnabled } from '../sync-identity';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
  lockEnforcedProjection,
} from '../../current-store/foundation-context';
import { recordSecurityMutation } from '../../current-store/security-mutations';
import type { AuthorityTransaction } from '../adapter';
import { assertIdentityMirrorActivationConfiguration, identityMirrorMode } from '../mirror-configuration';
import { insertCurrentStorePasswordIdentity } from '../../current-store/password-identity';
import {
  currentStoreNativeOAuthConfiguration,
  currentStoreNativeRegistrationConfiguration,
} from '../../current-store/authority-configuration';

const originalHash = '$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const replacementHash = '$2b$12$1avkJS6hZfQZqD0nMW0NLeZLgBtKkJNG9c9IeOlQl5QvwDTDVSihe';

describe('same-transaction identity mirror', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  afterEach(() => vi.unstubAllEnvs());

  async function fixture() {
    const userId = randomUUID();
    await environment.database
      .insert(users)
      .values({ id: userId, email: `mirror-${userId}@example.com`, name: null, emailVerified: null });
    await environment.database.insert(userCredentials).values({ userId, passwordHash: originalHash });
    return userId;
  }
  const synchronize = (userId: string) =>
    environment.database.transaction((transaction) => syncIdentity(transaction, userId, 'current-store-to-authority'));
  const canonical = (userId: string) =>
    environment.database.select().from(authAccount).where(eq(authAccount.userId, userId));

  it('defaults off, rejects unknown selectors, and blocks every production activation until set-password is delegated', () => {
    expect(identityMirrorMode({})).toBe('off');
    expect(identityMirrorMode({ AUTH_IDENTITY_MIRROR: 'off' })).toBe('off');
    expect(identityMirrorMode({ AUTH_IDENTITY_MIRROR: 'on' })).toBe('on');
    expect(() => identityMirrorMode({ AUTH_IDENTITY_MIRROR: 'true' })).toThrow();
    expect(() => assertIdentityMirrorActivationConfiguration({})).not.toThrow();
    expect(() => assertIdentityMirrorActivationConfiguration({ AUTH_IDENTITY_MIRROR: 'on' })).toThrow(
      'backend-owned fresh-auth set-password',
    );
    expect(() => currentStoreNativeOAuthConfiguration({ AUTH_IDENTITY_MIRROR: 'on' })).toThrow('staged native');
    expect(() => currentStoreNativeRegistrationConfiguration({ AUTH_IDENTITY_MIRROR: 'on' })).toThrow('staged native');
  });

  it('preserves IDs, exact bcrypt/provider subjects and user verification without creating sessions or epochs', async () => {
    const userId = await fixture();
    const subject = `FACEbook-Case:${randomUUID()}`;
    await environment.database.insert(accounts).values({
      userId,
      provider: 'facebook',
      providerAccountId: subject,
      type: 'oauth',
      access_token: 'synthetic-token-not-copied',
    });
    await synchronize(userId);
    expect(await canonical(userId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId,
          providerId: 'credential',
          accountId: userId,
          password: originalHash,
          sourceGeneration: 0,
        }),
        expect.objectContaining({
          userId,
          providerId: 'facebook',
          accountId: subject,
          password: null,
          accessToken: null,
          sourceGeneration: 0,
        }),
      ]),
    );
    expect((await environment.database.select().from(users).where(eq(users.id, userId)))[0]).toMatchObject({
      name: null,
      emailVerified: null,
    });
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(0);
    expect(await environment.database.select().from(authMigrationEpochs)).toHaveLength(0);
  });

  it('is a no-op on replay and removes unlinked provider/password rows', async () => {
    const userId = await fixture();
    await environment.database
      .insert(accounts)
      .values({ userId, provider: 'apple', providerAccountId: userId, type: 'oauth' });
    await synchronize(userId);
    const before = await canonical(userId);
    await synchronize(userId);
    expect(await canonical(userId)).toEqual(before);
    await environment.database.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, userId)).for('update');
      await transaction.delete(accounts).where(eq(accounts.userId, userId));
      await transaction.delete(userCredentials).where(eq(userCredentials.userId, userId));
      await syncIdentity(transaction, userId, 'current-store-to-authority');
    });
    expect(await canonical(userId)).toHaveLength(0);
  });

  it('refuses provider ownership conflicts and rolls back any preceding canonical writes', async () => {
    const owner = await fixture();
    const contender = await fixture();
    const subject = randomUUID();
    await environment.database
      .insert(authAccount)
      .values({ id: randomUUID(), userId: owner, providerId: 'google', accountId: subject, sourceGeneration: 0 });
    await environment.database
      .insert(accounts)
      .values({ userId: contender, provider: 'google', providerAccountId: subject, type: 'oauth' });
    await expect(synchronize(contender)).rejects.toThrow('AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT');
    expect(await canonical(contender)).toHaveLength(0);
    expect(await canonical(owner)).toMatchObject([{ userId: owner, accountId: subject }]);
  });

  it('does not restore a lower source generation', async () => {
    const userId = await fixture();
    await environment.database.insert(authAccount).values({
      id: randomUUID(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: replacementHash,
      sourceGeneration: 2,
    });
    await expect(synchronize(userId)).rejects.toThrow('AUTH_IDENTITY_SOURCE_GENERATION_STALE');
    expect(await canonical(userId)).toMatchObject([{ password: replacementHash, sourceGeneration: 2 }]);
  });

  it('integrates creation only when on and rolls back both stores on mirror SQL failure', async () => {
    const emailOff = `off-${randomUUID()}@example.com`;
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
    const off = await environment.database.transaction((transaction) =>
      insertCurrentStorePasswordIdentity(transaction, { email: emailOff, passwordHash: originalHash }, false),
    );
    expect(await canonical(off.userId)).toHaveLength(0);
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const emailOn = `on-${randomUUID()}@example.com`;
    const on = await environment.database.transaction((transaction) =>
      insertCurrentStorePasswordIdentity(transaction, { email: emailOn, passwordHash: originalHash }, true),
    );
    expect(await canonical(on.userId)).toMatchObject([{ password: originalHash }]);
    const rejectedEmail = `rollback-${randomUUID()}@example.com`;
    await environment.client.unsafe(
      "CREATE FUNCTION reject_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected mirror failure'; END $$",
    );
    await environment.client.unsafe(
      'CREATE TRIGGER reject_mirror BEFORE INSERT ON auth_account FOR EACH ROW EXECUTE FUNCTION reject_mirror()',
    );
    try {
      await expect(
        environment.database.transaction((transaction) =>
          insertCurrentStorePasswordIdentity(
            transaction,
            { email: rejectedEmail, passwordHash: replacementHash },
            false,
          ),
        ),
      ).rejects.toThrow();
      expect(await environment.database.select().from(users).where(eq(users.email, rejectedEmail))).toHaveLength(0);
    } finally {
      await environment.client.unsafe('DROP TRIGGER reject_mirror ON auth_account');
      await environment.client.unsafe('DROP FUNCTION reject_mirror()');
    }
  });

  it('does no database work while the mirror is off', async () => {
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
    await expect(mirrorIdentityIfEnabled({} as AuthorityTransaction, 'synthetic-off-subject')).resolves.toBeUndefined();
  });

  it('rejects provider namespace collisions and unsupported snapshot isolation', async () => {
    const userId = await fixture();
    await environment.database
      .insert(accounts)
      .values({ userId, provider: 'credential', providerAccountId: userId, type: 'oauth' });
    await expect(synchronize(userId)).rejects.toThrow('AUTH_IDENTITY_PROVIDER_NAMESPACE_CONFLICT');
    expect(await canonical(userId)).toHaveLength(0);
    await expect(
      environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await syncIdentity(transaction, userId, 'current-store-to-authority');
      }),
    ).rejects.toThrow('UNSUPPORTED_ISOLATION');
  });

  it('rolls back source reset and generation when a canonical update fails', async () => {
    const userId = await fixture();
    await synchronize(userId);
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId, generation: 0, revokedThrough: new Date(), lastOperationId: randomUUID() });
    await environment.client.unsafe(
      "CREATE FUNCTION reject_mirror_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected mirror update failure'; END $$",
    );
    await environment.client.unsafe(
      'CREATE TRIGGER reject_mirror_update BEFORE UPDATE ON auth_account FOR EACH ROW EXECUTE FUNCTION reject_mirror_update()',
    );
    try {
      await expect(
        environment.database.transaction(async (transaction) => {
          await transaction.select().from(users).where(eq(users.id, userId)).for('update');
          await transaction
            .update(userCredentials)
            .set({ passwordHash: replacementHash })
            .where(eq(userCredentials.userId, userId));
          await transaction
            .update(authSubjectCutoffs)
            .set({ generation: 1 })
            .where(eq(authSubjectCutoffs.userId, userId));
          await syncIdentity(transaction, userId, 'current-store-to-authority');
        }),
      ).rejects.toThrow();
      expect(
        (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0]
          .passwordHash,
      ).toBe(originalHash);
      expect(
        (await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)))[0]
          .generation,
      ).toBe(0);
      expect(await canonical(userId)).toMatchObject([{ password: originalHash, sourceGeneration: 0 }]);
    } finally {
      await environment.client.unsafe('DROP TRIGGER reject_mirror_update ON auth_account');
      await environment.client.unsafe('DROP FUNCTION reject_mirror_update()');
    }
  });

  it('waits for the exclusive gate before acquiring the user row', async () => {
    const userId = await fixture();
    let releaseGate!: () => void;
    let announceGate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      announceGate = resolve;
    });
    const holder = environment.database.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      announceGate();
      await released;
      await transaction.select().from(users).where(eq(users.id, userId)).for('update', { noWait: true });
    });
    await locked;
    const backfill = synchronize(userId);
    try {
      expect(
        await Promise.race([
          backfill.then(() => 'completed'),
          new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75)),
        ]),
      ).toBe('waiting');
    } finally {
      releaseGate();
    }
    await Promise.all([holder, backfill]);
    expect(await canonical(userId)).toHaveLength(1);
  });

  it('propagates semantic mirror conflicts and rolls back preceding source writes', async () => {
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const owner = await fixture();
    const contender = await fixture();
    const subject = randomUUID();
    await environment.database
      .insert(authAccount)
      .values({ id: randomUUID(), userId: owner, providerId: 'google', accountId: subject, sourceGeneration: 0 });
    await environment.database
      .insert(accounts)
      .values({ userId: contender, provider: 'google', providerAccountId: subject, type: 'oauth' });
    await expect(
      environment.database.transaction(async (transaction) => {
        await transaction
          .update(userCredentials)
          .set({ passwordHash: replacementHash })
          .where(eq(userCredentials.userId, contender));
        await mirrorIdentityIfEnabled(transaction, contender);
      }),
    ).rejects.toThrow('AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT');
    expect(
      (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, contender)))[0]
        .passwordHash,
    ).toBe(originalHash);
    expect(await canonical(contender)).toHaveLength(0);
    expect(await canonical(owner)).toMatchObject([{ userId: owner, accountId: subject }]);
  });

  it('mirrors a real security reset boundary and rolls back both stores on update failure', async () => {
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const userId = await fixture();
    await synchronize(userId);
    const authority = {
      expectedProjectionId: randomUUID(),
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await environment.database.insert(authEmailProjection).values({
      projectionId: authority.expectedProjectionId,
      isCurrent: true,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      writerEpoch: 1,
      phase: 'enforced',
      preparedAt: new Date(),
    });
    const reset = (passwordHash: string, expectedGeneration: number) =>
      environment.database.transaction(async (transaction) => {
        await lockEnforcedProjection(transaction, authority);
        await transaction.select().from(users).where(eq(users.id, userId)).for('update');
        await transaction.update(userCredentials).set({ passwordHash }).where(eq(userCredentials.userId, userId));
        await recordSecurityMutation(transaction, {
          ...authority,
          userId,
          operationId: randomUUID(),
          expectedGeneration,
          kind: 'password-reset',
          domains: ['first-party', 'partner'],
        });
      });
    try {
      await reset(replacementHash, 0);
      expect(await canonical(userId)).toMatchObject([{ password: replacementHash, sourceGeneration: 1 }]);
      await environment.client.unsafe(
        "CREATE FUNCTION reject_reset_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reset mirror failure'; END $$",
      );
      await environment.client.unsafe(
        'CREATE TRIGGER reject_reset_mirror BEFORE UPDATE ON auth_account FOR EACH ROW EXECUTE FUNCTION reject_reset_mirror()',
      );
      try {
        await expect(reset(originalHash, 1)).rejects.toThrow();
        expect(
          (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0]
            .passwordHash,
        ).toBe(replacementHash);
        expect(
          (await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)))[0]
            .generation,
        ).toBe(1);
        expect(
          await environment.database
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.userId, userId)),
        ).toHaveLength(1);
        expect(await canonical(userId)).toMatchObject([{ password: replacementHash, sourceGeneration: 1 }]);
      } finally {
        await environment.client.unsafe('DROP TRIGGER reject_reset_mirror ON auth_account');
        await environment.client.unsafe('DROP FUNCTION reject_reset_mirror()');
      }
    } finally {
      await environment.database
        .delete(authEmailProjection)
        .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId));
    }
  });

  it('a real second-connection backfill waits for reset user-lock and cannot restore the old hash', async () => {
    const userId = await fixture();
    await synchronize(userId);
    let announceLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      announceLocked = resolve;
    });
    let releaseReset!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const reset = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '3000ms'`);
      await transaction.select().from(users).where(eq(users.id, userId)).for('update');
      announceLocked();
      await release;
      await transaction
        .insert(authSubjectCutoffs)
        .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      await transaction
        .update(userCredentials)
        .set({ passwordHash: replacementHash })
        .where(eq(userCredentials.userId, userId));
      await syncIdentity(transaction, userId, 'current-store-to-authority');
    });
    await locked;
    const backfill = synchronize(userId);
    try {
      const early = await Promise.race([
        backfill.then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75)),
      ]);
      expect(early).toBe('waiting');
    } finally {
      releaseReset();
    }
    await Promise.all([reset, backfill]);
    expect(await canonical(userId)).toMatchObject([{ password: replacementHash, sourceGeneration: 1 }]);
    expect(
      (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0]
        .passwordHash,
    ).toBe(replacementHash);
  });
});
