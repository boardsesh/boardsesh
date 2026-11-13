import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type PasswordCommand } from '@boardsesh/auth-protocol';
import { users, authAccount, userCredentials, authSubjectCutoffs, authEmailProjection } from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { authenticateWebPassword } from '../../current-store/web-password';
import { syncIdentity } from '../sync-identity';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import * as authorityFactory from '../authority';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
  emailVerificationEnabled: true,
};
const password = ' exact web password ';
async function fixture() {
  const userId = randomUUID();
  const email = `web-${userId}@example.com`;
  const createdAt = new Date('2020-01-01T00:00:00Z');
  const passwordHash = await hash(password, 4);
  await environment.database.insert(users).values({ id: userId, email, name: null, createdAt, emailVerified: null });
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    await reserveEnforcedEmail(transaction, {
      ...authority,
      expectedWriterEpoch: manifest.writerEpoch,
      rawEmail: email,
      requestedUserId: userId,
    });
    await transaction.insert(userCredentials).values({ userId, passwordHash });
    await syncIdentity(transaction, userId, 'current-store-to-authority');
  });
  return { userId, email, createdAt, passwordHash };
}
async function switchTo(to: IdentityAuthorityName) {
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    if (manifest.writerAuthority !== to)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to,
      });
  });
}
function command(email: string, submittedPassword = password): PasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    credentialProofVersion: 1,
    payload: { email, password: submittedPassword },
  };
}
describe('selected authority web password proof', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-web-password-retired-mailbox-key-6975');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await switchTo('current-store');
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const)
    it(`${selected} preserves proof/reply/name/verification and exact password bytes`, async () => {
      const owner = await fixture();
      await switchTo(selected);
      const startedAt = Date.now();
      const reply = await authenticateWebPassword(environment.database, authority, command(owner.email.toUpperCase()));
      expect(reply.outcome).toBe('authenticated');
      if (reply.outcome !== 'authenticated') throw new Error('Missing web password proof');
      expect(reply.user).toEqual({ id: owner.userId, email: owner.email, name: null, image: null });
      expect(reply.verification).toEqual({ userId: owner.userId, required: true, verified: false });
      expect(reply.credentialProof).toMatchObject({ userId: owner.userId, generation: 0, linkGuarded: true });
      expect(Date.parse(reply.credentialProof!.authenticatedAt!)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(reply.credentialProof!.authenticatedAt!)).toBeLessThanOrEqual(Date.now());
      expect(
        (await authenticateWebPassword(environment.database, authority, command(owner.email, password.trim()))).outcome,
      ).toBe('invalid_credentials');
      expect((await environment.database.select().from(users).where(eq(users.id, owner.userId)))[0].createdAt).toEqual(
        owner.createdAt,
      );
    });
  it('uses the actual configured canonical verifier outside transactions and ignores stale legacy password', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    const canonicalHash = await hash(' canonical web password ', 4);
    await environment.database
      .update(authAccount)
      .set({ password: canonicalHash })
      .where(eq(authAccount.userId, owner.userId));
    const actual = authorityFactory.verifyAuthorityPassword;
    const verifier = vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementation(async (proof) => {
      // If bcrypt held the gate, this real exclusive switch would time out.
      await switchTo('current-store');
      await switchTo('better-auth');
      return actual(proof);
    });
    await expect(
      authenticateWebPassword(environment.database, authority, command(owner.email, ' canonical web password ')),
    ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
    expect(verifier).toHaveBeenCalledWith({ hash: canonicalHash, password: ' canonical web password ' });
    verifier.mockRestore();
    expect(
      (await authenticateWebPassword(environment.database, authority, command(owner.email, ' canonical web password ')))
        .outcome,
    ).toBe('authenticated');
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'invalid_credentials',
    );
  });
  it('rejects primary hash drift after actual bcrypt and admits a fresh command', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    const nextHash = await hash(' next web password ', 4);
    const actual = authorityFactory.verifyAuthorityPassword;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (proof) => {
      const verified = await actual(proof);
      await environment.database
        .update(authAccount)
        .set({ password: nextHash })
        .where(eq(authAccount.userId, owner.userId));
      return verified;
    });
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'invalid_credentials',
    );
    expect(
      (await authenticateWebPassword(environment.database, authority, command(owner.email, ' next web password ')))
        .outcome,
    ).toBe('authenticated');
  });
  it('refuses unqualified source-generation and never stamps it with a later cutoff', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: owner.userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
    await expect(authenticateWebPassword(environment.database, authority, command(owner.email))).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });
  });
  it('rejects a generation-only change committed after actual bcrypt, without restamping the proof', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    const actual = authorityFactory.verifyAuthorityPassword;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (proof) => {
      const verified = await actual(proof);
      await environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT id FROM users WHERE id = ${owner.userId} FOR UPDATE`);
        await transaction
          .insert(authSubjectCutoffs)
          .values({ userId: owner.userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
        await transaction.update(authAccount).set({ sourceGeneration: 1 }).where(eq(authAccount.userId, owner.userId));
      });
      return verified;
    });
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'invalid_credentials',
    );
    const fresh = await authenticateWebPassword(environment.database, authority, command(owner.email));
    expect(fresh.outcome).toBe('authenticated');
    if (fresh.outcome !== 'authenticated') throw new Error('Missing fresh web proof');
    expect(fresh.credentialProof?.generation).toBe(1);
  });
  it('refuses SQL debug logging before touching any database method', async () => {
    const transaction = vi.spyOn(environment.database, 'transaction');
    vi.stubEnv('DEBUG_SQL', 'true');
    await expect(
      authenticateWebPassword(environment.database, authority, command('synthetic@example.com')),
    ).rejects.toThrow('Web authentication unavailable');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rechecks the primary after the real user KEY SHARE wait', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    const actual = authorityFactory.verifyAuthorityPassword;
    const nextHash = await hash(' lock-race password ', 4);
    let releaseWriter!: () => void;
    let writerReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      writerReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writer: Promise<void> | undefined;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (proof) => {
      const verified = await actual(proof);
      writer = environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT id FROM users WHERE id = ${owner.userId} FOR UPDATE`);
        await transaction.update(authAccount).set({ password: nextHash }).where(eq(authAccount.userId, owner.userId));
        writerReady();
        await release;
      });
      await ready;
      return verified;
    });
    const pending = authenticateWebPassword(environment.database, authority, command(owner.email));
    try {
      await ready;
      const deadline = Date.now() + 2000;
      while (!(await environment.hasWaitingUserKeyShare())) {
        if (Date.now() > deadline) throw new Error('Expected owned user lock wait');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      releaseWriter();
      await writer;
      expect((await pending).outcome).toBe('invalid_credentials');
    } finally {
      releaseWriter();
      await writer;
    }
  });
  it('never falls back to legacy when the canonical credential is absent, then admits its restoration', async () => {
    const owner = await fixture();
    const [saved] = await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId));
    await switchTo('better-auth');
    await environment.database.delete(authAccount).where(eq(authAccount.id, saved.id));
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'invalid_credentials',
    );
    await environment.database.insert(authAccount).values(saved);
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'authenticated',
    );
  });
  it('refuses a non-normalized canonical address invariant, then admits repaired fixture data', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    await environment.database
      .update(users)
      .set({ email: owner.email.toUpperCase() })
      .where(eq(users.id, owner.userId));
    try {
      await expect(
        authenticateWebPassword(environment.database, authority, command(owner.email)),
      ).rejects.toMatchObject({ code: 'RESERVATION_INCONSISTENT' });
    } finally {
      await environment.database.update(users).set({ email: owner.email }).where(eq(users.id, owner.userId));
    }
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'authenticated',
    );
  });
  it('rejects a newly ambiguous canonical cohort committed after actual bcrypt, then admits after cleanup', async () => {
    const owner = await fixture();
    const otherId = randomUUID();
    await switchTo('better-auth');
    const actual = authorityFactory.verifyAuthorityPassword;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (proof) => {
      const verified = await actual(proof);
      await environment.database.transaction(async (transaction) => {
        await transaction.insert(users).values({ id: otherId, email: owner.email });
        await transaction.insert(authAccount).values({
          id: randomUUID(),
          userId: otherId,
          providerId: 'credential',
          accountId: otherId,
          password: owner.passwordHash,
          sourceGeneration: 0,
        });
      });
      return verified;
    });
    try {
      expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
        'invalid_credentials',
      );
    } finally {
      await environment.database.delete(users).where(eq(users.id, otherId));
    }
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'authenticated',
    );
  });
  it('bounds a real canonical user-lock timeout and admits a fresh retry after release', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    const actual = authorityFactory.verifyAuthorityPassword;
    let releaseWriter = () => {};
    let writerReady = () => {};
    const ready = new Promise<void>((resolve) => {
      writerReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writer: Promise<void> | undefined;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (proof) => {
      const verified = await actual(proof);
      writer = environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT id FROM users WHERE id = ${owner.userId} FOR UPDATE`);
        writerReady();
        await release;
      });
      await ready;
      return verified;
    });
    const startedAt = Date.now();
    const pending = authenticateWebPassword(environment.database, authority, command(owner.email));
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await ready;
      let observedWait = false;
      const deadline = Date.now() + 1000;
      while (!settled && Date.now() < deadline) {
        if (await environment.hasWaitingUserKeyShare()) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(observedWait).toBe(true);
      await expect(pending).rejects.toMatchObject({ cause: { code: '55P03' } });
      expect(Date.now() - startedAt).toBeLessThan(1500);
    } finally {
      releaseWriter();
      await writer;
      await pending.catch(() => {});
    }
    expect((await authenticateWebPassword(environment.database, authority, command(owner.email))).outcome).toBe(
      'authenticated',
    );
  });
  it('admits canonical sign-in while an unrelated NO KEY UPDATE row lock remains held', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    let releaseWriter = () => {};
    let writerReady = () => {};
    const ready = new Promise<void>((resolve) => {
      writerReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT id FROM users WHERE id = ${owner.userId} FOR NO KEY UPDATE`);
      writerReady();
      await release;
    });
    await ready;
    try {
      await expect(
        authenticateWebPassword(environment.database, authority, command(owner.email)),
      ).resolves.toMatchObject({ outcome: 'authenticated' });
    } finally {
      releaseWriter();
      await writer;
    }
  });

  it('executes configured bcrypt with no open transaction and admits correct credentials', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    let idleTransactions: number | undefined;
    const actual = authorityFactory.verifyAuthorityPassword;
    vi.spyOn(authorityFactory, 'verifyAuthorityPassword').mockImplementationOnce(async (proof) => {
      const [state] = await environment.client<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`;
      idleTransactions = state.count;
      return actual(proof);
    });
    const reply = await authenticateWebPassword(environment.database, authority, command(owner.email));
    expect(reply.outcome).toBe('authenticated');
    expect(idleTransactions).toBe(0);
  });
});
