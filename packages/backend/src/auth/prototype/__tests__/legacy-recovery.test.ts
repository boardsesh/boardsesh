import { createHash, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { createPrototypeLegacyHandler } from '../legacy-bridge';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { prototypeRecoveryCutoffId } from '../legacy-recovery-state';
import {
  bindPrototypeLegacyRecoveryLinks,
  createPrototypeLegacyRecoveryFacade,
  PrototypeLegacyRecoveryError,
  type PrototypeLegacyRecoverySnapshot,
  type PrototypeRecoveryPurpose,
} from '../legacy-recovery';

type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
const ORIGINAL_PASSWORD = 'original-recovery-password';
const NEXT_PASSWORD = ' café-山-🧗-new-password ';
const NATIVE_KEY = new TextEncoder().encode('disposable-legacy-recovery-native-signing-key');
let environment: Environment;
let cutoverAt: Date;
let originalPasswordHash: string;

async function fixture(
  purpose: PrototypeRecoveryPurpose,
  overrides: { originalEmail?: string; verifiedAt?: Date | null } = {},
) {
  const userId = randomUUID();
  const originalEmail = overrides.originalEmail ?? `${userId}@example.test`;
  const canonicalEmail = originalEmail.trim().toLowerCase();
  const verifiedAt = overrides.verifiedAt ?? null;
  await environment.database.insert(environment.schema.user).values({
    id: userId,
    name: 'Legacy recovery fixture',
    email: canonicalEmail,
    emailVerified: verifiedAt !== null,
    legacyEmailVerifiedAt: verifiedAt,
  });
  await environment.database.insert(environment.schema.account).values({
    id: randomUUID(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: originalPasswordHash,
  });
  const token = randomUUID();
  const record = {
    identifier: purpose === 'password-reset' ? `password-reset:${originalEmail}` : originalEmail,
    token: purpose === 'password-reset' ? createHash('sha256').update(token).digest('hex') : token,
    expires: new Date(cutoverAt.getTime() + (purpose === 'password-reset' ? 1200000 : 7200000)),
  };
  const snapshot: PrototypeLegacyRecoverySnapshot = {
    users: [{ id: userId, email: originalEmail }],
    records: [record],
    ownership: [
      {
        identifier: record.identifier,
        storedToken: record.token,
        originalUserId: userId,
        source: 'captured-at-issuance',
      },
    ],
  };
  return { userId, originalEmail, canonicalEmail, token, record, snapshot };
}

async function passwordMatches(userId: string, password: string) {
  const [account] = await environment.database
    .select()
    .from(environment.schema.account)
    .where(eq(environment.schema.account.userId, userId));
  return compare(password, account.password!);
}

async function holdLifecycleFence() {
  let announceEntered!: () => void;
  let releaseFence!: () => void;
  const entered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const closed = environment.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
    announceEntered();
    await released;
  });
  await Promise.race([entered, closed]);
  return { release: releaseFence, closed };
}

