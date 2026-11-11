import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  authWebOAuthCommands,
  authWebOAuthIntents,
  mobileRefreshTokens,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { logbookChanges, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { getWorkerDatabaseName, getWorkerDatabaseUrl } from '../../../__tests__/worker-db';
import { userMutations } from '../../../graphql/resolvers/users/mutations';
import { createYogaInstance } from '../../../graphql/yoga';
import { logger } from '../../../utils/logger';
import * as postgresErrors from '../../../utils/postgres-errors';
import * as userActivity from '../../../services/user-activity';
import * as posthogPersonDeletion from '../../../services/analytics/posthog-person-deletion';
import { lockSprayWallAccount } from '../../../services/spray-account-lock';
import {
  attachPartnerState,
  countsOf,
  createApp,
  INTACT_COUNTS,
  readPartnerState,
} from '../../partner/__tests__/revocation-fixtures';
import { normalizeAccountEmail } from '../../normalize-email';
import { preflight, transactionSettings } from '../command-context';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { clearExpiredAuthRecords } from '../../../services/background-job-maintenance';
import {
  AUTHORITY_GATE_KEY,
  AUTHORITY_GATE_NAMESPACE,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
  type ExpectedCurrentStoreAuthority,
} from '../foundation-context';
import {
  captureAccountDeletionCommand,
  beginReservedAccountDeletion,
  lockReservedDeletionSubject,
  recordReservedAccountDeletion,
  type ReservedDeletionSubject,
} from '../account-deletion';
import { recordSecurityMutation } from '../security-mutations';
import { insertReservedPasswordIdentity } from '../reserved-password-registration';
import { consumePasswordRecovery, requestPasswordRecovery } from '../password-recovery';
import { consumeEmailVerification, issueEmailVerification, resendEmailVerification } from '../email-verification';
import { resolveReservedCurrentStoreOAuthIdentity } from '../provider-oauth-identity';
import { recordWebOAuthIntent } from '../web-oauth-identity';
import { authenticateWebPassword } from '../web-password';
import { AUTH_PROTOCOL_VERSION, WEB_OAUTH_PROTOCOL_VERSION } from '@boardsesh/auth-protocol';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  lockFixedSystemOwnerTransaction,
  type FixedSystemOwnerTransaction,
} from '@boardsesh/db/fixed-system-owner-order';

// Only post-commit external effects are replaced. All account/content/security
// SQL and the mounted resolver, auth middleware, schema and retry are real.
const effects = vi.hoisted(() => ({ publish: vi.fn(async () => undefined), purge: vi.fn(async () => undefined) }));
vi.mock('../../../services/board-queue-preview-tombstone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/board-queue-preview-tombstone')>()),
  publishBoardQueuePreviewTombstoneForBoard: effects.publish,
}));
vi.mock('../../../graphql/resolvers/board/spray-wall-moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../graphql/resolvers/board/spray-wall-moderation')>()),
  purgeDeletedSprayWallPhotos: effects.purge,
}));

const ownerId = randomUUID(),
  otherId = randomUUID();
