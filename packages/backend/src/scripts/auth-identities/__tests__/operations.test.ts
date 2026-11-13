import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { accounts, authAccount, authSession, authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../../auth/authority/__tests__/environment';
import { importIdentityBatch, reconcileIdentities } from '../operations';
import { identityArguments, runImportIdentities } from '../../auth-import-identities';

const key = Buffer.alloc(32, 7);
describe('identity import and reconcile', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  it('bounds batches and requires private cursor rather than a user ID argument', () => {
    const arguments_ = [
      '--confirm-host',
      'localhost',
      '--key-file',
      '/private/key',
      '--checkpoint',
      '/private/checkpoints',
    ];
    expect(identityArguments(arguments_, true).batch).toBe(200);
    for (const invalid of [
      ['--batch', '201'],
      ['--pause-ms', '-1'],
      ['--last-user-id', randomUUID()],
    ])
      expect(() => identityArguments([...arguments_, ...invalid], true)).toThrow();
    expect(() =>
      identityArguments(
        ['--confirm-host', 'localhost', '--key-file', '/private/key', '--checkpoint', '/private/cursor'],
        false,
      ),
    ).toThrow();
  });
  it('never falls back to DATABASE_URL', async () => {
    await expect(
      runImportIdentities(
        ['--confirm-host', 'localhost', '--key-file', '/private/key', '--checkpoint', '/private/checkpoints'],
        { DATABASE_URL: 'postgresql://postgres:postgres@localhost/postgres' },
      ),
    ).rejects.toThrow();
  });
  it('waits for a reset and provider link, then reads the committed source under its user lock', async () => {
    const userId = '00000000-0000-0000-0000-000000000001';
    await environment.database.insert(users).values({ id: userId, email: 'race@synthetic.test' });
    await environment.database.insert(userCredentials).values({ userId, passwordHash: 'old-hash' });
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reset = environment.database.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, userId)).for('update');
      await transaction
        .update(userCredentials)
        .set({ passwordHash: 'new-hash' })
        .where(eq(userCredentials.userId, userId));
      await transaction
        .insert(authSubjectCutoffs)
        .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      await transaction
        .insert(accounts)
        .values({ userId, provider: 'apple', providerAccountId: 'linked-during-import', type: 'oauth' });
      signalLocked();
      await held;
    });
    await locked;
    let completed = false;
    const importing = importIdentityBatch(environment.client, undefined, 1).finally(() => {
      completed = true;
    });
    await pause(50);
    const completedWhileLocked = completed;
    release();
    await reset;
    await importing;
    expect(completedWhileLocked).toBe(false);
    expect(await environment.database.select().from(authAccount).where(eq(authAccount.userId, userId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'credential', password: 'new-hash', sourceGeneration: 1 }),
        expect.objectContaining({ providerId: 'apple', accountId: 'linked-during-import', sourceGeneration: 1 }),
      ]),
    );
    await environment.database.delete(users).where(eq(users.id, userId));
  });
  it('resumes after a committed partial batch, reruns without row churn, and reports drift without PII', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const verified = new Date('2021-02-03T04:05:06.000Z');
    for (const userId of ids) {
      await environment.database
        .insert(users)
        .values({ id: userId, email: `${userId}@synthetic.test`, emailVerified: verified });
      await environment.database
        .insert(userCredentials)
        .values({ userId, passwordHash: '$2b$12$exact-synthetic-bcrypt' });
    }
    await environment.database.insert(accounts).values({
      userId: ids[0],
      provider: 'facebook',
      providerAccountId: 'Exact:Facebook:Subject',
      type: 'oauth',
      access_token: 'never-copy',
    });
    const before = await reconcileIdentities(environment.client, key);
    expect(before.missing).toBe(4);
    const first = await importIdentityBatch(environment.client, undefined, 1);
    expect(first.count).toBe(1);
    // Process death after commit before checkpoint causes harmless replay.
    await importIdentityBatch(environment.client, undefined, 1);
    await importIdentityBatch(environment.client, first.lastUserId, 200);
    const stored = await environment.database.select().from(authAccount);
    await importIdentityBatch(environment.client, undefined, 200);
    expect(await environment.database.select().from(authAccount)).toEqual(stored);
    const result = await reconcileIdentities(environment.client, key);
    expect(result).toMatchObject({ missing: 0, different: 0, unexpected: 0, sourceRows: 4, targetRows: 4 });
    expect(result.sourceDigest).toBe(result.targetDigest);
    expect(JSON.stringify(result)).not.toContain(ids[0]);
    expect(await environment.database.select().from(authSession)).toHaveLength(0);
    expect(stored.find((entry) => entry.providerId === 'facebook')).toMatchObject({
      accountId: 'Exact:Facebook:Subject',
      accessToken: null,
    });
    expect((await environment.database.select().from(users).where(eq(users.id, ids[0])))[0].emailVerified).toEqual(
      verified,
    );
    await environment.database
      .update(userCredentials)
      .set({ passwordHash: 'changed-after-import' })
      .where(eq(userCredentials.userId, ids[0]));
    expect((await reconcileIdentities(environment.client, key)).different).toBe(1);
  });
});
