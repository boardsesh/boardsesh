import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authSession,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { fencePlan, readFenceCatalog, verifyFence } from '@boardsesh/db/auth-web-acl';
import {
  createCredentialWriterEnvironment,
  ownedCredentialProofUrl,
} from '../../../auth/authority/__tests__/fixtures/credential-writer-environment';
import { prepareProjectionUnderUsersTableLock } from '../../../auth/current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../../auth/current-store/foundation-context';
import {
  captureIdentityAuthority,
  switchIdentityAuthority,
  type IdentityAuthorityName,
} from '../../../auth/authority/router';
import { bindIdentityAuthority } from '../../../auth/authority/identity-authority';
import { verifyAuthorityPassword } from '../../../auth/authority/authority';
import { createAuthorityAdapter } from '../../../auth/authority/adapter';
import { identityMirrorRecord, qualifyIdentityMirrorAtStartup } from '../../../auth/authority/mirror-activation';
import { mirrorIdentityIfEnabled } from '../../../auth/authority/sync-identity';
import { closeCredentialDatabase } from '../../../auth/credential-database';
import { identityRefusalCode, runImportIdentities } from '../../auth-import-identities';
import { runReconcileIdentities } from '../../auth-reconcile-identities';

/**
 * The code gates stay open in this build (LEGACY_WEB_IDENTITY_WRITERS and the
 * activation gates), so the first case shows them refusing with every database
 * precondition held. The rest close them the way the other suites get past
 * code gates: a module mock in this test, never a flag the production check reads.
 */
const codeGates = vi.hoisted(() => ({ identityCopy: 'open', activation: 'open' }));
vi.mock('../../../auth/authority/identity-copy-gates', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../auth/authority/identity-copy-gates')>();
  return {
    ...original,
    assertIdentityCopyGates: () => {
      if (codeGates.identityCopy === 'open') original.assertIdentityCopyGates();
    },
  };
});
vi.mock('../../../auth/authority/activation-gates', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../auth/authority/activation-gates')>();
  return {
    ...original,
    assertAuthorityActivationGates: () => {
      if (codeGates.activation === 'open') original.assertAuthorityActivationGates();
    },
  };
});

/**
 * End to end on the real migration journal (BA-04 #6978): a suite-owned
 * template copy of the freshly bootstrapped canonical proof database, the
 * dedicated credential LOGIN with its reviewed `private-provider-v1` grants,
 * the web fence applied from the live catalog, and an enforced manifest reached
 * the way the other owned proofs reach it (prepare, then the phase set
 * directly; `activate` itself refuses while its code gates are open). Only the
 * code gates above are mocked. CI runs it straight after the bootstrap, before
 * any other proof connects, because a template copy needs the source to be idle.
 *
 * The duplicate-email pair and its mixed-case member only show that the import
 * keys on user IDs and ignores email: `activate` refuses that state
 * (EMAIL_COLLISIONS_REMAIN, NORMALIZED_EMAILS_REQUIRED), so production cannot
 * reach `enforced` with it.
 */
const canonical = ownedCredentialProofUrl();
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
const copyUrl = new URL(canonical);
copyUrl.pathname = `/${copyName}`;
const maintenanceUrl = new URL(canonical);
maintenanceUrl.pathname = '/postgres';
const host = copyUrl.hostname;
const contract = 'private-provider-v1';
const projectionId = randomUUID();
const at = (iso: string) => new Date(iso);

