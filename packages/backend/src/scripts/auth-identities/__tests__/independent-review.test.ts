import { mkdtempSync, realpathSync, chmodSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { authAccount, userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../../auth/authority/__tests__/environment';
import * as syncModule from '../../../auth/authority/sync-identity';
import { runReconcileIdentities } from '../../auth-reconcile-identities';
import { runImportIdentities } from '../../auth-import-identities';
import { checkpoints, digestKey, keyedDigest } from '../private-state';
import type postgres from 'postgres';
import { importIdentityBatch, reconcileIdentities } from '../operations';
import { operatorConnectionOptions } from '../../auth-fence/operator';
vi.mock('../../auth-authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertAuthorityActivationGates: vi.fn(),
}));
vi.mock('../../../auth/authority/mirror-configuration', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertIdentityMirrorActivationConfiguration: vi.fn(),
}));
let environment: Awaited<ReturnType<typeof createEnvironment>>;
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ba04-independent-')));
chmodSync(folder, 0o700);
const keyFile = join(folder, 'key');
const journal = join(folder, 'journal');
writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
mkdirSync(journal, { mode: 0o700 });
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await environment?.close();
  rmSync(folder, { recursive: true, force: true });
});
it('rolls back a semantic failure after second-user writes and resumes actual private CLI journal', async () => {
  const ids = ['synthetic-review-01', 'synthetic-review-02', 'synthetic-review-03'];
  for (const userId of ids) {
    await environment.database.insert(users).values({ id: userId, email: `${userId}@synthetic.test` });
    await environment.database.insert(userCredentials).values({ userId, passwordHash: 'exact-synthetic-hash' });
  }
  const original = syncModule.syncIdentity;
  const spying = vi.spyOn(syncModule, 'syncIdentity').mockImplementation(async (...arguments_) => {
    await original(...arguments_);
    if (arguments_[1] === ids[1]) throw new Error('SYNTHETIC_SEMANTIC_FAILURE_AFTER_WRITES');
  });
  const url = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  url.pathname = `/${environment.client.options.database}`;
  const settings = { AUTH_OPERATOR_DATABASE_URL: url.toString(), AUTH_IDENTITY_MIRROR: 'on' };
  const arguments_ = [
    '--confirm-host',
    url.hostname,
    '--key-file',
    keyFile,
    '--checkpoint',
    journal,
    '--batch',
    '2',
    '--pause-ms',
    '0',
  ];
  await expect(runImportIdentities(arguments_, settings)).rejects.toThrow('SYNTHETIC_SEMANTIC_FAILURE_AFTER_WRITES');
  const partial = await environment.database.select().from(authAccount);
  expect(partial.map((row) => row.userId)).toEqual([ids[0]]);
  expect(readdirSync(journal)).toHaveLength(0);
  spying.mockRestore();
  expect(await runImportIdentities(arguments_, settings)).toMatchObject({ processed: 3 });
  const complete = await environment.database.select().from(authAccount);
  expect(complete).toHaveLength(3);
  expect(complete.find((row) => row.userId === ids[0])?.id).toBe(partial[0].id);
  expect(readdirSync(journal)).toHaveLength(2);
  const connection = operatorConnectionOptions(settings, url.hostname, true);
  const binding = keyedDigest(digestKey(keyFile), [connection.host, connection.port, connection.database]);
  expect(checkpoints(journal, binding).lastUserId).toBe(ids[2]);
  expect(await runImportIdentities(arguments_, settings)).toMatchObject({ processed: 0 });
});
it('never overwrites a concurrently created checkpoint and keys every digest', () => {
  const privateFolder = join(folder, 'competing-journal');
  mkdirSync(privateFolder, { mode: 0o700 });
  const first = checkpoints(privateFolder, 'synthetic-binding');
  const concurrent = checkpoints(privateFolder, 'synthetic-binding');
  first.save('synthetic-cursor-one');
  expect(() => concurrent.save('synthetic-cursor-two')).toThrow();
  expect(checkpoints(privateFolder, 'synthetic-binding').lastUserId).toBe('synthetic-cursor-one');
  expect(keyedDigest(Buffer.alloc(32, 1), ['synthetic'])).not.toBe(keyedDigest(Buffer.alloc(32, 2), ['synthetic']));
});
it('rejects ambient credentials, wrong hosts, remote insecure TLS, and SQL logging', () => {
  expect(() =>
    operatorConnectionOptions({ DATABASE_URL: 'postgres://ignored@localhost/example' }, 'localhost', false),
  ).toThrow();
  const explicit = { AUTH_OPERATOR_DATABASE_URL: 'postgres://synthetic:synthetic@localhost/example' };
  expect(() => operatorConnectionOptions(explicit, 'wrong-host', false)).toThrow();
  expect(() =>
    operatorConnectionOptions(
      { AUTH_OPERATOR_DATABASE_URL: 'postgres://synthetic:synthetic@remote.test/example?sslmode=disable' },
      'remote.test',
      false,
    ),
  ).toThrow();
  expect(() => operatorConnectionOptions({ ...explicit, DEBUG_SQL: 'true' }, 'localhost', false)).toThrow();
  expect(operatorConnectionOptions(explicit, 'localhost', false).connection.default_transaction_read_only).toBe(true);
});

