import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authSession,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from '../../../auth/authority/__tests__/environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../../auth/current-store/foundation-context';
import { countUsersAfter, importIdentityBatch, reconcileIdentities } from '../operations';
import { identityArguments, identityRefusalCode, runImportIdentities } from '../../auth-import-identities';

const key = Buffer.alloc(32, 7);
const authority = Object.freeze({ projectionId: randomUUID(), epoch: 1 });
describe('identity import and reconcile', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
    // The enforced current-store manifest every copy below is checked against.
    await environment.database.insert(authEmailProjection).values({
      projectionId: authority.projectionId,
      isCurrent: true,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      writerEpoch: authority.epoch,
      phase: 'enforced',
      preparedAt: new Date(),
    });
  });
  afterAll(async () => environment?.close());
  it('defaults to the read-only plan, names the write, bounds batches and keeps the cursor private', () => {
    // No verb: each case below names one, or shows what naming none selects.
    const arguments_ = [
      '--confirm-host',
      'localhost',
      '--key-file',
      '/private/key',
      '--checkpoint',
      '/private/checkpoints',
    ];
    expect(identityArguments(arguments_, true)).toMatchObject({ command: 'plan', batch: 200, pauseMs: 100 });
    expect(identityArguments(['plan', ...arguments_], true).command).toBe('plan');
    expect(identityArguments(['import', ...arguments_], true).command).toBe('import');
    expect(() => identityArguments(['apply', ...arguments_], true)).toThrow('INVALID_ARGUMENTS');
    expect(() => identityArguments(['reconcile', ...arguments_], true)).toThrow('INVALID_ARGUMENTS');
    // The `--` vp forwards changes nothing: no verb is still the read-only plan,
    // and the write is selected only by name.
    expect(identityArguments(['--', ...arguments_], true).command).toBe('plan');
    expect(identityArguments(['--', 'import', ...arguments_], true)).toMatchObject({ command: 'import', batch: 200 });
    // Read-only reconcile keeps its verb-free default.
    expect(identityArguments(['--', '--confirm-host', 'localhost', '--key-file', '/private/key'], false).keyFile).toBe(
      '/private/key',
    );
    for (const invalid of [
      ['--batch', '201'],
      ['--batch', '0'],
      ['--pause-ms', '-1'],
      ['--last-user-id', randomUUID()],
    ])
      expect(() => identityArguments(['import', ...arguments_, ...invalid], true)).toThrow();
    expect(() =>
      identityArguments(
        ['--confirm-host', 'localhost', '--key-file', '/private/key', '--checkpoint', '/private/cursor'],
        false,
      ),
    ).toThrow();
  });
  it('never falls back to DATABASE_URL or the operator login, and prints only fixed codes', async () => {
    for (const command of ['plan', 'import'])
      for (const variable of ['DATABASE_URL', 'AUTH_OPERATOR_DATABASE_URL'])
        await expect(
          runImportIdentities(
            [
              command,
              '--confirm-host',
              'localhost',
              '--key-file',
              '/private/key',
              '--checkpoint',
              '/private/checkpoints',
            ],
            { [variable]: 'postgresql://postgres:postgres@localhost/postgres', AUTH_IDENTITY_MIRROR: 'on' },
          ).catch((error: unknown) => identityRefusalCode(error)),
        ).resolves.toBe('CONNECTION_CONFIGURATION_REJECTED');
    expect(identityRefusalCode(Object.assign(new Error('permission denied for table users'), { code: '42501' }))).toBe(
      'SQLSTATE_42501',
    );
    expect(identityRefusalCode(new Error('password authentication failed for user "writer"'))).toBe('UNEXPECTED_ERROR');
    expect(identityRefusalCode('postgres://writer:secret@db.example/x')).toBe('UNEXPECTED_ERROR');
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
    const importing = importIdentityBatch(environment.client, undefined, 1, authority).finally(() => {
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
    expect(await countUsersAfter(environment.client, undefined)).toBe(3);
    const first = await importIdentityBatch(environment.client, undefined, 1, authority);
    expect(first.count).toBe(1);
    expect(await countUsersAfter(environment.client, first.lastUserId)).toBe(2);
    // Process death after commit before checkpoint causes harmless replay.
    await importIdentityBatch(environment.client, undefined, 1, authority);
    await importIdentityBatch(environment.client, first.lastUserId, 200, authority);
    const stored = await environment.database.select().from(authAccount);
    await importIdentityBatch(environment.client, undefined, 200, authority);
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