interface Climber {
  readonly id: string;
  readonly email: string;
  readonly verified: Date | null;
  readonly password?: string;
  readonly providers?: readonly (readonly [provider: string, subject: string])[];
  readonly generation?: number;
  readonly deleting?: true;
}
// Sorted by ID, which is the import's cursor order.
const climbers: readonly Climber[] = [
  {
    id: 'ba04-e2e-a-password',
    email: 'password@example.test',
    verified: at('2021-03-04T05:06:07.000Z'),
    password: ' Pässword with spaces ',
  },
  {
    id: 'ba04-e2e-b-google',
    email: 'google@example.test',
    verified: at('2022-01-02T03:04:05.000Z'),
    providers: [['google', '109876543210987654321']],
  },
  // users.email is NOT NULL: an Apple-only climber who hid their email holds the private relay address.
  {
    id: 'ba04-e2e-c-apple',
    email: 'k7x2qrst9v@privaterelay.appleid.com',
    verified: null,
    providers: [['apple', '001234.a1b2c3d4e5f6.0789']],
  },
  {
    id: 'ba04-e2e-d-both',
    email: 'both@example.test',
    verified: at('2020-12-31T23:59:59.000Z'),
    password: 'both-password',
    providers: [
      ['google', '100000000000000000001'],
      ['apple', '000111.ffeeddccbbaa.2222'],
    ],
  },
  { id: 'ba04-e2e-e-unverified', email: 'unverified@example.test', verified: null, password: 'never-confirmed' },
  // Account deletion in progress: the tombstone is written, the users row not yet gone.
  {
    id: 'ba04-e2e-f-deleting',
    email: 'deleting@example.test',
    verified: null,
    password: 'deleting-password',
    providers: [['google', '100000000000000000099']],
    deleting: true,
  },
  // One address in two case spellings: a duplicate-email group BA-02 has not resolved yet.
  {
    id: 'ba04-e2e-g-duplicate',
    email: 'Shared.Address@example.test',
    verified: at('2019-05-06T07:08:09.000Z'),
    password: 'first-of-two',
  },
  { id: 'ba04-e2e-h-duplicate', email: 'shared.address@example.test', verified: null, password: 'second-of-two' },
  // Facebook sign-in is retired; the stored identity must survive exactly, never remapped.
  {
    id: 'ba04-e2e-i-facebook',
    email: 'facebook@example.test',
    verified: at('2018-07-08T09:10:11.000Z'),
    providers: [['facebook', '10153842917045123']],
  },
  {
    id: 'ba04-e2e-j-reset',
    email: 'reset@example.test',
    verified: at('2023-02-03T04:05:06.000Z'),
    password: 'after-three-resets',
    generation: 3,
  },
  {
    id: 'ba04-e2e-k-conflict',
    email: 'conflict@example.test',
    verified: null,
    providers: [['google', '100000000000000000077']],
  },
  { id: 'ba04-e2e-z-last', email: 'last@example.test', verified: null, password: 'last-one' },
];
const importedClimbers = climbers.filter((climber) => !climber.deleting);
const passwordHashes = new Map<string, string>();