describe('bounded legacy email-keyed recovery through one canonical authority', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    cutoverAt = new Date();
    originalPasswordHash = await hash(ORIGINAL_PASSWORD, 4);
  });
  afterAll(async () => environment?.close());

  it('preserves old reset secrets after normalization and revokes canonical native descendants', async () => {
    const legacy = await fixture('password-reset', { originalEmail: ` MiXeD-${randomUUID()}@Example.Test ` });
    const sourceBefore = JSON.stringify(legacy.snapshot);
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt)).toEqual({
      bound: 1,
      rejected: 0,
    });
    const native = createPrototypeNativeFacade(environment.database, NATIVE_KEY);
    const pair = await native.credentials(legacy.canonicalEmail, ORIGINAL_PASSWORD);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    expect(
      await facade.resetPassword({
        email: legacy.originalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).toEqual({ status: true, userId: legacy.userId });
    expect(await passwordMatches(legacy.userId, NEXT_PASSWORD)).toBe(true);
    expect(await passwordMatches(legacy.userId, NEXT_PASSWORD.trim())).toBe(false);
    expect(await passwordMatches(legacy.userId, ORIGINAL_PASSWORD)).toBe(false);
    expect(await native.validateAccessToken(pair.jwt)).toBeNull();
    await expect(native.refresh(pair.refreshToken)).rejects.toThrow();
    expect(JSON.stringify(legacy.snapshot)).toBe(sourceBefore);
    const [user] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, legacy.userId));
    expect(user.emailVerified).toBe(true);
    expect(user.legacyEmailVerifiedAt).toBeInstanceOf(Date);
  });

  it('keeps original expiry immutable and stores no presented legacy secret in the bound record', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const extended = { ...legacy.record, expires: new Date(legacy.record.expires.getTime() + 1000) };
    expect(
      await bindPrototypeLegacyRecoveryLinks(
        environment.database,
        { ...legacy.snapshot, records: [extended] },
        cutoverAt,
      ),
    ).toEqual({ bound: 0, rejected: 1 });
    const bindings = await environment.database.select().from(environment.schema.verification);
    const binding = bindings.find((record) => record.value.includes(legacy.userId));
    expect(binding?.expiresAt).toEqual(legacy.record.expires);
    expect(binding?.value).not.toContain(legacy.token);
    expect(binding?.value).not.toContain(legacy.record.token);
  });

  it('delegates adding a password for a proven OAuth-only account to Better Auth', async () => {
    const legacy = await fixture('password-reset');
    await environment.database
      .delete(environment.schema.account)
      .where(eq(environment.schema.account.userId, legacy.userId));
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await facade.resetPassword({
      email: legacy.canonicalEmail,
      token: legacy.token,
      password: NEXT_PASSWORD,
      confirmPassword: NEXT_PASSWORD,
    });
    expect(await passwordMatches(legacy.userId, NEXT_PASSWORD)).toBe(true);
    const [account] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, legacy.userId));
    expect(account.providerId).toBe('credential');
    expect(account.accountId).toBe(legacy.userId);
  });

  it('accepts raw UUID verification once and leaves existing verification timestamps unchanged', async () => {
    const verifiedAt = new Date('2024-01-02T03:04:05Z');
    const legacy = await fixture('email-verification', { verifiedAt });
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt)).toMatchObject({
      bound: 1,
    });
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    expect(await facade.verifyEmail({ email: legacy.canonicalEmail.toUpperCase(), token: legacy.token })).toMatchObject(
      { status: true },
    );
    await expect(facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token })).rejects.toBeInstanceOf(
      PrototypeLegacyRecoveryError,
    );
    const [user] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, legacy.userId));
    expect(user.legacyEmailVerifiedAt).toEqual(verifiedAt);
    expect(await passwordMatches(legacy.userId, ORIGINAL_PASSWORD)).toBe(true);
  });

  it('verification changes only its proven user and preserves ordinary canonical sessions', async () => {
    const legacy = await fixture('email-verification');
    const unrelated = await fixture('email-verification');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const native = createPrototypeNativeFacade(environment.database, NATIVE_KEY);
    const existing = await native.credentials(legacy.canonicalEmail, ORIGINAL_PASSWORD);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token });
    expect(await native.validateAccessToken(existing.jwt)).toMatchObject({ userId: legacy.userId });
    const [other] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, unrelated.userId));
    expect(other.emailVerified).toBe(false);
  });

  it.each(['password-reset', 'email-verification'] as const)(
    'atomically consumes %s once across two independent facades',
    async (purpose) => {
      const legacy = await fixture(purpose);
      await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
      const invoke = (facade: ReturnType<typeof createPrototypeLegacyRecoveryFacade>) =>
        purpose === 'password-reset'
          ? facade.resetPassword({
              email: legacy.canonicalEmail,
              token: legacy.token,
              password: NEXT_PASSWORD,
              confirmPassword: NEXT_PASSWORD,
            })
          : facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token });
      const results = await Promise.allSettled([
        invoke(createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt)),
        invoke(createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt)),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(PrototypeLegacyRecoveryError);
    },
  );

  it('keeps consumed-link tombstones after handler recreation and repeated import', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const original = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await original.resetPassword({
      email: legacy.canonicalEmail,
      token: legacy.token,
      password: NEXT_PASSWORD,
      confirmPassword: NEXT_PASSWORD,
    });
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt)).toEqual({
      bound: 0,
      rejected: 1,
    });
    const restarted = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      restarted.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: 'replayed-password',
        confirmPassword: 'replayed-password',
      }),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    expect(await passwordMatches(legacy.userId, NEXT_PASSWORD)).toBe(true);
  });

  it('rejects a wrong secret without deleting the valid link', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: randomUUID(),
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: true });
  });

  it.each(['password-reset', 'email-verification'] as const)(
    'refuses %s for another request address',
    async (purpose) => {
      const legacy = await fixture(purpose);
      const other = await fixture(purpose);
      await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
      const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
      const attempt =
        purpose === 'password-reset'
          ? facade.resetPassword({
              email: other.canonicalEmail,
              token: legacy.token,
              password: NEXT_PASSWORD,
              confirmPassword: NEXT_PASSWORD,
            })
          : facade.verifyEmail({ email: other.canonicalEmail, token: legacy.token });
      await expect(attempt).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
      expect(await passwordMatches(other.userId, ORIGINAL_PASSWORD)).toBe(true);
    },
  );

  it('never treats a reset hash as a raw verification secret or exchanges purposes', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token })).rejects.toBeInstanceOf(
      PrototypeLegacyRecoveryError,
    );
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.record.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
  });

  it('refuses ambiguous normalized owners instead of selecting the first account', async () => {
    const legacy = await fixture('password-reset');
    const snapshot: PrototypeLegacyRecoverySnapshot = {
      ...legacy.snapshot,
      users: [...legacy.snapshot.users, { id: randomUUID(), email: ` ${legacy.canonicalEmail.toUpperCase()} ` }],
    };
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, cutoverAt)).toEqual({
      bound: 0,
      rejected: 1,
    });
  });

  it('refuses missing, conflicting or wrong-account historical ownership evidence', async () => {
    const legacy = await fixture('password-reset');
    const ownershipVariants = [
      [],
      [legacy.snapshot.ownership[0], legacy.snapshot.ownership[0]],
      [{ ...legacy.snapshot.ownership[0], originalUserId: randomUUID() }],
    ];
    for (const ownership of ownershipVariants) {
      expect(
        await bindPrototypeLegacyRecoveryLinks(environment.database, { ...legacy.snapshot, ownership }, cutoverAt),
      ).toEqual({ bound: 0, rejected: 1 });
    }
  });

  it('cannot reset a new address owner after the original user changes email', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    await environment.database
      .update(environment.schema.user)
      .set({ email: `${randomUUID()}@example.test` })
      .where(eq(environment.schema.user.id, legacy.userId));
    const replacement = await fixture('password-reset', { originalEmail: legacy.canonicalEmail });
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    expect(await passwordMatches(replacement.userId, ORIGINAL_PASSWORD)).toBe(true);
  });

  it('cannot verify a new address owner after deletion of the bound original user', async () => {
    const legacy = await fixture('email-verification');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, legacy.userId));
    const replacement = await fixture('email-verification', { originalEmail: legacy.canonicalEmail });
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token })).rejects.toBeInstanceOf(
      PrototypeLegacyRecoveryError,
    );
    const [user] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, replacement.userId));
    expect(user.emailVerified).toBe(false);
  });

  it.each(['password-reset', 'email-verification'] as const)(
    'superseding %s also blocks delayed imports of old links',
    async (purpose) => {
      const legacy = await fixture(purpose);
      const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
      await facade.supersede(legacy.userId, purpose);
      expect(await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt)).toEqual({
        bound: 0,
        rejected: 1,
      });
    },
  );

  it('rejects imported expired and overlong legacy records', async () => {
    const legacy = await fixture('password-reset');
    for (const expires of [new Date(cutoverAt.getTime() - 1), new Date(cutoverAt.getTime() + 3600001)]) {
      expect(
        await bindPrototypeLegacyRecoveryLinks(
          environment.database,
          { ...legacy.snapshot, records: [{ ...legacy.record, expires }] },
          cutoverAt,
        ),
      ).toEqual({ bound: 0, rejected: 1 });
    }
  });

  it('checks source expiry again at consumption rather than trusting import success', async () => {
    const legacy = await fixture('email-verification');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const bindings = await environment.database.select().from(environment.schema.verification);
    const binding = bindings.find(
      (record) => record.value.includes(legacy.userId) && record.value.includes('prototype-legacy-recovery'),
    );
    expect(binding).toBeDefined();
    await environment.database
      .update(environment.schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(environment.schema.verification.id, binding!.id));
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token })).rejects.toBeInstanceOf(
      PrototypeLegacyRecoveryError,
    );
  });

  it('delegates password policy and leaves the original link retryable after validation failure', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: 'short',
        confirmPassword: 'short',
      }),
    ).rejects.toThrow();
    expect(await passwordMatches(legacy.userId, ORIGINAL_PASSWORD)).toBe(true);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: true });
  });

  it('rolls back binding consumption, password, verification and cutoff on a post-mutation failure', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    let reachedFailure = false;
    const failing = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt, async () => {
      reachedFailure = true;
      throw new Error('Synthetic failure after canonical recovery');
    });
    await expect(
      failing.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).rejects.toThrow('Synthetic failure');
    expect(reachedFailure).toBe(true);
    expect(await passwordMatches(legacy.userId, ORIGINAL_PASSWORD)).toBe(true);
    const [user] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, legacy.userId));
    expect(user.emailVerified).toBe(false);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, legacy.userId)),
    ).toHaveLength(0);
    for (const purpose of ['password-reset', 'email-verification'] as const) {
      expect(
        await environment.database
          .select()
          .from(environment.schema.verification)
          .where(eq(environment.schema.verification.id, prototypeRecoveryCutoffId(legacy.userId, purpose))),
      ).toHaveLength(0);
    }
    await expect(
      createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt).resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: true });
  });

  it.each(['password-reset', 'email-verification'] as const)(
    'canonical password reset invalidates an older bound %s link',
    async (purpose) => {
      const legacy = await fixture(purpose);
      await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
      const currentToken = randomUUID();
      await environment.database.insert(environment.schema.verification).values({
        id: randomUUID(),
        identifier: `reset-password:${currentToken}`,
        value: legacy.userId,
        expiresAt: new Date(Date.now() + 60000),
      });
      const handler = createPrototypeLegacyHandler(environment.database);
      const canonicalReset = await handler(
        new Request(`${PROTOTYPE_ISSUER}/reset-password`, {
          method: 'POST',
          headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
          body: JSON.stringify({ token: currentToken, newPassword: 'canonical-latest-password' }),
        }),
      );
      expect(canonicalReset.status).toBe(200);
      const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
      const oldAttempt =
        purpose === 'password-reset'
          ? facade.resetPassword({
              email: legacy.canonicalEmail,
              token: legacy.token,
              password: NEXT_PASSWORD,
              confirmPassword: NEXT_PASSWORD,
            })
          : facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token });
      await expect(oldAttempt).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
      expect(await passwordMatches(legacy.userId, 'canonical-latest-password')).toBe(true);
    },
  );

  it.each(['password-reset', 'email-verification'] as const)(
    'a different caller-selected cutover cannot bypass %s supersession',
    async (purpose) => {
      const legacy = await fixture(purpose);
      await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
      const original = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
      await original.supersede(legacy.userId, purpose);
      const alternateCutover = new Date(cutoverAt.getTime() + 1000);
      await expect(
        bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, alternateCutover),
      ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
      const restarted = createPrototypeLegacyRecoveryFacade(environment.database, alternateCutover);
      const attempt =
        purpose === 'password-reset'
          ? restarted.resetPassword({
              email: legacy.canonicalEmail,
              token: legacy.token,
              password: NEXT_PASSWORD,
              confirmPassword: NEXT_PASSWORD,
            })
          : restarted.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token });
      await expect(attempt).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    },
  );

  it('ordinary native logout preserves an otherwise valid mailbox recovery link', async () => {
    const legacy = await fixture('password-reset');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const native = createPrototypeNativeFacade(environment.database, NATIVE_KEY);
    const pair = await native.credentials(legacy.canonicalEmail, ORIGINAL_PASSWORD);
    await native.revoke(pair.refreshToken);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: true, userId: legacy.userId });
  });

  it('a delayed import racing a canonical reset cannot leave the old link usable', async () => {
    const legacy = await fixture('password-reset');
    const currentToken = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: randomUUID(),
      identifier: `reset-password:${currentToken}`,
      value: legacy.userId,
      expiresAt: new Date(Date.now() + 60000),
    });
    const handler = createPrototypeLegacyHandler(environment.database);
    const [importResult, reset] = await Promise.all([
      bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt),
      handler(
        new Request(`${PROTOTYPE_ISSUER}/reset-password`, {
          method: 'POST',
          headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
          body: JSON.stringify({ token: currentToken, newPassword: 'canonical-racing-import-password' }),
        }),
      ),
    ]);
    expect(importResult.bound + importResult.rejected).toBe(1);
    expect(reset.status).toBe(200);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      facade.resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    expect(await passwordMatches(legacy.userId, 'canonical-racing-import-password')).toBe(true);
  });

  it('a later caller boundary cannot reclassify an originally overlong link', async () => {
    const legacy = await fixture('password-reset');
    const snapshot = {
      ...legacy.snapshot,
      records: [{ ...legacy.record, expires: new Date(cutoverAt.getTime() + 3600001) }],
    };
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, cutoverAt)).toEqual({
      bound: 0,
      rejected: 1,
    });
    await expect(
      bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, new Date(cutoverAt.getTime() + 1000)),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
  });

  it('expired verification cleanup cannot reopen a later recovery epoch', async () => {
    const legacy = await fixture('email-verification');
    const snapshot = {
      ...legacy.snapshot,
      records: [{ ...legacy.record, expires: new Date(cutoverAt.getTime() + 26 * 3600000) }],
    };
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, cutoverAt)).toMatchObject({
      bound: 0,
      rejected: 1,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(cutoverAt.getTime() + 25 * 3600000);
      // A real Better Auth reset lookup runs its ordinary expired-record cleanup.
      await expect(
        environment.auth.api.resetPassword({ body: { token: randomUUID(), newPassword: NEXT_PASSWORD } }),
      ).rejects.toThrow();
      await expect(
        bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, new Date(Date.now() - 1)),
      ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
      await expect(
        createPrototypeLegacyRecoveryFacade(environment.database, new Date(Date.now() - 1)).verifyEmail({
          email: legacy.canonicalEmail,
          token: legacy.token,
        }),
      ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects future migration boundaries before importing or constructing a facade', async () => {
    const legacy = await fixture('password-reset');
    const futureCutover = new Date(Date.now() + 3600000);
    await expect(
      bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, futureCutover),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    expect(() => createPrototypeLegacyRecoveryFacade(environment.database, futureCutover)).toThrow(
      PrototypeLegacyRecoveryError,
    );
  });

  it('captures the original migration date and source expiry before waiting for the lifecycle fence', async () => {
    const legacy = await fixture('email-verification');
    const boundary = new Date(cutoverAt);
    const originalExpiry = new Date(legacy.record.expires);
    const fence = await holdLifecycleFence();
    const pending = bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, boundary);
    boundary.setTime(boundary.getTime() + 24 * 3600000);
    legacy.record.expires.setTime(legacy.record.expires.getTime() + 365 * 24 * 3600000);
    fence.release();
    await fence.closed;
    expect(await pending).toMatchObject({ bound: 1, rejected: 0 });
    const bindings = await environment.database.select().from(environment.schema.verification);
    const binding = bindings.find(
      (record) => record.value.includes(legacy.userId) && record.value.includes('prototype-legacy-recovery'),
    );
    expect(binding?.expiresAt).toEqual(originalExpiry);
    await expect(
      createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt).verifyEmail({
        email: legacy.canonicalEmail,
        token: legacy.token,
      }),
    ).resolves.toMatchObject({ status: true, userId: legacy.userId });
  });

  it('cannot repair invalid owner evidence or expiry while an import waits for the lifecycle fence', async () => {
    const legacy = await fixture('password-reset');
    const unrelated = await fixture('password-reset');
    const snapshot = {
      users: [{ ...legacy.snapshot.users[0], id: unrelated.userId }],
      records: [{ ...legacy.record, expires: new Date(cutoverAt.getTime() + 3600001) }],
      ownership: [{ ...legacy.snapshot.ownership[0], originalUserId: unrelated.userId }],
    };
    const fence = await holdLifecycleFence();
    const pending = bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, cutoverAt);
    snapshot.users[0].id = legacy.userId;
    snapshot.ownership[0].originalUserId = legacy.userId;
    snapshot.records[0].expires.setTime(legacy.record.expires.getTime());
    fence.release();
    await fence.closed;
    expect(await pending).toEqual({ bound: 0, rejected: 1 });
    await expect(
      createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt).resetPassword({
        email: legacy.canonicalEmail,
        token: legacy.token,
        password: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(PrototypeLegacyRecoveryError);
    expect(await passwordMatches(legacy.userId, ORIGINAL_PASSWORD)).toBe(true);
    expect(await passwordMatches(unrelated.userId, ORIGINAL_PASSWORD)).toBe(true);
  });

  it('a mutable Date argument cannot change an already constructed facade boundary', async () => {
    const legacy = await fixture('email-verification');
    await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt);
    const boundary = new Date(cutoverAt);
    const facade = createPrototypeLegacyRecoveryFacade(environment.database, boundary);
    boundary.setTime(boundary.getTime() + 1000);
    await expect(facade.supersede(legacy.userId, 'email-verification')).resolves.toBeUndefined();
    await expect(facade.verifyEmail({ email: legacy.canonicalEmail, token: legacy.token })).rejects.toBeInstanceOf(
      PrototypeLegacyRecoveryError,
    );
  });
});