const ownerEmail = `Owned.${ownerId}+Tag@Example.TEST`;
const systemId = '00000000-0000-0000-0000-000000000000';
const triggerName = `ba03_delete_fault_${randomUUID().replaceAll('-', '')}`;
const sequenceName = `${triggerName}_attempts`;
const privateMarker = `owned-delete-private-${randomUUID()}`;
const stagedFailureLine = '[deleteAccount] Staged account deletion failed';
const cascadeGateKey = randomInt(1, 2_147_483_647);
const commandGateKey = randomInt(1, 2_147_483_647);
const commandGateName = `${triggerName}_command`;
const password = 'owned-deletion-current-password';
/** The digest row a deleted address leaves, computed here from the contract, not the code. */
function retiredKey(address: string): string {
  const key = process.env.CURRENT_STORE_DELETED_EMAIL_KEY;
  if (!key) throw new Error('Owned deletion fixture needs its digest key');
  return `deleted-v1:${createHmac('sha256', key)
    .update(`deleted-email-v1\0${normalizeAccountEmail(address)}`)
    .digest('hex')}`;
}
let passwordHash: string;
let authority: ExpectedCurrentStoreAuthority;
let observer: ReturnType<typeof postgres>;
let blocker: ReturnType<typeof postgres>;
let failedCleanup = false;
const pending = new Set<Promise<unknown>>();
const publicJwt = createRequire(new URL('../../../../../web/package.json', import.meta.url))('next-auth/jwt') as {
  encode(options: { token: Record<string, unknown>; secret: string; maxAge?: number }): Promise<string>;
};
function track<Result>(operation: Promise<Result>): Promise<Result> {
  const observed = operation.then(
    (result) => {
      pending.delete(observed);
      return result;
    },
    (error) => {
      pending.delete(observed);
      throw error;
    },
  );
  pending.add(observed);
  void observed.catch(() => undefined);
  return observed;
}
async function bounded<Result>(operation: Promise<Result>, milliseconds = 10000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned deletion fixture deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function context(id = ownerId): ConnectionContext {
  return { connectionId: `owned-delete-${id}`, transport: 'http', isAuthenticated: true, userId: id };
}
function remove(id = ownerId) {
  return track(userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, context(id)));
}
function staging() {
  vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', 'reserved-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', authority.expectedProjectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', String(authority.expectedWriterEpoch));
  vi.stubEnv('DEBUG_SQL', 'false');
}
async function seedPair(options: { collision?: boolean; invalid?: boolean; system?: boolean } = {}) {
  await db.insert(users).values([
    { id: ownerId, email: options.invalid ? '   ' : ownerEmail, name: 'Owned deletion fixture' },
    {
      id: otherId,
      email: options.collision ? normalizeAccountEmail(ownerEmail) : `${otherId}@other.example.test`,
      name: 'Unaffected fixture',
    },
    ...(options.system ? [{ id: systemId, email: 'system@boardsesh.com', name: 'Existing system owner' }] : []),
  ]);
  for (const id of [ownerId, otherId]) {
    await db.insert(userCredentials).values({ userId: id, passwordHash });
    await db.insert(userProfiles).values({ userId: id, displayName: 'Retained until account deletion' });
    await db
      .insert(accounts)
      .values({ userId: id, provider: 'google', providerAccountId: randomUUID(), type: 'oauth' });
    await db.insert(sessions).values({ userId: id, sessionToken: randomUUID(), expires: new Date(Date.now() + 60000) });
    await db.insert(mobileRefreshTokens).values([
      {
        id: randomUUID(),
        userId: id,
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60000),
      },
      {
        id: randomUUID(),
        userId: id,
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60000),
        revokedAt: new Date(),
      },
    ]);
  }
  const projectionId = randomUUID();
  await db.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction
      .update(authEmailProjection)
      .set({ phase: 'enforced' })
      .where(eq(authEmailProjection.projectionId, projectionId));
  });
  authority = {
    expectedProjectionId: projectionId,
    expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    expectedWriterEpoch: 1,
  };
  staging();
}
async function snapshot() {
  return {
    users: await db.select().from(users).orderBy(users.id),
    credentials: (await db.select().from(userCredentials).orderBy(userCredentials.userId)).map(
      ({ passwordHash: credentialHash, ...credential }) => ({
        ...credential,
        hashDigest: createHash('sha256').update(credentialHash).digest('hex'),
      }),
    ),
    accounts: await db.select().from(accounts).orderBy(accounts.providerAccountId),
    sessions: await db.select().from(sessions).orderBy(sessions.sessionToken),
    profiles: await db.select().from(userProfiles).orderBy(userProfiles.userId),
    refresh: await db.select().from(mobileRefreshTokens).orderBy(mobileRefreshTokens.id),
    projections: await db.select().from(authEmailProjection).orderBy(authEmailProjection.projectionId),
    reservations: await db.select().from(authEmailReservations).orderBy(authEmailReservations.normalizedEmail),
    members: await db
      .select()
      .from(authEmailReservationMembers)
      .orderBy(authEmailReservationMembers.normalizedEmail, authEmailReservationMembers.userId),
    cutoffs: await db.select().from(authSubjectCutoffs).orderBy(authSubjectCutoffs.userId),
    events: await db.select().from(authSecurityMutationEvents).orderBy(authSecurityMutationEvents.operationId),
    boards: await db.select().from(userBoards).orderBy(userBoards.id),
    verificationState: await db.select().from(authEmailVerificationState),
    verificationReceipts: await db.select().from(authEmailVerificationTokens),
    recoveryState: await db.select().from(authPasswordRecoveryState),
    recoveryReceipts: await db.select().from(authPasswordRecoveryTokens),
    oauthIntents: await db.select().from(authWebOAuthIntents),
    oauthCommands: await db.select().from(authWebOAuthCommands),
    legacyReceipts: await db.select().from(verificationTokens).orderBy(verificationTokens.identifier),
  };
}
async function seedBoard() {
  const uuid = randomUUID();
  const [board] = await db
    .insert(userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      name: 'Owned private address',
      description: 'Fixture private location',
      latitude: 12,
      longitude: 34,
      isPublic: true,
    })
    .returning();
  return board;
}
async function expectUnavailableUnchanged() {
  const before = await snapshot();
  let error: unknown;
  try {
    await remove();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    message: 'Account deletion is temporarily unavailable.',
    extensions: { code: 'SERVICE_UNAVAILABLE' },
  });
  expect(Boolean(error && typeof error === 'object' && 'originalError' in error && error.originalError)).toBe(false);
  expect(Boolean(error && typeof error === 'object' && 'cause' in error && error.cause)).toBe(false);
  expect(error instanceof Error && error.message.includes(privateMarker)).toBe(false);
  expect(await snapshot()).toEqual(before);
  expect(effects.publish).not.toHaveBeenCalled();
  expect(effects.purge).not.toHaveBeenCalled();
}
async function clearFault() {
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(triggerName)} ON public.users`);
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(triggerName)} ON public.auth_security_mutation_events`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.identifier(triggerName)}()`);
  await db.execute(sql`DROP SEQUENCE IF EXISTS ${sql.identifier(sequenceName)}`);
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(commandGateName)} ON ${verificationTokens}`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.identifier(commandGateName)}()`);
}
/** Parks a real command on its first write: gate held, user row not yet requested. */
async function installCommandGate() {
  await db.execute(
    sql.raw(`CREATE FUNCTION ${commandGateName}() RETURNS trigger LANGUAGE plpgsql AS $gate$
    BEGIN PERFORM pg_advisory_xact_lock(${commandGateKey}); RETURN NEW; END; $gate$`),
  );
  await db.execute(
    sql`CREATE TRIGGER ${sql.identifier(commandGateName)} BEFORE INSERT ON ${verificationTokens} FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(commandGateName)}()`,
  );
}
/** Runs `body` inside the real users DELETE for the owner. Generated constants only, never input. */
async function installCascadeTrigger(body: string) {
  await db.execute(
    sql.raw(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $fault$
    BEGIN IF OLD.id='${ownerId}' THEN ${body} END IF; RETURN OLD; END; $fault$`),
  );
  await db.execute(
    sql`CREATE TRIGGER ${sql.identifier(triggerName)} BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(triggerName)}()`,
  );
}
async function installFault() {
  await installCascadeTrigger(
    `RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='ba03_delete_final_fixture', MESSAGE='${privateMarker}', DETAIL='${privateMarker}';`,
  );
}
/** Fails the first attempt on its event row, the last write of a deletion attempt. */
async function installRetryFault() {
  await db.execute(sql`CREATE SEQUENCE ${sql.identifier(sequenceName)}`);
  await db.execute(
    sql.raw(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $fault$
    BEGIN IF NEW.user_id='${ownerId}' AND nextval('${sequenceName}') = 1 THEN
      RAISE EXCEPTION USING ERRCODE='40P01', CONSTRAINT='ba03_delete_final_fixture', MESSAGE='${privateMarker}', DETAIL=NEW.operation_id;
    END IF; RETURN NEW; END; $fault$`),
  );
  await db.execute(
    sql`CREATE TRIGGER ${sql.identifier(triggerName)} AFTER INSERT ON public.auth_security_mutation_events FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(triggerName)}()`,
  );
}
/** Holds `acquire` on the blocker connection until released, so a deletion can be parked mid-flight. */
async function holdOnBlocker(
  acquire: (transaction: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>,
  connection: DbInstance = drizzle(blocker),
) {
  const arrived = barrier(),
    release = barrier();
  let backendPid = 0;
  const held = track(
    connection.transaction(async (transaction) => {
      const row = await executeFirstRow<{ pid: number }>(transaction, sql`SELECT pg_backend_pid() AS pid`);
      if (!row) throw new Error('Owned blocker PID unavailable');
      backendPid = row.pid;
      await acquire(transaction);
      arrived.release();
      await release.promise;
    }),
  );
  await bounded(
    Promise.race([
      arrived.promise,
      held.then(() => {
        throw new Error('Owned blocker ended early');
      }),
    ]),
  );
  return { held, backendPid, release: release.release };
}
async function requireLockedSubject(
  transaction: Parameters<typeof lockReservedDeletionSubject>[0],
  command: Parameters<typeof lockReservedDeletionSubject>[1],
): Promise<ReservedDeletionSubject> {
  const subject = await lockReservedDeletionSubject(transaction, command);
  if (!subject) throw new Error('Owned deletion fixture expected a live subject');
  return subject;
}
/** The backend session queued on an advisory gate, so a test can see who is blocking whom. */
async function sessionWaitingOnGate(gateKey: number): Promise<number> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const [row] = await observer<
      { pid: number }[]
    >`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${gateKey}::oid AND NOT granted LIMIT 1`;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Owned deletion fixture gate had no waiter');
}
const recoveryAuthority = () => ({ ...authority, emailVerificationEnabled: false });
const verificationAuthority = () => ({ ...authority, emailVerificationEnabled: true });
function webCommand<Operation extends string, Payload>(operation: Operation, payload: Payload) {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  } as const;
}
async function issueOwnerRecoveryToken(): Promise<string> {
  const issued = await requestPasswordRecovery(
    db,
    recoveryAuthority(),
    webCommand('forgot-password', { email: ownerEmail }),
  );
  if (issued.outcome !== 'accepted' || !issued.mailPlan) throw new Error('Owned fixture expected a recovery token');
  return issued.mailPlan.token;
}
/** Every staged command that takes the gate and then a named user's row. */
const commandsNamingTheAccount: readonly (readonly [string, () => Promise<() => Promise<unknown>>])[] = [
  [
    'password sign-in',
    async () => () =>
      authenticateWebPassword(db, recoveryAuthority(), webCommand('password', { email: ownerEmail, password })),
  ],
  [
    'forgot password',
    async () => () =>
      requestPasswordRecovery(db, recoveryAuthority(), webCommand('forgot-password', { email: ownerEmail })),
  ],
  [
    'password reset',
    async () => {
      const token = await issueOwnerRecoveryToken();
      const newPassword = 'new-owned-deletion-password';
      return () =>
        consumePasswordRecovery(
          db,
          recoveryAuthority(),
          webCommand('reset-password', {
            email: ownerEmail,
            token,
            password: newPassword,
            confirmPassword: newPassword,
          }),
        );
    },
  ],
  [
    'resend verification',
    async () => () =>
      resendEmailVerification(db, verificationAuthority(), webCommand('resend-verification', { email: ownerEmail })),
  ],
  [
    'email verification',
    async () => {
      const plan = await db.transaction((transaction) =>
        issueEmailVerification(transaction, verificationAuthority(), ownerId),
      );
      if (!plan) throw new Error('Owned fixture expected a verification token');
      return () =>
        consumeEmailVerification(
          db,
          verificationAuthority(),
          webCommand('verify-email', { token: plan.token, email: ownerEmail }),
        );
    },
  ],
  [
    'provider sign-in',
    async () => {
      const subject = randomUUID();
      await db
        .insert(accounts)
        .values({ userId: ownerId, provider: 'google', providerAccountId: subject, type: 'oauth' });
      // With the transaction limits its real callers (native and web OAuth) apply.
      return () =>
        db.transaction(async (transaction) => {
          await transactionSettings(transaction);
          return resolveReservedCurrentStoreOAuthIdentity(
            transaction,
            authority,
            'google',
            { sub: subject, email: ownerEmail, emailVerified: true, name: null },
            { emailStorage: 'normalized', emailVerification: 'provider', actorUserId: null },
          );
        });
    },
  ],
  [
    'web OAuth actor',
    async () => {
      const secret = randomBytes(32).toString('base64url');
      const actorCookie = await publicJwt.encode({
        secret,
        token: { sub: ownerId, authSessionId: randomUUID() },
        maxAge: 3600,
      });
      return () =>
        recordWebOAuthIntent(db, authority, secret, {
          webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
          operation: 'intent',
          requestId: randomUUID(),
          issuedAt: new Date().toISOString(),
          payload: { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie },
        });
    },
  ],
];
/** Staged-failure lines only: the PostHog erasure step logs its own error when no queue runs. */
function stagedFailureLogs() {
  return vi.mocked(logger.error).mock.calls.filter(([line]: unknown[]) => line === stagedFailureLine);
}
function errorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { detail?: unknown; cause?: unknown };
  return typeof candidate.detail === 'string' ? candidate.detail : errorDetail(candidate.cause);
}
async function waitForBlocker(pid: number, operation: Promise<unknown>) {
  let stopped = false;
  const polling = (async () => {
    while (!stopped) {
      const [row] = await observer<
        { waiting: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
      if (row.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  try {
    await bounded(
      Promise.race([
        polling,
        operation.then(() => {
          throw new Error('Deletion finished before its lock barrier');
        }),
      ]),
      2500,
    );
  } finally {
    stopped = true;
    await polling;
  }
}

describe('mounted account deletion and current-store authority', () => {
  beforeAll(async () => {
    const address = new URL(process.env.DATABASE_URL!);
    const canonical5433 =
      ((process.env.CI === 'true' || process.env.CI === '1') && process.env.GITHUB_ACTIONS === 'true') ||
      (process.env.VITEST === 'true' && !process.env.CI && process.env.SKIP_TEST_INFRA !== '1');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      !(['15475', '15478'].includes(address.port) || (address.port === '5433' && canonical5433)) ||
      address.pathname !== `/${getWorkerDatabaseName()}` ||
      process.env.DATABASE_URL !== getWorkerDatabaseUrl()
    )
      throw new Error('Account deletion proof requires the exact owned backend worker database');
    passwordHash = await bcrypt.hash(password, 12);
    const poolOptions = {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 6000, lock_timeout: 4000 },
    };
    observer = postgres(address.href, poolOptions);
    blocker = postgres(address.href, poolOptions);
  });
  beforeEach(async () => {
    if (failedCleanup || pending.size !== 0) throw new Error('Previous owned deletion work did not settle');
    vi.unstubAllEnvs();
    effects.publish.mockClear();
    effects.purge.mockClear();
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const recordActivity = userActivity.recordUserActivity.bind(userActivity);
    vi.spyOn(userActivity, 'recordUserActivity').mockImplementation((...arguments_) =>
      track(recordActivity(...arguments_)),
    );
    await clearFault();
    await db.delete(authEmailVerificationTokens);
    await db.delete(authEmailVerificationState);
    await db.delete(authPasswordRecoveryTokens);
    await db.delete(authPasswordRecoveryState);
    await db.delete(authWebOAuthIntents);
    await db.delete(authWebOAuthCommands);
    await db.delete(verificationTokens);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(userBoards);
    await db.delete(users);
  });
  afterEach(async () => {
    try {
      await bounded(Promise.allSettled(pending));
    } catch {
      failedCleanup = true;
      throw new Error('Owned deletion work still active; environment retained');
    }
    await clearFault();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await observer?.end({ timeout: 3 });
    await blocker?.end({ timeout: 3 });
  });

  it.each([undefined, '', 'legacy'])(
    'preserves legacy deletion without projection/configuration for mode %j',
    async (mode) => {
      await seedPair();
      await db.delete(authEmailReservationMembers);
      await db.delete(authEmailReservations);
      await db.delete(authEmailProjection);
      vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', mode);
      vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', '');
      vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', 'invalid');
      vi.stubEnv('DEBUG_SQL', 'true');
      expect(await remove()).toBe(true);
      expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
      expect(await db.select().from(authSubjectCutoffs)).toEqual([]);
      expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
      expect(await db.select().from(users).where(eq(users.id, otherId))).toHaveLength(1);
    },
  );
  it.each(['backend-staging', 'reserved', ' reserved-staging', 'true'])(
    'rejects unknown selector %j before mutation',
    async (mode) => {
      await seedPair();
      vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', mode);
      await expectUnavailableUnchanged();
    },
  );
  it.each(['missing projection', 'bad epoch', 'SQL logging', 'missing digest key', 'digest key reused'])(
    'fails closed on %s configuration',
    async (failure) => {
      await seedPair();
      if (failure === 'missing projection') vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', '');
      if (failure === 'bad epoch') vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1.1');
      if (failure === 'SQL logging') vi.stubEnv('DEBUG_SQL', 'true');
      if (failure === 'missing digest key') vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', '');
      if (failure === 'digest key reused') vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', process.env.NEXTAUTH_SECRET);
      await expectUnavailableUnchanged();
    },
  );
  it('rejects a missing digest key before any deletion transaction or content statement', async () => {
    await seedPair({ system: true });
    await seedBoard();
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', '');
    const before = await snapshot();
    const enterTransaction = vi.spyOn(db, 'transaction');
    await expect(remove()).rejects.toMatchObject({
      extensions: { code: 'SERVICE_UNAVAILABLE', http: { status: 503 } },
    });
    expect(enterTransaction).not.toHaveBeenCalled();
    expect(stagedFailureLogs()).toEqual([[stagedFailureLine, { failureCode: 'configuration' }]]);
    expect(await snapshot()).toEqual(before);
    expect(effects.publish).not.toHaveBeenCalled();
    expect(effects.purge).not.toHaveBeenCalled();
  });
  it('rejects an invalid fixed-owner selector before entering the deletion transaction', async () => {
    await seedPair({ system: true });
    await seedBoard();
    vi.stubEnv('CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE', 'invalid-coordination-mode');
    const before = await snapshot();
    const enterTransaction = vi.spyOn(db, 'transaction');
    await expect(remove()).rejects.toMatchObject({
      extensions: { code: 'SERVICE_UNAVAILABLE', http: { status: 503 } },
    });
    expect(enterTransaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(effects.publish).not.toHaveBeenCalled();
    expect(effects.purge).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'reserved-staging'])(
    'rejects a busy fixed-owner key before the held account lock, without deletion or replay in %s',
    async (mode) => {
      await seedPair({ system: true });
      await seedBoard();
      vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', mode);
      // Staged deletion always participates, even with conditional content off.
      vi.stubEnv('CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE', mode === 'legacy' ? 'cooperative-staging' : 'legacy');
      const before = await snapshot();
      const actualCode = postgresErrors.getPostgresErrorCode;
      const observedFailureCodes: string[] = [];
      const retryInspection = vi.spyOn(postgresErrors, 'getPostgresErrorCode').mockImplementation((error) => {
        const code = actualCode(error);
        if (code) observedFailureCodes.push(code);
        return code;
      });
      const entered = barrier(),
        release = barrier();
      const held = track(
        drizzle(blocker).transaction(async (transaction) => {
          await lockFixedSystemOwnerTransaction(transaction as unknown as FixedSystemOwnerTransaction);
          await lockSprayWallAccount(transaction, ownerId);
          entered.release();
          await release.promise;
        }),
      );
      try {
        await bounded(entered.promise);
        await expect(bounded(remove(), 3_000)).rejects.toMatchObject({
          extensions: { code: 'SERVICE_UNAVAILABLE', http: { status: 503 } },
        });
        expect(retryInspection).toHaveBeenCalledTimes(1);
        // Staged core throws its domain error before the outer GraphQL catch;
        // legacy content already passes through the GraphQL boundary adapter.
        expect(observedFailureCodes).toEqual(mode === 'reserved-staging' ? ['busy'] : []);
        expect(await snapshot()).toEqual(before);
        expect(effects.publish).not.toHaveBeenCalled();
        expect(effects.purge).not.toHaveBeenCalled();
      } finally {
        release.release();
        await bounded(held);
      }
    },
  );

  it.each(['legacy', 'reserved-staging'])(
    'ends partner connections through the cascade when %s deletion commits, and leaves other climbers',
    async (mode) => {
      await seedPair();
      vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', mode);
      const clientId = await createApp(otherId);
      const ownerRows = await attachPartnerState(ownerId, clientId);
      const bystander = await attachPartnerState(otherId, clientId);

      expect(await remove()).toBe(true);

      expect(countsOf(await readPartnerState(ownerRows))).toEqual({
        connections: 0,
        subjects: 0,
        sessions: 0,
        grants: 0,
        pendingCodes: 1, // Keyed by the grant, not the user: unredeemable once its session is gone.
        refreshTokens: 0,
        accessTokens: 0,
        consents: 0,
        ancestors: 0,
        interactions: 0,
      });
      expect(countsOf(await readPartnerState(bystander))).toEqual(INTACT_COUNTS);
    },
  );

  it('commits owned-key tombstone/event with the real users DELETE and refresh cascades', async () => {
    await seedPair();
    await db.delete(logbookChanges);
    await db.insert(logbookChanges).values([
      { userId: ownerId, tickUuid: 'owned-delete-change' },
      { userId: otherId, tickUuid: 'owned-delete-survivor-change' },
    ]);
    const before = await snapshot();
    expect(await remove()).toBe(true);
    const after = await snapshot();
    expect(after.users.map((user) => user.id)).toEqual([otherId]);
    // The staged path shares the mounted deletion transaction, including this purge.
    expect(await db.select({ userId: logbookChanges.userId }).from(logbookChanges)).toEqual([{ userId: otherId }]);
    for (const field of ['credentials', 'accounts', 'sessions', 'profiles', 'refresh'] as const)
      expect(after[field]).toEqual(before[field].filter((row) => row.userId === otherId));
    expect(after.members).toEqual(before.members.filter((row) => row.userId !== ownerId));
    expect(after.reservations.some((row) => row.normalizedEmail === normalizeAccountEmail(ownerEmail))).toBe(false);
    expect(after.reservations.find((row) => row.normalizedEmail === retiredKey(ownerEmail))).toMatchObject({
      state: 'blocked_deleted',
      ownerUserId: null,
      basisProjectionId: authority.expectedProjectionId,
    });
    expect(after.cutoffs).toHaveLength(1);
    expect(after.cutoffs[0]).toMatchObject({ userId: ownerId, generation: 1 });
    expect(after.cutoffs[0].deletedAt).toBeInstanceOf(Date);
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      userId: ownerId,
      previousGeneration: 0,
      generation: 1,
      kind: 'account-deletion',
      domains: ['first-party', 'partner'],
      writerEpoch: 1,
      projectionId: authority.expectedProjectionId,
    });
    expect(after.events[0].operationId).toBe(after.cutoffs[0].lastOperationId);
  });
  it('rolls back all mounted content/security/refresh work on an actual final DELETE constraint fault', async () => {
    await seedPair({ system: true });
    await seedBoard();
    await installFault();
    let physicalError: unknown;
    try {
      await db.delete(users).where(eq(users.id, ownerId));
    } catch (error) {
      physicalError = error;
    }
    expect(postgresErrors.getPostgresErrorCode(physicalError)).toBe('23514');
    await expectUnavailableUnchanged();
  });
  it.each(['native JWS', 'legacy NextAuth JWE'])(
    'runs actual Yoga authentication, schema and deletion for %s',
    async (kind) => {
      await seedPair();
      const secret = process.env.NEXTAUTH_SECRET;
      if (!secret) throw new Error('Owned transport requires its fixture signing secret');
      const token =
        kind === 'native JWS'
          ? await new SignJWT({ sub: ownerId })
              .setProtectedHeader({ alg: 'HS256' })
              .setIssuer('boardsesh')
              .setAudience('boardsesh-mobile')
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(new TextEncoder().encode(secret))
          : await publicJwt.encode({ token: { sub: ownerId, authSessionId: randomUUID() }, secret, maxAge: 300 });
      const response = await track(
        Promise.resolve(
          createYogaInstance().fetch('http://localhost/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ query: 'mutation { deleteAccount(input: { removeSetterName: false }) }' }),
          }),
        ),
      );
      const reply = (await response.json()) as { data?: { deleteAccount?: boolean }; errors?: unknown[] };
      expect(response.status).toBe(200);
      expect(reply.data?.deleteAccount).toBe(true);
      expect(reply.errors).toBeUndefined();
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
      const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
      expect(cutoff.deletedAt).toBeInstanceOf(Date);
      expect(
        await db.select().from(authSecurityMutationEvents).where(eq(authSecurityMutationEvents.userId, ownerId)),
      ).toHaveLength(1);
      expect(await db.select().from(users).where(eq(users.id, otherId))).toHaveLength(1);
    },
  );
  it.each([undefined, 'definitely-invalid'])(
    'does not mutate through Yoga with missing/invalid credential %j',
    async (token) => {
      await seedPair();
      const before = await snapshot();
      const response = await track(
        Promise.resolve(
          createYogaInstance().fetch('http://localhost/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ query: 'mutation { deleteAccount(input: { removeSetterName: false }) }' }),
          }),
        ),
      );
      const reply = (await response.json()) as { data?: { deleteAccount?: unknown }; errors?: unknown[] };
      expect(reply.data?.deleteAccount === true).toBe(false);
      expect(reply.errors?.length).toBeGreaterThan(0);
      expect(await snapshot()).toEqual(before);
    },
  );
  it('retains and scrubs actual board parents under the same staged transaction', async () => {
    await seedPair({ system: true });
    const board = await seedBoard();
    expect(await remove()).toBe(true);
    const [retained] = await db.select().from(userBoards).where(eq(userBoards.id, board.id));
    expect(retained).toMatchObject({
      ownerId: systemId,
      name: 'Deleted board',
      description: null,
      latitude: null,
      longitude: null,
      isPublic: false,
      isUnlisted: false,
      hideLocation: true,
    });
    expect(retained.deletedAt).toBeInstanceOf(Date);
    expect(retained.syncFrozenAt).toBeInstanceOf(Date);
    expect(effects.publish).toHaveBeenCalledExactlyOnceWith(board.id);
  });
  it.each([
    'missing key',
    'old basis',
    'foreign owner',
    'missing member',
    'wrong member',
    'extra member',
    'retired key',
    'changed email',
  ])('rejects represented-email drift: %s', async (drift) => {
    await seedPair();
    const key = normalizeAccountEmail(ownerEmail);
    if (drift === 'missing key') {
      await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.normalizedEmail, key));
      await db.delete(authEmailReservations).where(eq(authEmailReservations.normalizedEmail, key));
    } else if (drift === 'old basis') {
      const previousId = randomUUID();
      await db.insert(authEmailProjection).values({
        projectionId: previousId,
        isCurrent: false,
        normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
        phase: 'prepared',
        preparedAt: new Date(),
        writerEpoch: 1,
      });
      await db
        .update(authEmailReservations)
        .set({ basisProjectionId: previousId })
        .where(eq(authEmailReservations.normalizedEmail, key));
    } else if (drift === 'foreign owner') {
      await db
        .update(authEmailReservations)
        .set({ ownerUserId: otherId })
        .where(eq(authEmailReservations.normalizedEmail, key));
    } else if (drift === 'missing member' || drift === 'wrong member') {
      await db
        .delete(authEmailReservationMembers)
        .where(
          and(eq(authEmailReservationMembers.normalizedEmail, key), eq(authEmailReservationMembers.userId, ownerId)),
        );
      if (drift === 'wrong member')
        await db.insert(authEmailReservationMembers).values({ normalizedEmail: key, userId: otherId });
    } else if (drift === 'extra member') {
      await db.insert(authEmailReservationMembers).values({ normalizedEmail: key, userId: otherId });
    } else if (drift === 'retired key') {
      await db
        .update(authEmailReservations)
        .set({ state: 'blocked_deleted', ownerUserId: null })
        .where(eq(authEmailReservations.normalizedEmail, key));
    } else {
      await db.update(users).set({ email: 'changed-after-projection@example.test' }).where(eq(users.id, ownerId));
    }
    await expectUnavailableUnchanged();
  });
  it.each(['wrong projection', 'wrong epoch', 'not enforced', 'missing manifest'])(
    'rejects %s without altering account/content state',
    async (drift) => {
      await seedPair();
      if (drift === 'wrong projection') vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', randomUUID());
      else if (drift === 'wrong epoch') vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '2');
      else if (drift === 'not enforced') await db.update(authEmailProjection).set({ phase: 'prepared' });
      else {
        await db.delete(authEmailReservationMembers);
        await db.delete(authEmailReservations);
        await db.delete(authEmailProjection);
      }
      await expectUnavailableUnchanged();
    },
  );
  it('deletes a known ambiguous member without releasing the group or electing the survivor', async () => {
    await seedPair({ collision: true });
    const before = await snapshot();
    expect(before.reservations).toHaveLength(1);
    expect(before.members).toHaveLength(2);
    expect(await remove()).toBe(true);
    const after = await snapshot();
    expect(after.reservations).toEqual(before.reservations);
    expect(after.reservations[0]).toMatchObject({ state: 'blocked_ambiguous', ownerUserId: null });
    // The survivor keeps its membership; nothing links the deleted account to the address.
    expect(after.members).toEqual(before.members.filter((row) => row.userId !== ownerId));
    expect(after.users.map((user) => user.id)).toEqual([otherId]);
    expect(after.cutoffs[0]).toMatchObject({ userId: ownerId, generation: 1 });
  });
  it('deletes the last member of a collision and leaves only the digest of its address', async () => {
    await seedPair({ collision: true });
    const key = normalizeAccountEmail(ownerEmail);
    expect(await remove()).toBe(true);
    expect(await remove(otherId)).toBe(true);
    const after = await snapshot();
    expect(after.users).toEqual([]);
    expect(after.members).toEqual([]);
    expect(after.reservations.map((row) => [row.normalizedEmail, row.state, row.ownerUserId])).toEqual([
      [retiredKey(key), 'blocked_deleted', null],
    ]);
    expect(after.cutoffs.map((cutoff) => cutoff.userId).sort()).toEqual([ownerId, otherId].sort());
  });
  it('retains the invalid empty-key history for its exact deleted member', async () => {
    await seedPair({ invalid: true });
    const before = await snapshot();
    expect(before.reservations.find((row) => row.normalizedEmail === '')).toMatchObject({
      state: 'blocked_invalid',
      ownerUserId: null,
    });
    expect(await remove()).toBe(true);
    const after = await snapshot();
    expect(after.reservations).toEqual(before.reservations);
    expect(after.members).toEqual(before.members);
    expect(after.users.some((user) => user.id === ownerId)).toBe(false);
  });
  it('rejects blocked groups that no longer contain the authenticated member', async () => {
    await seedPair({ collision: true });
    await db
      .insert(authEmailReservationMembers)
      .values({ normalizedEmail: normalizeAccountEmail(ownerEmail), userId: '!retained-history' });
    await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.userId, ownerId));
    expect(
      await db
        .select()
        .from(authEmailReservationMembers)
        .where(eq(authEmailReservationMembers.normalizedEmail, normalizeAccountEmail(ownerEmail))),
    ).toHaveLength(2);
    await expectUnavailableUnchanged();
  });
  it('accepts its exact ambiguous member beyond the first two retained histories', async () => {
    await seedPair({ collision: true });
    const key = normalizeAccountEmail(ownerEmail);
    await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.normalizedEmail, key));
    await db
      .insert(authEmailReservationMembers)
      .values(
        ['!history-first', '!history-second', otherId, ownerId].map((userId) => ({ normalizedEmail: key, userId })),
      );
    const firstTwo = await db
      .select({ userId: authEmailReservationMembers.userId })
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, key))
      .limit(2);
    expect(firstTwo.some((member) => member.userId === ownerId)).toBe(false);
    const before = await snapshot();
    expect(await remove()).toBe(true);
    const after = await snapshot();
    expect(after.members).toEqual(before.members.filter((row) => row.userId !== ownerId));
    expect(after.reservations).toEqual(before.reservations);
    expect(after.users.map((user) => user.id)).toEqual([otherId]);
  });
  it('erases receipts and every held address down to a digest, keeping generations and OAuth evidence', async () => {
    await seedPair();
    const alias = 'historical-owner-alias@example.test';
    await db.insert(authEmailReservations).values({
      normalizedEmail: alias,
      basisProjectionId: authority.expectedProjectionId,
      state: 'owned',
      ownerUserId: ownerId,
    });
    await db.insert(authEmailReservationMembers).values({ normalizedEmail: alias, userId: ownerId });
    await db.transaction((transaction) =>
      issueEmailVerification(transaction, { ...authority, emailVerificationEnabled: true }, ownerId),
    );
    const recovery = await requestPasswordRecovery(
      db,
      { ...authority, emailVerificationEnabled: false },
      {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'forgot-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { email: ownerEmail },
      },
    );
    if (recovery.outcome !== 'accepted' || !recovery.mailPlan)
      throw new Error('Owned history fixture expected real recovery issuance');
    const issuedAt = new Date();
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    await db.insert(authWebOAuthIntents).values({
      intentHash: hash,
      flowHash: hash,
      provider: 'google',
      actorUserId: ownerId,
      actorLineageHash: hash,
      actorObservedGeneration: 0,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 60000),
    });
    await db
      .insert(authWebOAuthCommands)
      .values({ commandHash: hash, operation: 'intent', issuedAt, expiresAt: new Date(issuedAt.getTime() + 60000) });
    await db.insert(verificationTokens).values({
      identifier: `password-reset:${ownerEmail}`,
      token: randomUUID(),
      expires: new Date(issuedAt.getTime() + 7 * 86400000),
    });
    const before = await snapshot();
    expect(await remove()).toBe(true);
    const after = await snapshot();
    // Purpose generations stay, so no old receipt snapshot can come back.
    for (const field of [
      'verificationState',
      'recoveryState',
      'oauthIntents',
      'oauthCommands',
      'legacyReceipts',
    ] as const)
      expect(after[field]).toEqual(before[field]);
    expect(before.verificationReceipts).toHaveLength(1);
    expect(before.recoveryReceipts).toHaveLength(1);
    expect(after.verificationReceipts).toEqual([]);
    expect(after.recoveryReceipts).toEqual([]);
    expect(after.members).toEqual(before.members.filter((row) => row.userId !== ownerId));
    for (const address of [alias, ownerEmail]) {
      expect(after.reservations.some((row) => row.normalizedEmail === normalizeAccountEmail(address))).toBe(false);
      expect(after.reservations.find((row) => row.normalizedEmail === retiredKey(address))).toMatchObject({
        state: 'blocked_deleted',
        ownerUserId: null,
      });
    }
    expect(after.cutoffs[0].deletedAt).toBeInstanceOf(Date);
  });
  it('keeps no address or account ID of the deleted climber in the four email tables', async () => {
    await seedPair();
    const alias = `Second.${ownerId}@Alias.Example.TEST`;
    await db.insert(authEmailReservations).values({
      normalizedEmail: normalizeAccountEmail(alias),
      basisProjectionId: authority.expectedProjectionId,
      state: 'owned',
      ownerUserId: ownerId,
    });
    await db
      .insert(authEmailReservationMembers)
      .values({ normalizedEmail: normalizeAccountEmail(alias), userId: ownerId });
    await db.transaction((transaction) => issueEmailVerification(transaction, verificationAuthority(), ownerId));
    await issueOwnerRecoveryToken();
    expect(await db.select().from(authPasswordRecoveryTokens)).toHaveLength(1);
    expect(await db.select().from(authEmailVerificationTokens)).toHaveLength(1);
    expect(await remove()).toBe(true);
    const tables = {
      recoveryReceipts: await db.select().from(authPasswordRecoveryTokens),
      verificationReceipts: await db.select().from(authEmailVerificationTokens),
      reservations: await db.select().from(authEmailReservations),
      members: await db.select().from(authEmailReservationMembers),
    };
    // Both addresses embed the account ID, so this also covers their local parts.
    const stored = JSON.stringify(tables).toLowerCase();
    for (const trace of [ownerId, normalizeAccountEmail(ownerEmail), normalizeAccountEmail(alias)])
      expect(stored.includes(trace)).toBe(false);
    expect(tables.recoveryReceipts).toEqual([]);
    expect(tables.verificationReceipts).toEqual([]);
    expect(tables.reservations.map((row) => row.normalizedEmail).sort()).toEqual(
      [`${otherId}@other.example.test`, retiredKey(ownerEmail), retiredKey(alias)].sort(),
    );
    expect(tables.members).toEqual([
      { normalizedEmail: `${otherId}@other.example.test`, userId: otherId, observedAt: expect.any(Date) },
    ]);
  });
  it('blocks the deleted address from a new account until the maintenance job drops its digest at 90 days', async () => {
    await seedPair();
    expect(await remove()).toBe(true);
    const digest = retiredKey(ownerEmail);
    const reserve = (requestedUserId: string) =>
      db.transaction((transaction) =>
        reserveEnforcedEmail(transaction, { ...authority, rawEmail: ownerEmail.toUpperCase(), requestedUserId }),
      );
    const register = () =>
      db.transaction((transaction) =>
        insertReservedPasswordIdentity(transaction, authority, {
          email: ownerEmail,
          prepared: null,
          emailVerificationEnabled: false,
        }),
      );
    const ageDigest = (days: number) =>
      db
        .update(authEmailReservations)
        .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
        .where(eq(authEmailReservations.normalizedEmail, digest));
    await expect(reserve(randomUUID())).rejects.toMatchObject({ code: 'EMAIL_RETIRED' });
    expect(await register()).toEqual({ outcome: 'exists' });

    await ageDigest(89);
    await clearExpiredAuthRecords(db);
    await expect(reserve(randomUUID())).rejects.toMatchObject({ code: 'EMAIL_RETIRED' });

    await ageDigest(91);
    await clearExpiredAuthRecords(db);
    expect(
      await db.select().from(authEmailReservations).where(eq(authEmailReservations.normalizedEmail, digest)),
    ).toEqual([]);
    const newcomer = randomUUID();
    await expect(reserve(newcomer)).resolves.toMatchObject({ ownerUserId: newcomer });
  });
  it('does not manufacture a tombstone when the authenticated UID is absent', async () => {
    await seedPair();
    await db.delete(users).where(eq(users.id, ownerId));
    await expectUnavailableUnchanged();
  });
  it('does not delete an extant user already carrying a deletion cutoff', async () => {
    await seedPair();
    await db.insert(authSubjectCutoffs).values({
      userId: ownerId,
      generation: 4,
      revokedThrough: new Date(),
      deletedAt: new Date(),
      lastOperationId: randomUUID(),
    });
    await expectUnavailableUnchanged();
  });
  it('increments the current generation without lowering an ahead-clock cutoff', async () => {
    await seedPair();
    const future = new Date(Date.now() + 86400000);
    await db
      .insert(authSubjectCutoffs)
      .values({ userId: ownerId, generation: 7, revokedThrough: future, lastOperationId: randomUUID() });
    expect(await remove()).toBe(true);
    const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
    expect(cutoff.generation).toBe(8);
    expect(cutoff.revokedThrough.getTime()).toBe(future.getTime());
    expect(cutoff.deletedAt).toBeInstanceOf(Date);
  });
  it('rejects a reused security operation and rolls back preceding actual writes', async () => {
    await seedPair();
    const operationId = randomUUID();
    await db.transaction((transaction) =>
      recordSecurityMutation(transaction, {
        ...authority,
        operationId,
        userId: ownerId,
        expectedGeneration: 0,
        kind: 'password-change',
        domains: ['first-party', 'partner'],
      }),
    );
    const before = await snapshot();
    const command = captureAccountDeletionCommand(authority, ownerId, operationId);
    await expect(
      db.transaction(async (transaction) => {
        await beginReservedAccountDeletion(transaction, command);
        const subject = await requireLockedSubject(transaction, command);
        await transaction.update(users).set({ name: 'Must roll back' }).where(eq(users.id, ownerId));
        await recordReservedAccountDeletion(transaction, command, subject);
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_OPERATION' });
    expect(await snapshot()).toEqual(before);
  });
  it('captures immutable authority but reads the generation at the late recording boundary', async () => {
    await seedPair();
    const supplied = { ...authority };
    const command = captureAccountDeletionCommand(supplied, ownerId, randomUUID());
    supplied.expectedWriterEpoch = 999;
    expect(Object.isFrozen(command)).toBe(true);
    expect(command.expectedWriterEpoch).toBe(1);
    await db.transaction((transaction) =>
      recordSecurityMutation(transaction, {
        ...authority,
        operationId: randomUUID(),
        userId: ownerId,
        expectedGeneration: 0,
        kind: 'password-reset',
        domains: ['first-party', 'partner'],
      }),
    );
    await db.transaction(async (transaction) => {
      await beginReservedAccountDeletion(transaction, command);
      const subject = await requireLockedSubject(transaction, command);
      await transaction.delete(users).where(eq(users.id, ownerId));
      await recordReservedAccountDeletion(transaction, command, subject);
    });
    const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
    expect(cutoff.generation).toBe(2);
    expect(cutoff.lastOperationId).toBe(command.operationId);
    expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
  });
  it('retains the server operation UUID across a PostgreSQL deadlock-class rollback', async () => {
    await seedPair();
    await installRetryFault();
    const actualCode = postgresErrors.getPostgresErrorCode;
    const attemptedOperations: string[] = [];
    vi.spyOn(postgresErrors, 'getPostgresErrorCode').mockImplementation((error) => {
      const code = actualCode(error);
      if (code === '40P01') {
        const detail = errorDetail(error);
        if (detail && /^[a-f0-9-]{36}$/.test(detail)) attemptedOperations.push(detail);
      }
      return code;
    });
    expect(await remove()).toBe(true);
    const [attempts] = await observer.unsafe<{ attempts: string }[]>(
      `SELECT last_value::text AS attempts FROM ${sequenceName}`,
    );
    const events = await db
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, ownerId));
    expect(attempts.attempts).toBe('2');
    expect(attemptedOperations).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].operationId).toBe(attemptedOperations[0]);
    expect(events[0].generation).toBe(1);
    // The trigger injects real SQLSTATE40P01 after the tentative event INSERT;
    // this proves rollback/retry identity, not an actual multi-lock deadlock.
  });
  it('times out behind an authority switch before content work and keeps all rows unchanged', async () => {
    await seedPair({ system: true });
    await seedBoard();
    const defaults = await executeFirstRow<{ lockTimeout: string; statementTimeout: string }>(
      db,
      sql`SELECT current_setting('lock_timeout') AS "lockTimeout", current_setting('statement_timeout') AS "statementTimeout"`,
    );
    expect(defaults).toEqual({ lockTimeout: '0', statementTimeout: '0' });
    const actualCode = postgresErrors.getPostgresErrorCode;
    const observedCodes = new Set<string>();
    vi.spyOn(postgresErrors, 'getPostgresErrorCode').mockImplementation((error) => {
      const code = actualCode(error);
      if (code) observedCodes.add(code);
      return code;
    });
    const arrived = barrier(),
      release = barrier();
    let backendPid = 0;
    const held = track(
      drizzle(blocker).transaction(async (transaction) => {
        const row = await executeFirstRow<{ pid: number }>(transaction, sql`SELECT pg_backend_pid() AS pid`);
        if (!row) throw new Error('Owned gate blocker PID unavailable');
        backendPid = row.pid;
        // An authority switch: the gate held exclusively.
        await lockAuthorityGateExclusively(transaction);
        arrived.release();
        await release.promise;
      }),
    );
    let deletion: Promise<boolean> | undefined;
    try {
      await bounded(
        Promise.race([
          arrived.promise,
          held.then(() => {
            throw new Error('Gate blocker ended early');
          }),
        ]),
      );
      const before = await snapshot();
      const started = performance.now();
      deletion = remove();
      await waitForBlocker(backendPid, deletion);
      const error: unknown = await bounded(
        deletion.then(
          () => undefined,
          (caught) => caught,
        ),
        8000,
      );
      const elapsed = performance.now() - started;
      expect(error).toMatchObject({
        message: 'Account deletion is temporarily unavailable.',
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
      expect(observedCodes.has('55P03')).toBe(true);
      expect(observedCodes.has('57014')).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(3500);
      expect(elapsed).toBeLessThan(8000);
      const [stillHeld] = await observer<
        { held: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${backendPid} AND locktype='advisory' AND classid=${AUTHORITY_GATE_NAMESPACE}::oid AND objid=${AUTHORITY_GATE_KEY}::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS held`;
      expect(stillHeld.held).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect(effects.publish).not.toHaveBeenCalled();
      expect(effects.purge).not.toHaveBeenCalled();
    } finally {
      release.release();
      await bounded(Promise.allSettled([held, ...(deletion ? [deletion] : [])]));
    }
    // This proves the mounted configured lock wait, not a whole-request SLA.
  }, 15000);
  it('does not take the user lock before the existing account lock and captures configuration once', async () => {
    await seedPair();
    const arrived = barrier(),
      release = barrier();
    let backendPid = 0;
    const held = track(
      drizzle(blocker).transaction(async (transaction) => {
        const row = await executeFirstRow<{ pid: number }>(transaction, sql`SELECT pg_backend_pid() AS pid`);
        if (!row) throw new Error('Owned account blocker PID unavailable');
        backendPid = row.pid;
        await lockSprayWallAccount(transaction, ownerId);
        arrived.release();
        await release.promise;
      }),
    );
    let deletion: Promise<boolean> | undefined;
    let refreshInsert: Promise<unknown> | undefined;
    try {
      await bounded(
        Promise.race([
          arrived.promise,
          held.then(() => {
            throw new Error('Account blocker ended early');
          }),
        ]),
      );
      deletion = remove();
      await waitForBlocker(backendPid, deletion);
      vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', 'legacy');
      vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', 'changed-after-capture');
      vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '999');
      refreshInsert = track(
        db
          .insert(mobileRefreshTokens)
          .values({
            id: randomUUID(),
            userId: ownerId,
            tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
            expiresAt: new Date(Date.now() + 60000),
          })
          .then(() => undefined),
      );
      await bounded(refreshInsert, 1500); // Real users FK KEY SHARE must still be available.
      release.release();
      await held;
      expect(await deletion).toBe(true);
      expect(await db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, ownerId))).toEqual([]);
      const [event] = await db
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, ownerId));
      expect(event).toMatchObject({ writerEpoch: 1, projectionId: authority.expectedProjectionId, generation: 1 });
    } finally {
      release.release();
      await bounded(
        Promise.allSettled([held, ...(deletion ? [deletion] : []), ...(refreshInsert ? [refreshInsert] : [])]),
      );
    }
    // This executes the FK insertion subpath, not the native refresh rotator or
    // a spray-version publisher; those existing transports remain separate QA.
  }, 15000);
  it.each(['content', 'cascade'] as const)(
    'leaves the gate free for other auth commands while parked in its %s',
    async (phase) => {
      await seedPair();
      if (phase === 'cascade') await installCascadeTrigger(`PERFORM pg_advisory_xact_lock(${cascadeGateKey});`);
      const hold = await holdOnBlocker((transaction) =>
        phase === 'content'
          ? lockSprayWallAccount(transaction, ownerId)
          : transaction.execute(sql`SELECT pg_advisory_xact_lock(${cascadeGateKey})`),
      );
      let deletion: Promise<boolean> | undefined;
      try {
        deletion = remove();
        await waitForBlocker(hold.backendPid, deletion);
        expect(await db.select().from(authSubjectCutoffs)).toEqual([]);
        // Takes the gate a password sign-in takes, with its 4 s limit.
        await bounded(preflight(drizzle(observer), authority), 1500);
        hold.release();
        await hold.held;
        expect(await bounded(deletion)).toBe(true);
        expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
        const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
        expect(cutoff.deletedAt).toBeInstanceOf(Date);
      } finally {
        hold.release();
        await bounded(Promise.allSettled([hold.held, ...(deletion ? [deletion] : [])]));
      }
    },
    15000,
  );
  it('rolls everything back when the projection changes while content runs', async () => {
    await seedPair();
    const hold = await holdOnBlocker((transaction) => lockSprayWallAccount(transaction, ownerId));
    let deletion: Promise<boolean> | undefined;
    try {
      deletion = remove();
      await waitForBlocker(hold.backendPid, deletion);
      await bounded(
        db
          .update(authEmailProjection)
          .set({ writerEpoch: 2 })
          .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId))
          .then(() => undefined),
        1500,
      );
      const before = await snapshot();
      hold.release();
      await hold.held;
      await expect(bounded(deletion)).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
      expect(await snapshot()).toEqual(before);
      expect(before.users.some((user) => user.id === ownerId)).toBe(true);
      expect(stagedFailureLogs()).toEqual([[stagedFailureLine, { failureCode: 'STALE_AUTHORITY' }]]);
      expect(effects.publish).not.toHaveBeenCalled();
      expect(effects.purge).not.toHaveBeenCalled();
    } finally {
      hold.release();
      await bounded(Promise.allSettled([hold.held, ...(deletion ? [deletion] : [])]));
    }
  }, 15000);
  it('holds the gate from its first statement, so a switch gives up rather than land between content and bookkeeping', async () => {
    await seedPair({ system: true });
    await seedBoard();
    const accountHold = await holdOnBlocker((transaction) => lockSprayWallAccount(transaction, ownerId));
    let deletion: Promise<boolean> | undefined;
    try {
      // Parked in content, past the gate and the manifest check.
      deletion = remove();
      await waitForBlocker(accountHold.backendPid, deletion);
      const startedAt = performance.now();
      const switching = await bounded(
        db
          .transaction(async (transaction) => {
            await lockAuthorityGateExclusively(transaction);
            await transaction
              .update(authEmailProjection)
              .set({ writerEpoch: 2 })
              .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId));
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
        5000,
      );
      expect(postgresErrors.getPostgresErrorCode(switching)).toBe('55P03');
      expect(performance.now() - startedAt).toBeLessThan(4000);
      accountHold.release();
      await accountHold.held;
      expect(await bounded(deletion)).toBe(true);
      expect(stagedFailureLogs()).toEqual([]);
      expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
      const [manifest] = await db.select().from(authEmailProjection);
      expect(manifest.writerEpoch).toBe(1);
      const [event] = await db
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, ownerId));
      expect(event).toMatchObject({ writerEpoch: 1, kind: 'account-deletion' });
    } finally {
      accountHold.release();
      await bounded(Promise.allSettled([accountHold.held, ...(deletion ? [deletion] : [])]));
    }
  }, 20000);
  it('lets the cascade run past the 5 s authority statement limit', async () => {
    await seedPair();
    await installCascadeTrigger('PERFORM pg_sleep(5.2);');
    expect(await bounded(remove(), 12000)).toBe(true);
    expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
    const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
    expect(cutoff.deletedAt).toBeInstanceOf(Date);
  }, 20000);
  it('lets content wait past the 4 s authority lock limit', async () => {
    await seedPair({ system: true });
    const board = await seedBoard();
    const hold = await holdOnBlocker((transaction) =>
      transaction.execute(sql`SELECT 1 FROM ${userBoards} WHERE ${userBoards.id} = ${board.id} FOR UPDATE`),
    );
    let deletion: Promise<boolean> | undefined;
    try {
      deletion = remove();
      await waitForBlocker(hold.backendPid, deletion);
      await new Promise((resolve) => setTimeout(resolve, 4500));
      hold.release();
      await hold.held;
      expect(await bounded(deletion)).toBe(true);
      const [retained] = await db.select().from(userBoards).where(eq(userBoards.id, board.id));
      expect(retained.ownerId).toBe(systemId);
    } finally {
      hold.release();
      await bounded(Promise.allSettled([hold.held, ...(deletion ? [deletion] : [])]));
    }
  }, 20000);
  it('reports success and writes nothing when a retry finds its deletion committed', async () => {
    await seedPair({ system: true });
    await seedBoard();
    const enqueue = vi.spyOn(posthogPersonDeletion, 'enqueuePosthogPersonDeletion');
    expect(await remove()).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(effects.publish).toHaveBeenCalledTimes(1);
    const committed = await snapshot();
    expect(await remove()).toBe(true);
    expect(await snapshot()).toEqual(committed);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(effects.publish).toHaveBeenCalledTimes(1);
    expect(stagedFailureLogs()).toEqual([]);
  });
  it('reports success to both callers and records one event when two deletions race', async () => {
    await seedPair();
    const hold = await holdOnBlocker((transaction) => lockSprayWallAccount(transaction, ownerId));
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    try {
      first = remove();
      second = remove();
      await waitForBlocker(hold.backendPid, Promise.race([first, second]));
      hold.release();
      await hold.held;
      expect(await bounded(Promise.all([first, second]))).toEqual([true, true]);
      expect(
        await db.select().from(authSecurityMutationEvents).where(eq(authSecurityMutationEvents.userId, ownerId)),
      ).toHaveLength(1);
      const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
      expect(cutoff.generation).toBe(1);
      expect(stagedFailureLogs()).toEqual([]);
    } finally {
      hold.release();
      await bounded(Promise.allSettled([hold.held, ...(first ? [first] : []), ...(second ? [second] : [])]));
    }
  }, 15000);
  it.each([
    [
      'a Postgres failure',
      '23514',
      async () => {
        await installFault();
      },
    ],
    [
      'a foundation rejection',
      'RESERVATION_INCONSISTENT',
      async () => {
        const key = normalizeAccountEmail(ownerEmail);
        await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.normalizedEmail, key));
        await db.delete(authEmailReservations).where(eq(authEmailReservations.normalizedEmail, key));
      },
    ],
    [
      'bad configuration',
      'configuration',
      async () => {
        vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1.1');
      },
    ],
  ] as const)('logs one fixed line with no identity for %s', async (_name, failureCode, breakDeletion) => {
    await seedPair();
    await breakDeletion();
    await expectUnavailableUnchanged();
    const logged = stagedFailureLogs();
    expect(logged).toEqual([[stagedFailureLine, { failureCode }]]);
    for (const secret of [ownerId, ownerEmail, normalizeAccountEmail(ownerEmail), privateMarker]) {
      expect(JSON.stringify(logged)).not.toContain(secret);
    }
  });
  it('leaves a legacy deletion failure unmasked and unlogged', async () => {
    await seedPair();
    await installFault();
    vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', 'legacy');
    let failure: unknown;
    try {
      await remove();
    } catch (caught) {
      failure = caught;
    }
    expect(postgresErrors.getPostgresErrorCode(failure)).toBe('23514');
    expect(stagedFailureLogs()).toEqual([]);
  });
  it.each(commandsNamingTheAccount)(
    '%s waits on the account being deleted, leaves the gate free and gives up on its own limit',
    async (_name, prepare) => {
      await seedPair();
      const run = await prepare();
      await installCascadeTrigger(`PERFORM pg_advisory_xact_lock(${cascadeGateKey});`);
      const gate = await holdOnBlocker((transaction) =>
        transaction.execute(sql`SELECT pg_advisory_xact_lock(${cascadeGateKey})`),
      );
      let deletion: Promise<boolean> | undefined;
      let command: Promise<unknown> | undefined;
      try {
        deletion = remove();
        const deletionPid = await sessionWaitingOnGate(cascadeGateKey);
        command = track(run());
        const commandSettled = command.then(
          () => undefined,
          () => undefined,
        );
        // Queued on the deletion's user row, holding only the shared gate.
        const sawCommandWaiting = await waitForBlocker(deletionPid, commandSettled).then(
          () => true,
          () => false,
        );
        if (sawCommandWaiting) await bounded(preflight(drizzle(observer), authority), 1500);
        const failure: unknown = await bounded(
          command.then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(postgresErrors.getPostgresErrorCode(failure)).toBe('55P03');
        gate.release();
        await gate.held;
        expect(await bounded(deletion)).toBe(true);
        expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
      } finally {
        gate.release();
        await bounded(Promise.allSettled([gate.held, ...(deletion ? [deletion] : []), ...(command ? [command] : [])]));
      }
    },
    15000,
  );
  it('finishes its bookkeeping while a command naming the account is in flight, because that command holds nothing it needs', async () => {
    await seedPair();
    await installCascadeTrigger(`PERFORM pg_advisory_xact_lock(${cascadeGateKey});`);
    await installCommandGate();
    const enqueue = vi.spyOn(posthogPersonDeletion, 'enqueuePosthogPersonDeletion');
    const cascadeGate = await holdOnBlocker((transaction) =>
      transaction.execute(sql`SELECT pg_advisory_xact_lock(${cascadeGateKey})`),
    );
    const commandGate = await holdOnBlocker(
      (transaction) => transaction.execute(sql`SELECT pg_advisory_xact_lock(${commandGateKey})`),
      db,
    );
    let deletion: Promise<boolean> | undefined;
    let command: Promise<unknown> | undefined;
    try {
      // The deletion holds the user row and is parked inside its cascade.
      deletion = remove();
      await waitForBlocker(cascadeGate.backendPid, deletion);
      // The command holds the shared gate and its claim, parked before it reads the owner.
      command = track(
        requestPasswordRecovery(db, recoveryAuthority(), webCommand('forgot-password', { email: ownerEmail })),
      );
      await sessionWaitingOnGate(commandGateKey);
      // The old manifest lock made the deletion queue on that command here.
      cascadeGate.release();
      await cascadeGate.held;
      expect(await bounded(deletion)).toBe(true);
      commandGate.release();
      await commandGate.held;
      // It then finds the address retired: nothing to send, and no error.
      const reply = await bounded(command);
      expect(reply).toMatchObject({ outcome: 'accepted' });
      expect(reply).not.toHaveProperty('mailPlan');
      expect(enqueue).toHaveBeenCalledTimes(1);
      const events = await db
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, ownerId));
      expect(events).toHaveLength(1);
      expect(stagedFailureLogs()).toEqual([]);
    } finally {
      cascadeGate.release();
      commandGate.release();
      await bounded(
        Promise.allSettled([
          cascadeGate.held,
          commandGate.held,
          ...(deletion ? [deletion] : []),
          ...(command ? [command] : []),
        ]),
      );
    }
  }, 15000);
  it('records the generation a password change set between preflight and the final step', async () => {
    await seedPair();
    const hold = await holdOnBlocker((transaction) => lockSprayWallAccount(transaction, ownerId));
    let deletion: Promise<boolean> | undefined;
    try {
      deletion = remove();
      await waitForBlocker(hold.backendPid, deletion);
      await bounded(
        db.transaction((transaction) =>
          recordSecurityMutation(transaction, {
            ...authority,
            operationId: randomUUID(),
            userId: ownerId,
            expectedGeneration: 0,
            kind: 'password-change',
            domains: ['first-party', 'partner'],
          }),
        ),
        3000,
      );
      hold.release();
      await hold.held;
      expect(await bounded(deletion)).toBe(true);
      const events = await db
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, ownerId))
        .orderBy(authSecurityMutationEvents.generation);
      expect(events.map(({ kind, previousGeneration, generation }) => [kind, previousGeneration, generation])).toEqual([
        ['password-change', 0, 1],
        ['account-deletion', 1, 2],
      ]);
      const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, ownerId));
      expect(cutoff.generation).toBe(2);
      expect(cutoff.deletedAt).toBeInstanceOf(Date);
    } finally {
      hold.release();
      await bounded(Promise.allSettled([hold.held, ...(deletion ? [deletion] : [])]));
    }
  }, 15000);
  it.each([
    ['moved to another owner', { ownerUserId: otherId }],
    ['retired', { state: 'blocked_deleted', ownerUserId: null }],
  ] as const)(
    'rolls everything back when the reservation is %s between preflight and the final step',
    async (_change, reservationChange) => {
      await seedPair();
      const hold = await holdOnBlocker((transaction) => lockSprayWallAccount(transaction, ownerId));
      let deletion: Promise<boolean> | undefined;
      try {
        deletion = remove();
        await waitForBlocker(hold.backendPid, deletion);
        await db
          .update(authEmailReservations)
          .set(reservationChange)
          .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(ownerEmail)));
        const before = await snapshot();
        hold.release();
        await hold.held;
        await expect(bounded(deletion)).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
        expect(await snapshot()).toEqual(before);
        expect(stagedFailureLogs()).toEqual([[stagedFailureLine, { failureCode: 'RESERVATION_INCONSISTENT' }]]);
        expect(effects.publish).not.toHaveBeenCalled();
        expect(effects.purge).not.toHaveBeenCalled();
      } finally {
        hold.release();
        await bounded(Promise.allSettled([hold.held, ...(deletion ? [deletion] : [])]));
      }
    },
    15000,
  );
  it('a reset already through real bcrypt cannot restore a deleted user or credential', async () => {
    await seedPair();
    const recoveryAuthority = { ...authority, emailVerificationEnabled: false };
    const issued = await requestPasswordRecovery(db, recoveryAuthority, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'forgot-password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: ownerEmail },
    });
    if (issued.outcome !== 'accepted' || !issued.mailPlan)
      throw new Error('Owned reset race requires real recovery issuance');
    const receipts = await db.select().from(authPasswordRecoveryTokens);
    const arrived = barrier(),
      release = barrier();
    const actualHash = bcrypt.hash.bind(bcrypt);
    vi.spyOn(bcrypt, 'hash').mockImplementationOnce((async (suppliedPassword: string, rounds: number) => {
      const hashed = await actualHash(suppliedPassword, rounds);
      arrived.release();
      await release.promise;
      return hashed;
    }) as typeof bcrypt.hash);
    const reset = track(
      consumePasswordRecovery(drizzle(observer), recoveryAuthority, {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'reset-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: {
          email: 'untrusted-hint@example.test',
          token: issued.mailPlan.token,
          password: 'new-owned-deletion-password',
          confirmPassword: 'new-owned-deletion-password',
        },
      }),
    );
    try {
      await bounded(
        Promise.race([
          arrived.promise,
          reset.then(() => {
            throw new Error('Reset ended before its bcrypt barrier');
          }),
        ]),
      );
      expect(await remove()).toBe(true);
      release.release();
      const result = await reset;
      expect(result.outcome).toBe('invalid_or_expired');
      expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
      expect(await db.select().from(userCredentials).where(eq(userCredentials.userId, ownerId))).toEqual([]);
      expect(receipts).toHaveLength(1);
      expect(await db.select().from(authPasswordRecoveryTokens)).toEqual([]);
      const events = await db
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, ownerId));
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('account-deletion');
    } finally {
      release.release();
      await bounded(Promise.allSettled([reset]));
    }
  }, 15000);
});