let admin: postgres.Sql;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let copyCreated = false;
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ba04-e2e-')));
chmodSync(folder, 0o700);
const keyFile = join(folder, 'digest-key');
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
let journalCount = 0;
function journal(): string {
  const directory = join(folder, `checkpoints-${++journalCount}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

const mirrorEnvironment = () => ({
  AUTH_IDENTITY_MIRROR: 'on',
  CURRENT_STORE_SET_PASSWORD_MODE: 'backend-staging',
  CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
  CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'reserved-staging',
  CURRENT_STORE_NATIVE_OAUTH_MODE: 'reserved-staging',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
  CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
  CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
  CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-identity-import-proof-deleted-email-key-6975',
  AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
  AUTH_IDENTITY_DATABASE_CONTRACT: contract,
  DATABASE_URL: copyUrl.toString(),
});
const importEnvironment = () => ({
  AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
  AUTH_IDENTITY_DATABASE_CONTRACT: contract,
  AUTH_IDENTITY_MIRROR: 'on',
});
const importArguments = (command: 'plan' | 'import', checkpoint: string, pauseMs = '0') => [
  command,
  '--confirm-host',
  host,
  '--key-file',
  keyFile,
  '--checkpoint',
  checkpoint,
  '--batch',
  '2',
  '--pause-ms',
  pauseMs,
];
const qualified = (epoch: number) => ({ state: 'qualified', authority: { projectionId, epoch } });
const refusal = (pending: Promise<unknown>) => pending.then(() => 'NO_REFUSAL', identityRefusalCode);
const canonicalRows = () => environment.ownerDatabase.select().from(authAccount).orderBy(authAccount.id);
const reconcile = () =>
  runReconcileIdentities(['--confirm-host', host, '--key-file', keyFile], {
    AUTH_OPERATOR_DATABASE_URL: copyUrl.toString(),
  });

async function manifest() {
  const [current] = await environment.ownerDatabase
    .select()
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true));
  if (!current) throw new Error('OWNED_PROOF_MANIFEST_MISSING');
  return current;
}
async function selectAuthority(to: IdentityAuthorityName) {
  const current = await manifest();
  if (current.writerAuthority === to) return;
  await environment.ownerDatabase.transaction((transaction) =>
    switchIdentityAuthority(transaction, {
      projectionId,
      epoch: current.writerEpoch,
      from: current.writerAuthority,
      to,
    }),
  );
}

beforeAll(async () => {
  admin = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => undefined });
  const source = canonical.pathname.slice(1);
  await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${source.replaceAll('"', '""')}"`);
  copyCreated = true;
  environment = await createCredentialWriterEnvironment(contract, { copyDatabase: copyName });
  // The web fence the operator applies with `auth-fence apply`, from the live catalog.
  await environment.owner.unsafe(fencePlan(await readFenceCatalog(environment.owner)).sql);
  await expect(verifyFence(environment.owner)).resolves.toMatchObject({ verified: true });

  for (const climber of climbers) {
    await environment.ownerDatabase
      .insert(users)
      .values({ id: climber.id, email: climber.email, emailVerified: climber.verified, name: null });
    if (climber.password) {
      const passwordHash = await hash(climber.password, 4);
      passwordHashes.set(climber.id, passwordHash);
      await environment.ownerDatabase.insert(userCredentials).values({ userId: climber.id, passwordHash });
    }
    for (const [provider, subject] of climber.providers ?? [])
      await environment.ownerDatabase.insert(accounts).values({
        userId: climber.id,
        provider,
        providerAccountId: subject,
        type: 'oauth',
        access_token: `never-copied-${provider}`,
        refresh_token: `never-copied-${provider}`,
        id_token: `never-copied-${provider}`,
      });
    if (climber.generation || climber.deleting)
      await environment.ownerDatabase.insert(authSubjectCutoffs).values({
        userId: climber.id,
        generation: climber.generation ?? 0,
        revokedThrough: new Date(),
        deletedAt: climber.deleting ? new Date() : null,
        lastOperationId: randomUUID(),
      });
  }
  // A fully deleted account: the tombstone outlives its users row.
  await environment.ownerDatabase.insert(authSubjectCutoffs).values({
    userId: 'ba04-e2e-deleted-tombstone',
    generation: 1,
    revokedThrough: new Date(),
    deletedAt: new Date(),
    lastOperationId: randomUUID(),
  });
  await environment.ownerDatabase.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction
      .update(authEmailProjection)
      .set({ phase: 'enforced' })
      .where(eq(authEmailProjection.projectionId, projectionId));
  });
}, 180_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await qualifyIdentityMirrorAtStartup({});
  await closeCredentialDatabase();
  await environment?.close();
  try {
    if (copyCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}" WITH (FORCE)`);
  } finally {
    await admin?.end({ timeout: 5 });
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('identity mirror and import preconditions on the real journal', () => {
  let usersBefore: (typeof users.$inferSelect)[];

  it('refuses on the open code gates even though every database precondition holds', async () => {
    usersBefore = await environment.ownerDatabase.select().from(users).orderBy(users.id);
    expect(await refusal(qualifyIdentityMirrorAtStartup(mirrorEnvironment()))).toBe('IDENTITY_COPY_CODE_GATES_OPEN');
    expect(identityMirrorRecord()).toBeUndefined();
    for (const command of ['plan', 'import'] as const)
      expect(await refusal(runImportIdentities(importArguments(command, journal()), importEnvironment()))).toBe(
        'IDENTITY_COPY_CODE_GATES_OPEN',
      );
    // With LEGACY_WEB_IDENTITY_WRITERS gone, both still answer to activate's gates:
    // `enforced` here was set by hand, exactly what those gates exist for.
    codeGates.identityCopy = 'closed';
    expect(await refusal(qualifyIdentityMirrorAtStartup(mirrorEnvironment()))).toBe('ACTIVATION_CODE_GATES_OPEN');
    expect(identityMirrorRecord()).toBeUndefined();
    for (const command of ['plan', 'import'] as const)
      expect(await refusal(runImportIdentities(importArguments(command, journal()), importEnvironment()))).toBe(
        'ACTIVATION_CODE_GATES_OPEN',
      );
    codeGates.activation = 'closed';
    expect(await canonicalRows()).toEqual([]);
  });

  it('boots the mirror and plans the import only when every precondition holds', async () => {
    expect(await qualifyIdentityMirrorAtStartup(mirrorEnvironment())).toEqual(qualified(1));
    expect(identityMirrorRecord()).toEqual(qualified(1));
    expect(await runImportIdentities(importArguments('plan', journal()), importEnvironment())).toEqual({
      mode: 'plan',
      status: 'ready',
      writerEpoch: 1,
      remainingUsers: climbers.length,
      batch: 2,
    });
    expect(await canonicalRows()).toEqual([]);
  });

  it('stops on a semantic failure, then resumes from its checkpoint without duplicates', async () => {
    // A stray canonical row naming a later climber as owner of k's Google subject.
    const strayId = randomUUID();
    await environment.ownerDatabase.insert(authAccount).values({
      id: strayId,
      userId: 'ba04-e2e-z-last',
      providerId: 'google',
      accountId: '100000000000000000077',
      sourceGeneration: 0,
    });
    const checkpoint = journal();
    expect(await refusal(runImportIdentities(importArguments('import', checkpoint), importEnvironment()))).toBe(
      'AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT',
    );
    // Five completed batches of two (a..j); k's transaction rolled back whole.
    expect(readdirSync(checkpoint)).toHaveLength(5);
    const partial = (await canonicalRows()).filter((row) => row.id !== strayId);
    expect(new Set(partial.map((row) => row.userId))).toEqual(
      new Set(
        importedClimbers
          .filter(({ id }) => id < 'ba04-e2e-k')
          .filter((climber) => climber.password || climber.providers)
          .map(({ id }) => id),
      ),
    );
    // The operator removes the stray row and reruns the same command.
    await environment.ownerDatabase.delete(authAccount).where(eq(authAccount.id, strayId));
    expect(await runImportIdentities(importArguments('import', checkpoint), importEnvironment())).toEqual({
      mode: 'import',
      status: 'import-pass-complete-reconcile-required',
      writerEpoch: 1,
      processed: 2,
    });
    expect(readdirSync(checkpoint)).toHaveLength(6);
    const complete = await canonicalRows();
    for (const row of partial) expect(complete.find(({ id }) => id === row.id)).toEqual(row);
    expect(await runImportIdentities(importArguments('import', checkpoint), importEnvironment())).toMatchObject({
      processed: 0,
    });
  });

  it('preserves every ID, bcrypt string, provider subject and verification state; copies no token or session', async () => {
    const rows = await canonicalRows();
    const expected = importedClimbers.flatMap((climber) => [
      ...(climber.password
        ? [
            {
              userId: climber.id,
              providerId: 'credential',
              accountId: climber.id,
              password: passwordHashes.get(climber.id),
              sourceGeneration: climber.generation ?? 0,
            },
          ]
        : []),
      ...(climber.providers ?? []).map(([provider, subject]) => ({
        userId: climber.id,
        providerId: provider,
        accountId: subject,
        password: null,
        sourceGeneration: climber.generation ?? 0,
      })),
    ]);
    const observed = rows.map(({ userId, providerId, accountId, password, sourceGeneration }) => ({
      userId,
      providerId,
      accountId,
      password,
      sourceGeneration,
    }));
    const order = (left: { userId: string; providerId: string }, right: { userId: string; providerId: string }) =>
      `${left.userId}:${left.providerId}`.localeCompare(`${right.userId}:${right.providerId}`);
    expect(observed.sort(order)).toEqual(expected.sort(order));
    for (const row of rows) {
      expect(row).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, scope: null });
      // Byte-for-byte, including the $2b$ prefix and cost.
      if (row.password !== null)
        expect(Buffer.from(row.password)).toEqual(Buffer.from(passwordHashes.get(row.userId)!));
    }
    expect(rows.some((row) => row.userId === 'ba04-e2e-f-deleting')).toBe(false);
    expect(rows.find((row) => row.providerId === 'facebook')).toMatchObject({
      userId: 'ba04-e2e-i-facebook',
      accountId: '10153842917045123',
    });
    // The authority's user model is `users` itself: IDs, emails and verification
    // timestamps have no second copy, and the import wrote none of them.
    expect(await environment.ownerDatabase.select().from(users).orderBy(users.id)).toEqual(usersBefore);
    expect(await environment.ownerDatabase.select().from(authSession)).toEqual([]);
    const adapter = (transaction: Parameters<Parameters<typeof environment.ownerDatabase.transaction>[0]>[0]) =>
      createAuthorityAdapter(transaction)({ logger: { disabled: true }, telemetry: { enabled: false } });
    await environment.ownerDatabase.transaction(async (transaction) => {
      for (const [id, verified] of [
        ['ba04-e2e-a-password', true],
        ['ba04-e2e-c-apple', false],
        ['ba04-e2e-e-unverified', false],
        ['ba04-e2e-i-facebook', true],
      ] as const)
        expect(
          await adapter(transaction).findOne<{ id: string; emailVerified: boolean }>({
            model: 'user',
            where: [{ field: 'id', value: id }],
          }),
        ).toMatchObject({ id, emailVerified: verified });
    });
  });

  it('re-running imports nothing new and reconciliation reports zero differences', async () => {
    const before = await canonicalRows();
    expect(await runImportIdentities(importArguments('import', journal()), importEnvironment())).toMatchObject({
      processed: climbers.length,
    });
    expect(await canonicalRows()).toEqual(before);
    const report = await reconcile();
    expect(report).toMatchObject({ users: climbers.length, missing: 0, different: 0, unexpected: 0 });
    expect(report.sourceDigest).toBe(report.targetDigest);
    expect(JSON.stringify(report)).not.toMatch(/ba04-e2e|example\.test|\$2[ab]\$/);
  });

  it('refuses each broken precondition with its own code, at mirror boot and before any import write', async () => {
    const before = await canonicalRows();
    const attempt = async (expected: string, environmentOverride: Record<string, string> = {}) => {
      expect(await refusal(qualifyIdentityMirrorAtStartup({ ...mirrorEnvironment(), ...environmentOverride }))).toBe(
        expected,
      );
      expect(identityMirrorRecord()).toBeUndefined();
      for (const command of ['plan', 'import'] as const)
        expect(
          await refusal(
            runImportIdentities(importArguments(command, journal()), {
              ...importEnvironment(),
              ...environmentOverride,
            }),
          ),
        ).toBe(expected);
      expect(await canonicalRows()).toEqual(before);
    };
    const wrongPassword = new URL(environment.writerUrl);
    wrongPassword.password = 'not-the-writer-password';
    // A rejected login is a verdict on the LOGIN; nothing answering is not.
    await attempt('CREDENTIAL_WRITER_UNQUALIFIED', { AUTH_IDENTITY_DATABASE_URL: wrongPassword.toString() });
    const nobodyHome = new URL(environment.writerUrl);
    nobodyHome.port = '1';
    const contentNobodyHome = new URL(copyUrl);
    contentNobodyHome.port = '1';
    await attempt('PRECONDITION_CHECK_UNAVAILABLE', {
      AUTH_IDENTITY_DATABASE_URL: nobodyHome.toString(),
      DATABASE_URL: contentNobodyHome.toString(),
    });
    const phase = (value: 'prepared' | 'enforced') =>
      environment.ownerDatabase
        .update(authEmailProjection)
        .set({ phase: value })
        .where(eq(authEmailProjection.projectionId, projectionId));

    await phase('prepared');
    await attempt('AUTHORITY_NOT_ENFORCED');
    await phase('enforced');

    await environment.owner`GRANT UPDATE ON public.users TO boardsesh_web`;
    await attempt('WEB_FENCE_UNVERIFIED');
    await environment.owner`REVOKE UPDATE ON public.users FROM boardsesh_web`;

    await environment.owner`GRANT TRUNCATE ON public.auth_account TO boardsesh_identity_writer`;
    await attempt('CREDENTIAL_WRITER_UNQUALIFIED');
    await environment.owner`REVOKE TRUNCATE ON public.auth_account FROM boardsesh_identity_writer`;

    await environment.owner`DROP INDEX public.auth_account_provider_subject_uidx`;
    await attempt('MIRROR_TABLES_MISSING');
    await environment.owner`CREATE UNIQUE INDEX auth_account_provider_subject_uidx ON public.auth_account USING btree (provider_id, account_id)`;

    // The deployment's configured projection and epoch are the mirror's alone; the import has none.
    for (const misconfigured of [
      { CURRENT_STORE_AUTH_PROJECTION_ID: randomUUID() },
      { CURRENT_STORE_AUTH_WRITER_EPOCH: '2' },
    ])
      expect(await refusal(qualifyIdentityMirrorAtStartup({ ...mirrorEnvironment(), ...misconfigured }))).toBe(
        'AUTHORITY_STALE',
      );

    // A switch to Better Auth (epoch 2). A deployment configured for epoch 1 is
    // the restart a switch leaves behind: it boots, inert, instead of crash-looping.
    await selectAuthority('better-auth');
    expect(await qualifyIdentityMirrorAtStartup(mirrorEnvironment())).toEqual({
      state: 'inert',
      reason: 'AUTHORITY_NOT_CURRENT_STORE',
    });
    // Configured for the switched epoch itself is no restart, it is a mirror pointed the wrong way;
    // the import refuses Better Auth as a source either way.
    await attempt('AUTHORITY_NOT_CURRENT_STORE', { CURRENT_STORE_AUTH_WRITER_EPOCH: '2' });
    await selectAuthority('current-store');
    // Two switches later the manifest is epoch 3; the deployed configuration still says 1.
    expect(await qualifyIdentityMirrorAtStartup(mirrorEnvironment())).toEqual({
      state: 'inert',
      reason: 'AUTHORITY_STALE',
    });
    expect(
      await qualifyIdentityMirrorAtStartup({ ...mirrorEnvironment(), CURRENT_STORE_AUTH_WRITER_EPOCH: '3' }),
    ).toEqual(qualified(3));
    expect(await runImportIdentities(importArguments('plan', journal()), importEnvironment())).toMatchObject({
      status: 'ready',
      writerEpoch: 3,
    });
    expect(await canonicalRows()).toEqual(before);
  });

  it('stops an import whose manifest moves mid-run before the next user is copied', async () => {
    const checkpoint = journal();
    // A long pause after the first batch leaves room to switch authority twice.
    const running = refusal(runImportIdentities(importArguments('import', checkpoint, '3000'), importEnvironment()));
    const started = Date.now();
    while (readdirSync(checkpoint).length === 0) {
      if (Date.now() - started > 20_000) throw new Error('OWNED_PROOF_FIRST_BATCH_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const epoch = (await manifest()).writerEpoch;
    await selectAuthority('better-auth');
    await selectAuthority('current-store');
    expect((await manifest()).writerEpoch).toBe(epoch + 2);
    // Back on current-store, so only the run's own qualified epoch can stop it.
    expect(await running).toBe('STALE_AUTHORITY');
    expect(readdirSync(checkpoint)).toHaveLength(1);
  });

  it('stops mirroring writes under a stale authority, rolling the credential write back with its copy', async () => {
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const current = await manifest();
    const configured = { ...mirrorEnvironment(), CURRENT_STORE_AUTH_WRITER_EPOCH: String(current.writerEpoch) };
    expect(await qualifyIdentityMirrorAtStartup(configured)).toEqual(qualified(current.writerEpoch));
    const userId = 'ba04-e2e-z-last';
    const replacement = await hash('replaced-by-a-staged-reset', 4);
    // A staged writer's transaction on the dedicated LOGIN: credential write, then the copy.
    const reset = (passwordHash: string) =>
      environment.database.transaction(async (transaction) => {
        await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        await transaction.update(userCredentials).set({ passwordHash }).where(eq(userCredentials.userId, userId));
        await mirrorIdentityIfEnabled(transaction, userId);
      });
    await reset(replacement);
    expect((await canonicalRows()).find((row) => row.userId === userId)?.password).toBe(replacement);
    await selectAuthority('better-auth');
    await selectAuthority('current-store');
    await expect(reset(passwordHashes.get(userId)!)).rejects.toThrow('STALE_AUTHORITY');
    expect(
      (await environment.ownerDatabase.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0]
        ?.passwordHash,
    ).toBe(replacement);
    expect((await canonicalRows()).find((row) => row.userId === userId)?.password).toBe(replacement);
    // A restart still configured for the old epoch boots inert and keeps refusing.
    expect(await qualifyIdentityMirrorAtStartup(configured)).toEqual({ state: 'inert', reason: 'AUTHORITY_STALE' });
    await expect(reset(passwordHashes.get(userId)!)).rejects.toThrow('STALE_AUTHORITY');
    // A process with the mirror on that never qualified refuses too.
    await qualifyIdentityMirrorAtStartup({});
    await expect(reset(passwordHashes.get(userId)!)).rejects.toMatchObject({ code: 'MIRROR_NOT_QUALIFIED' });
    expect((await canonicalRows()).find((row) => row.userId === userId)?.password).toBe(replacement);
    // A redeploy with the new epoch qualifies again; the reconcile still balances.
    const epoch = (await manifest()).writerEpoch;
    expect(
      await qualifyIdentityMirrorAtStartup({ ...mirrorEnvironment(), CURRENT_STORE_AUTH_WRITER_EPOCH: String(epoch) }),
    ).toEqual(qualified(epoch));
    expect(await reconcile()).toMatchObject({ missing: 0, different: 0, unexpected: 0 });
  });

  it('verifies every imported credential with its original password once Better Auth is the authority', async () => {
    await selectAuthority('better-auth');
    await environment.ownerDatabase.transaction(async (transaction) => {
      const receipt = await captureIdentityAuthority(transaction, {
        expectedProjectionId: projectionId,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      });
      expect(receipt.authority).toBe('better-auth');
      const identity = bindIdentityAuthority(transaction, receipt);
      for (const climber of importedClimbers.filter((candidate) => candidate.password)) {
        const stored = await identity.readPassword(climber.id);
        const original = climber.id === 'ba04-e2e-z-last' ? 'replaced-by-a-staged-reset' : climber.password!;
        expect(stored?.passwordHash).toBeDefined();
        expect(await verifyAuthorityPassword({ hash: stored!.passwordHash, password: original })).toBe(true);
        expect(await verifyAuthorityPassword({ hash: stored!.passwordHash, password: `${original}x` })).toBe(false);
      }
      for (const [provider, subject, owner] of [
        ['google', '109876543210987654321', 'ba04-e2e-b-google'],
        ['apple', '001234.a1b2c3d4e5f6.0789', 'ba04-e2e-c-apple'],
        ['facebook', '10153842917045123', 'ba04-e2e-i-facebook'],
      ] as const)
        expect(await identity.findProvider(provider, subject)).toMatchObject({ userId: owner, provider, subject });
      // The deleting climber's subject was never copied.
      expect(await identity.findProvider('google', '100000000000000000099')).toBeNull();
    });
  });
});