it('reconciles under a real read-only repeatable-read snapshot', async () => {
  const probe = {
    options: environment.client.options,
    begin: async (settings: string, callback: (connection: postgres.TransactionSql) => Promise<unknown>) =>
      environment.client.begin(settings, async (connection) => {
        const [properties] =
          await connection`SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation`;
        expect(properties).toEqual({ readonly: 'on', isolation: 'repeatable read' });
        return callback(connection);
      }),
  };
  const result = await reconcileIdentities(probe as unknown as postgres.Sql, Buffer.alloc(32, 9));
  expect(result).toMatchObject({ missing: 0, different: 0, unexpected: 0 });
});

it('skips a user deleted between batch selection and its locked source read', async () => {
  const userId = 'zz-synthetic-deleted-after-selection';
  await environment.database.insert(users).values({ id: userId, email: 'synthetic-deletion@synthetic.test' });
  await environment.database.insert(userCredentials).values({ userId, passwordHash: 'synthetic-deleted-hash' });
  const original = syncModule.syncIdentity;
  const spying = vi.spyOn(syncModule, 'syncIdentity').mockImplementation(async (...arguments_) => {
    if (arguments_[1] === userId) await environment.database.delete(users).where(eq(users.id, userId));
    await original(...arguments_);
  });
  try {
    expect(await importIdentityBatch(environment.client, 'synthetic-review-03', 200)).toMatchObject({
      count: 1,
      lastUserId: userId,
    });
    expect(await environment.database.select().from(authAccount).where(eq(authAccount.userId, userId))).toHaveLength(0);
  } finally {
    spying.mockRestore();
  }
});
it('full reconciliation detects new users behind the completed import cursor', async () => {
  const userId = '000-synthetic-created-behind-cursor';
  await environment.database.insert(users).values({ id: userId, email: 'synthetic-new-before-cursor@synthetic.test' });
  await environment.database.insert(userCredentials).values({ userId, passwordHash: 'synthetic-new-hash' });
  const url = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  url.pathname = `/${environment.client.options.database}`;
  const settings = { AUTH_OPERATOR_DATABASE_URL: url.toString(), AUTH_IDENTITY_MIRROR: 'on' };
  try {
    const importing = [
      '--confirm-host',
      url.hostname,
      '--key-file',
      keyFile,
      '--checkpoint',
      journal,
      '--pause-ms',
      '0',
    ];
    expect(await runImportIdentities(importing, settings)).toMatchObject({ processed: 0 });
    const report = await runReconcileIdentities(['--confirm-host', url.hostname, '--key-file', keyFile], settings);
    expect(report).toMatchObject({ users: 4, missing: 1, status: 'not-ready-activation-and-mirror-proof-required' });
    expect(JSON.stringify(report)).not.toContain(userId);
  } finally {
    await environment.database.delete(users).where(eq(users.id, userId));
  }
});
it('reports unexpected canonical rows and a different keyed snapshot digest', async () => {
  const identityId = 'synthetic-unexpected-canonical-review';
  await environment.database.insert(authAccount).values({
    id: identityId,
    userId: 'synthetic-review-01',
    providerId: 'apple',
    accountId: 'synthetic-unexpected-subject',
    sourceGeneration: 0,
  });
  try {
    const report = await reconcileIdentities(environment.client, Buffer.alloc(32, 9));
    expect(report.unexpected).toBe(1);
    expect(report.sourceDigest).not.toBe(report.targetDigest);
  } finally {
    await environment.database.delete(authAccount).where(eq(authAccount.id, identityId));
  }
});
