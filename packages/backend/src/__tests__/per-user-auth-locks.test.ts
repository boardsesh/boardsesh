import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { hash } from 'bcryptjs';
import { decodeJwt } from 'jose';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { AUTH_PROTOCOL_VERSION } from '@boardsesh/auth-protocol';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
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
  mobileRefreshTokens,
  oauthConnections,
  oauthConsentInteractions,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { boardseshTicks, logbookChanges } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { getWorkerDatabaseUrl } from './worker-db';
import { validateMobileJwt } from '../middleware/auth';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { logger } from '../utils/logger';
import {
  handleNativeAuthCredentials,
  handleNativeAuthRefresh,
  __resetNativeAuthStateForTests,
} from '../handlers/native-auth';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { prepareProjectionUnderUsersTableLock } from '../auth/current-store/email-reservations';
import {
  AUTHORITY_GATE_KEY,
  AUTHORITY_GATE_NAMESPACE,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
  lockEnforcedProjection,
} from '../auth/current-store/foundation-context';
import { transactionSettings, type WebPasswordAuthority } from '../auth/current-store/command-context';
import type { CurrentStoreTransaction } from '../auth/current-store/foundation-context';
import { authenticateWebPassword } from '../auth/current-store/web-password';
import { consumePasswordRecovery, requestPasswordRecovery } from '../auth/current-store/password-recovery';
import {
  consumeEmailVerification,
  issueEmailVerification,
  resendEmailVerification,
} from '../auth/current-store/email-verification';
import { resolveReservedCurrentStoreOAuthIdentity } from '../auth/current-store/provider-oauth-identity';
import { recordSecurityMutation } from '../auth/current-store/security-mutations';
import { endPartnerConnection } from '../auth/partner/connection';
import { lockClimber, lockCurrentGrant, lockPartnerConnection, selectConnectionForUpdate } from '../auth/partner/locks';
import { partnerAdapterSchema, type PartnerDatabase } from '../auth/partner/tables';
import {
  attachPartnerState,
  createApp,
  createUser,
  type PartnerRows,
} from '../auth/partner/__tests__/revocation-fixtures';

// BA-04 PR 3: the one manifest row every staged command locked is now a shared
// advisory gate, and a climber's own users row is the lock that serializes their
// mutations. Real handlers, real staged commands, real Postgres; each race parks
// a real transaction on an advisory key from a trigger, so it is really in flight.

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
type TokenPair = { jwt: string; refreshToken: string; userId: string; expiresAt: string };
type RawSql = ReturnType<typeof postgres>;
const FIRST_PARTY_OPERATIONS = ['staged reset', 'staged deletion', 'web sign-in', 'native refresh'] as const;
type FirstPartyOperation = (typeof FIRST_PARTY_OPERATIONS)[number];

const secret = 'per-user-auth-locks-secret-with-at-least-thirty-two-bytes';
const password = 'per-user-locks-password';
const newPassword = 'per-user-locks-new-password';
const INVALID_CREDENTIALS = { error: 'Invalid email or password' };
const routes: Record<string, Handler> = {
  '/credentials': handleNativeAuthCredentials,
  '/refresh': handleNativeAuthRefresh,
};
const fixtureName = `ba04_pr3_${randomUUID().replaceAll('-', '')}`;
const createdUserIds = new Set<string>();
const pending = new Set<Promise<unknown>>();
const installedTriggers: { table: string; name: string }[] = [];
let passwordHash: string;
let ownerId: string;
let ownerEmail: string;
let otherId: string;
let otherEmail: string;
let authority: WebPasswordAuthority;
let httpServer: Server;
let origin: string;
/** Holds the keys that park a race. One connection per role, so locks are really separate sessions. */
let blocker: RawSql;
let observer: RawSql;
/** The unrelated climber's own session: the second connection of "one deletion blocks nobody else". */
let bystander: RawSql;
let partnerConnection: RawSql;

function track<Result>(operation: Promise<Result>): Promise<Result> {
  const observed = operation.finally(() => pending.delete(observed));
  pending.add(observed);
  void observed.catch(() => undefined);
  return observed;
}

async function bounded<Result>(operation: Promise<Result>, milliseconds = 10_000): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Per-user lock fixture deadline')), milliseconds);
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

function settled<Result>(operation: Promise<Result>) {
  return operation.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

async function native(path: string, body: unknown): Promise<Response> {
  __resetNativeAuthStateForTests();
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
}

async function issued(path: string, body: unknown): Promise<TokenPair> {
  const response = await native(path, body);
  expect(response.status).toBe(200);
  return (await response.json()) as TokenPair;
}

function tokenHash(refreshToken: string) {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function webCommand<Operation extends string, Payload>(operation: Operation, payload: Payload) {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  } as const;
}

function signIn(database: DbInstance, email: string, submitted: string) {
  return authenticateWebPassword(database, authority, webCommand('password', { email, password: submitted }));
}

function deleteAccount(userId: string) {
  const context: ConnectionContext = {
    connectionId: `per-user-locks-${userId}`,
    transport: 'http',
    isAuthenticated: true,
    userId,
  };
  return userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, context);
}

async function issueRecoveryToken(email: string): Promise<string> {
  const issued = await requestPasswordRecovery(db, authority, webCommand('forgot-password', { email }));
  if (issued.outcome !== 'accepted' || !issued.mailPlan) throw new Error('Fixture expected a recovery token');
  return issued.mailPlan.token;
}

function resetPassword(database: DbInstance, token: string) {
  return consumePasswordRecovery(
    database,
    authority,
    webCommand('reset-password', { token, password: newPassword, confirmPassword: newPassword }),
  );
}

/**
 * Parks the matching row's transaction inside `timing` on `table` until the key
 * is released. Generated identifiers and fixture UUIDs only, never input.
 */
async function installPark(table: string, timing: string, condition: string, key: number) {
  const name = `${fixtureName}_${installedTriggers.length}`;
  await db.execute(
    sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $park$
      BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END; $park$`),
  );
  await db.execute(sql.raw(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`));
  installedTriggers.push({ table, name });
}

async function dropParks() {
  const triggers = installedTriggers.splice(0);
  for (const { table, name } of triggers) await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
  for (const name of new Set(triggers.map((trigger) => trigger.name)))
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
}

/** Holds `acquire` in a transaction on `connection` until released. */
async function hold(connection: RawSql, acquire: (transaction: CurrentStoreTransaction) => Promise<unknown>) {
  const arrived = barrier(),
    release = barrier();
  let pid = 0;
  const held = track(
    drizzle(connection).transaction(async (raw) => {
      const transaction = raw as unknown as CurrentStoreTransaction;
      const row = await executeFirstRow<{ pid: number }>(transaction, sql`SELECT pg_backend_pid() AS pid`);
      pid = Number(row?.pid);
      await acquire(transaction);
      arrived.release();
      await release.promise;
    }),
  );
  await bounded(
    Promise.race([
      arrived.promise,
      held.then(() => {
        throw new Error('Holder ended early');
      }),
    ]),
  );
  return { held, pid, release: release.release };
}

function holdKey(key: number) {
  return hold(blocker, (transaction) => transaction.execute(sql`SELECT pg_advisory_xact_lock(${key})`));
}

/** The backend session queued on an advisory key. */
async function waiterOn(key: number): Promise<number> {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const [row] = await observer<
      { pid: number }[]
    >`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key}::oid AND objsubid=1 AND NOT granted LIMIT 1`;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Nothing queued on the park key');
}

/** Resolves once `count` sessions are waiting for a lock `pid` holds; rejects if the operation ends first. */
async function waitBlockedBy(pid: number, operation: Promise<unknown>, count = 1) {
  let stopped = false;
  const polling = (async () => {
    while (!stopped) {
      const [row] = await observer<
        { waiting: number }[]
      >`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`;
      if (row.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  try {
    await bounded(
      Promise.race([
        polling,
        operation.then((value: unknown) => {
          throw new Error(`Operation finished before it queued behind the lock: ${String(inspectOutcome(value))}`);
        }),
      ]),
      8000,
    );
  } finally {
    stopped = true;
    await polling;
  }
}

function inspectOutcome(value: unknown): string {
  if (value && typeof value === 'object' && 'reason' in value) {
    const reason = (value as { reason: unknown }).reason;
    return `rejected ${getPostgresErrorCode(reason) ?? (reason instanceof Error ? reason.message : 'unknown')}`;
  }
  return 'fulfilled';
}

/**
 * Holds the owner's users row FOR UPDATE, as a deletion does, runs `run` until it
 * queues on that row, and checks the owner's reservation is free meanwhile: the
 * row a deletion's bookkeeping locks next, so a lock held on it would close a
 * cycle. Returns the command's settled outcome once the row is released.
 */
async function expectReservationFreeWhileWaiting(run: (database: DbInstance) => Promise<unknown>) {
  const holder = await hold(blocker, (transaction) =>
    transaction.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update'),
  );
  let command: ReturnType<typeof settled<unknown>> | undefined;
  try {
    command = track(settled(run(drizzle(bystander) as unknown as DbInstance)));
    await waitBlockedBy(holder.pid, command);
    const probe = await settled(
      observer.begin(
        (transaction) =>
          transaction`SELECT 1 FROM auth_email_reservations WHERE normalized_email = ${ownerEmail} FOR UPDATE NOWAIT`,
      ),
    );
    expect(probe.status === 'rejected' ? getPostgresErrorCode(probe.reason) : 'free').toBe('free');
  } finally {
    holder.release();
    await holder.held;
  }
  return command;
}

async function liveRefreshRows(userId: string) {
  return db
    .select()
    .from(mobileRefreshTokens)
    .where(and(eq(mobileRefreshTokens.userId, userId), isNull(mobileRefreshTokens.revokedAt)));
}

async function seedClimber(label: string) {
  const userId = randomUUID();
  const email = `locks-${label}-${userId}@example.test`;
  createdUserIds.add(userId);
  await db.insert(users).values({ id: userId, email, name: `Lock fixture ${label}` });
  await db.insert(userCredentials).values({ userId, passwordHash });
  return { userId, email };
}

/** Prepares and enforces a projection over every current account, as activation will. */
async function enforceProjection() {
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
    emailVerificationEnabled: false,
  };
  vi.stubEnv('CURRENT_STORE_ACCOUNT_DELETION_MODE', 'reserved-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
  vi.stubEnv('DEBUG_SQL', 'false');
}

async function clearAuthority() {
  await db.delete(authEmailVerificationTokens);
  await db.delete(authEmailVerificationState);
  await db.delete(authPasswordRecoveryTokens);
  await db.delete(authPasswordRecoveryState);
  await db.delete(verificationTokens);
  await db.delete(authEmailReservationMembers);
  await db.delete(authEmailReservations);
  await db.delete(authSecurityMutationEvents);
  await db.delete(authSubjectCutoffs);
  await db.delete(authEmailProjection);
  if (createdUserIds.size) await db.delete(users).where(inArray(users.id, [...createdUserIds]));
}

describe('per-user sign-in locks against the owned primary database', () => {
  beforeAll(async () => {
    passwordHash = await hash(password, 4);
    const single = { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { statement_timeout: 20_000 } };
    blocker = postgres(getWorkerDatabaseUrl(), single);
    observer = postgres(getWorkerDatabaseUrl(), single);
    bystander = postgres(getWorkerDatabaseUrl(), single);
    // One connection per partner flow in flight: three park at once below.
    partnerConnection = postgres(getWorkerDatabaseUrl(), { ...single, max: 4 });
    httpServer = createServer((request, response) => {
      const handler = routes[new URL(request.url ?? '/', 'http://localhost').pathname];
      if (!handler) {
        response.writeHead(404).end();
        return;
      }
      void track(handler(request, response)).catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Lock fixture has no TCP port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    if (pending.size) throw new Error('Previous lock fixture did not settle');
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await dropParks();
    await clearAuthority();
    ({ userId: ownerId, email: ownerEmail } = await seedClimber('owner'));
    ({ userId: otherId, email: otherEmail } = await seedClimber('other'));
    await enforceProjection();
  });

  afterEach(async () => {
    await bounded(Promise.allSettled(pending), 20_000);
    await dropParks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await clearAuthority();
    for (const connection of [blocker, observer, bystander, partnerConnection]) await connection?.end({ timeout: 3 });
    if (httpServer)
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  });

  describe('the gate', () => {
    it('is shared: two climbers in flight hold it at once and neither waits for the other', async () => {
      const first = await hold(blocker, (transaction) => lockEnforcedProjection(transaction, authority));
      try {
        const startedAt = performance.now();
        await bounded(
          db.transaction((transaction) => lockEnforcedProjection(transaction, authority)),
          2000,
        );
        expect(performance.now() - startedAt).toBeLessThan(1000);
        const [held] = await observer<
          { mode: string }[]
        >`SELECT mode FROM pg_locks WHERE pid=${first.pid} AND locktype='advisory' AND classid=${AUTHORITY_GATE_NAMESPACE}::oid AND objid=${AUTHORITY_GATE_KEY}::oid AND objsubid=2 AND granted`;
        expect(held.mode).toBe('ShareLock');
        // No row lock on the manifest: nothing for a multixact to pile onto.
        const [rowLocks] = await observer<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM pg_locks WHERE pid=${first.pid} AND relation='auth_email_projection'::regclass AND mode <> 'AccessShareLock'`;
        expect(rowLocks.count).toBe(0);
      } finally {
        first.release();
        await first.held;
      }
    });

    it('holds every command back while a switch holds it, and the command then sees the new epoch', async () => {
      const switching = await hold(blocker, async (transaction) => {
        await lockAuthorityGateExclusively(transaction);
        await transaction
          .update(authEmailProjection)
          .set({ writerEpoch: 2 })
          .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId));
      });
      let command: Promise<unknown> | undefined;
      try {
        command = track(signIn(db, otherEmail, password));
        await waitBlockedBy(switching.pid, command);
      } finally {
        switching.release();
        await switching.held;
      }
      // Validated after the wait, so the switch is never missed.
      await expect(bounded(command)).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
    });

    it('lets a switch give up after 2 s while a command holds it, and the command finishes', async () => {
      const command = await hold(blocker, (transaction) => lockEnforcedProjection(transaction, authority));
      try {
        const startedAt = performance.now();
        const failure = await bounded(
          settled(db.transaction((transaction) => lockAuthorityGateExclusively(transaction))),
          5000,
        );
        const elapsed = performance.now() - startedAt;
        expect(failure.status).toBe('rejected');
        expect(failure.status === 'rejected' && getPostgresErrorCode(failure.reason)).toBe('55P03');
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(elapsed).toBeLessThan(4000);
      } finally {
        command.release();
        await command.held;
      }
    });
  });

  describe('one deletion no longer blocks another climber', () => {
    it('keeps an unrelated sign-in fast while a deletion and a burst naming that account share its pool', async () => {
      const cascadeKey = randomInt(1, 2_147_483_647);
      await installPark('public.users', 'BEFORE DELETE', `OLD.id='${ownerId}'`, cascadeKey);
      const park = await holdKey(cascadeKey);
      let deletion: Promise<boolean> | undefined;
      const burst: Promise<{ status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown }>[] = [];
      try {
        deletion = track(deleteAccount(ownerId));
        const deletionPid = await waiterOn(cascadeKey);
        // 20 unauthenticated requests naming the account, through this process's
        // own pool (5 connections, one held by the deletion), as one backend gets them.
        for (let index = 0; index < 16; index += 1)
          burst.push(track(settled(signIn(db, ownerEmail, `wrong-${index}`))));
        for (let index = 0; index < 4; index += 1)
          burst.push(
            track(
              settled(requestPasswordRecovery(db, authority, webCommand('forgot-password', { email: ownerEmail }))),
            ),
          );
        // The forgot-passwords queue on the deletion's row and give up after 250 ms; wait to see them start.
        await bounded(
          (async () => {
            for (;;) {
              const [row] = await observer<
                { waiting: number }[]
              >`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${deletionPid}=ANY(pg_blocking_pids(pid))`;
              if (row.waiting >= 1) return;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          })(),
          3000,
        );

        // The unrelated climber, through the same pool, while all of that is queued.
        const webStartedAt = performance.now();
        const web = await bounded(signIn(db, otherEmail, password), 5000);
        const webMs = performance.now() - webStartedAt;
        const nativeStartedAt = performance.now();
        const nativePair = await bounded(issued('/credentials', { email: otherEmail, password }), 5000);
        const nativeMs = performance.now() - nativeStartedAt;
        expect(web.outcome).toBe('authenticated');
        expect(nativePair.userId).toBe(otherId);
        console.info(
          `[per-user-locks] unrelated sign-in through a shared pool: web ${webMs.toFixed(0)} ms, native ${nativeMs.toFixed(0)} ms`,
        );
        // At a 4 s limit the burst held the pool and this took about 16 s.
        expect(webMs).toBeLessThan(500);
        expect(nativeMs).toBeLessThan(500);

        // A wrong password is wrong without the row, so those answered at once.
        // A forgot-password gave up after 250 ms: 55P03, answered with the
        // retryable 503 "unavailable" reply, never a different answer.
        const outcomes = await bounded(Promise.all(burst), 8000);
        for (const outcome of outcomes.slice(0, 16)) {
          expect(outcome).toMatchObject({ status: 'fulfilled', value: { outcome: 'invalid_credentials' } });
        }
        for (const outcome of outcomes.slice(16)) {
          expect(outcome.status === 'rejected' && getPostgresErrorCode(outcome.reason)).toBe('55P03');
        }
      } finally {
        park.release();
        await park.held;
      }
      expect(await bounded(deletion!)).toBe(true);
      expect(await db.select().from(users).where(eq(users.id, ownerId))).toEqual([]);
    }, 30_000);

    it('tells a sign-in that finds the account held to retry, within 250 ms, never that the password is wrong', async () => {
      const cascadeKey = randomInt(1, 2_147_483_647);
      await installPark('public.users', 'BEFORE DELETE', `OLD.id='${ownerId}'`, cascadeKey);
      const park = await holdKey(cascadeKey);
      let deletion: Promise<boolean> | undefined;
      try {
        deletion = track(deleteAccount(ownerId));
        await waiterOn(cascadeKey);
        // The right password, so only the held row can stop it.
        const webStartedAt = performance.now();
        const web = await bounded(settled(signIn(db, ownerEmail, password)), 6000);
        const webMs = performance.now() - webStartedAt;
        expect(web.status === 'rejected' && getPostgresErrorCode(web.reason)).toBe('55P03');
        const nativeStartedAt = performance.now();
        const response = await bounded(native('/credentials', { email: ownerEmail, password }), 6000);
        const nativeMs = performance.now() - nativeStartedAt;
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication is temporarily unavailable' });
        expect(webMs).toBeLessThan(1000);
        expect(nativeMs).toBeLessThan(1000);
      } finally {
        park.release();
        await park.held;
      }
      expect(await bounded(deletion!)).toBe(true);
    }, 20_000);

    /** Unauthenticated or sign-in requests that give up on a held row after 250 ms. */
    const BOUNDED_COMMANDS = new Set(['forgot password', 'resend verification', 'web sign-in']);
    /** Commands that read the account's reservation after its users row. */
    const RESERVATION_COMMANDS = new Set([
      'forgot password',
      'password reset',
      'resend verification',
      'email verification',
    ]);

    /**
     * Each command waits on the account's users row while the deletion holds it,
     * and none holds the account's reservation while it waits, so the deletion's
     * own reservation lock at its final step cannot close a cycle with it.
     */
    const commandsNamingTheAccount: readonly (readonly [
      string,
      () => Promise<(database: DbInstance) => Promise<unknown>>,
      unknown,
    ])[] = [
      [
        'forgot password',
        async () => (database) =>
          requestPasswordRecovery(database, authority, webCommand('forgot-password', { email: ownerEmail })),
        { outcome: 'accepted' },
      ],
      [
        'password reset',
        async () => {
          const token = await issueRecoveryToken(ownerEmail);
          return (database) => resetPassword(database, token);
        },
        { outcome: 'invalid_or_expired' },
      ],
      [
        'resend verification',
        async () => (database) =>
          resendEmailVerification(
            database,
            { ...authority, emailVerificationEnabled: true },
            webCommand('resend-verification', { email: ownerEmail }),
          ),
        { outcome: 'accepted' },
      ],
      [
        'email verification',
        async () => {
          const verifying = { ...authority, emailVerificationEnabled: true };
          const plan = await db.transaction((transaction) => issueEmailVerification(transaction, verifying, ownerId));
          if (!plan) throw new Error('Fixture expected a verification token');
          return (database) =>
            consumeEmailVerification(
              database,
              verifying,
              webCommand('verify-email', { token: plan.token, email: ownerEmail }),
            );
        },
        { outcome: 'invalid_token' },
      ],
      [
        'provider sign-in',
        async () => {
          const subject = randomUUID();
          await db
            .insert(accounts)
            .values({ userId: ownerId, provider: 'google', providerAccountId: subject, type: 'oauth' });
          return (database) =>
            database.transaction(async (transaction) => {
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
        { outcome: 'deleted' },
      ],
      [
        'web sign-in',
        async () => (database) => signIn(database, ownerEmail, password),
        { outcome: 'invalid_credentials' },
      ],
    ];

    it.each(commandsNamingTheAccount)(
      '%s waits for the deletion, holding nothing it needs, and then finds the account gone',
      async (_name, prepare, expected) => {
        const run = await prepare();
        const cascadeKey = randomInt(1, 2_147_483_647);
        await installPark('public.users', 'BEFORE DELETE', `OLD.id='${ownerId}'`, cascadeKey);
        const park = await holdKey(cascadeKey);
        let deletion: Promise<boolean> | undefined;
        let command: Promise<unknown> | undefined;
        try {
          deletion = track(deleteAccount(ownerId));
          const deletionPid = await waiterOn(cascadeKey);
          command = track(run(drizzle(bystander) as unknown as DbInstance));
          await waitBlockedBy(deletionPid, command);
        } finally {
          // The deletion now runs its bookkeeping, reservation included, with the command still queued.
          park.release();
          await park.held;
        }
        expect(await bounded(deletion!)).toBe(true);
        const outcome = await bounded(settled(command!));
        if (outcome.status === 'rejected') {
          // A request that need not win may have given up first (250 ms): the
          // retryable unavailable reply, never a deadlock or a different answer.
          if (!BOUNDED_COMMANDS.has(_name) || getPostgresErrorCode(outcome.reason) !== '55P03') throw outcome.reason;
          return;
        }
        expect(outcome.value).toMatchObject(expected as Record<string, unknown>);
        expect(outcome.value).not.toHaveProperty('mailPlan');
      },
      20_000,
    );

    it.each(commandsNamingTheAccount.filter(([name]) => RESERVATION_COMMANDS.has(name)))(
      '%s holds no lock on the reservation while it waits for the climber',
      async (_name, prepare) => {
        await bounded(expectReservationFreeWhileWaiting(await prepare()));
      },
      20_000,
    );

    describe('a pre-switch link, once addresses are unique', () => {
      beforeEach(async () => {
        // The bind runs only behind BA-02's index, created as #7418's tests do.
        // Other files' leftover case-duplicates would block it; rename them.
        await db.execute(sql`UPDATE ${users} SET email = id || '@duplicate.invalid'
          WHERE lower(email) IN (SELECT lower(email) FROM ${users} GROUP BY 1 HAVING count(*) > 1)`);
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON ${users} (lower(email))`);
      });
      afterEach(async () => {
        await db.execute(sql`DROP INDEX IF EXISTS users_email_lower_key`);
      });

      it.each([
        [
          'reset link',
          async () => {
            const secret = randomUUID();
            await db.insert(verificationTokens).values({
              identifier: `password-reset:${ownerEmail}`,
              token: createHash('sha256').update(secret).digest('hex'),
              expires: new Date(Date.now() + 30 * 60_000),
            });
            return (database: DbInstance) =>
              consumePasswordRecovery(
                database,
                authority,
                webCommand('reset-password', {
                  email: ownerEmail,
                  token: secret,
                  password: newPassword,
                  confirmPassword: newPassword,
                }),
              );
          },
          'reset',
        ],
        [
          'verify link',
          async () => {
            const token = randomUUID();
            await db
              .insert(verificationTokens)
              .values({ identifier: ownerEmail, token, expires: new Date(Date.now() + 3600_000) });
            return (database: DbInstance) =>
              consumeEmailVerification(
                database,
                { ...authority, emailVerificationEnabled: true },
                webCommand('verify-email', { token, email: ownerEmail }),
              );
          },
          'verified',
        ],
      ] as const)(
        'a pre-switch %s binds through the climber row before the reservation, then completes',
        async (_name, prepare, expected) => {
          const outcome = await bounded(expectReservationFreeWhileWaiting(await prepare()));
          // Bound to the account, not left unbound: the locked path really ran.
          expect(outcome).toMatchObject({ status: 'fulfilled', value: { outcome: expected } });
        },
        20_000,
      );
    });
  });

  describe('a password checked before a reset cannot issue after it', () => {
    it('refuses the native and web sign-ins whose bcrypt passed while a reset was in flight', async () => {
      const token = await issueRecoveryToken(ownerEmail);
      const before = await issued('/credentials', { email: ownerEmail, password });
      const resetKey = randomInt(1, 2_147_483_647);
      await installPark('public.auth_security_mutation_events', 'AFTER INSERT', `NEW.user_id='${ownerId}'`, resetKey);
      const park = await holdKey(resetKey);
      let reset: Promise<unknown> | undefined;
      let nativeLogin: Promise<Response> | undefined;
      let webLogin: Promise<unknown> | undefined;
      try {
        // Parked with the new hash written and the generation raised, uncommitted.
        reset = track(resetPassword(db, token));
        const resetPid = await waiterOn(resetKey);
        // Both read the committed old hash, so bcrypt passes; both then queue on the user.
        nativeLogin = track(native('/credentials', { email: ownerEmail, password }));
        webLogin = track(signIn(drizzle(bystander) as unknown as DbInstance, ownerEmail, password));
        await waitBlockedBy(resetPid, Promise.race([nativeLogin, webLogin]), 2);
      } finally {
        park.release();
        await park.held;
      }
      expect(await bounded(reset!)).toMatchObject({ outcome: 'reset' });
      const response = await bounded(nativeLogin!);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(INVALID_CREDENTIALS);
      expect(await bounded(webLogin!)).toMatchObject({ outcome: 'invalid_credentials' });
      // Nothing was minted after the reset, and what was minted before it is ended.
      expect(await liveRefreshRows(ownerId)).toEqual([]);
      expect(await validateMobileJwt(before.jwt)).toBeNull();

      const after = await issued('/credentials', { email: ownerEmail, password: newPassword });
      expect(decodeJwt(after.jwt)).toMatchObject({ sub: ownerId, gen: 1, ngen: 0 });
      expect((await validateMobileJwt(after.jwt))?.userId).toBe(ownerId);
    }, 20_000);

    it.each([
      // A generation writer that changes no password (an admin revocation, BA-04 PR 9).
      ['an account-wide revocation that kept the hash', 'generation'],
      // A password writer that has not raised the generation yet.
      ['a password write that kept the generation', 'hash'],
    ] as const)(
      'refuses a native sign-in whose bcrypt passed before %s',
      async (_writer, moved) => {
        const writer = await hold(blocker, async (transaction) => {
          await transaction.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update');
          if (moved === 'hash')
            await transaction
              .update(userCredentials)
              .set({ passwordHash: await hash(newPassword, 4) })
              .where(eq(userCredentials.userId, ownerId));
          else
            await transaction.insert(authSubjectCutoffs).values({
              userId: ownerId,
              generation: 1,
              nativeGeneration: 0,
              revokedThrough: new Date(),
              lastOperationId: randomUUID(),
            });
        });
        let login: Promise<Response> | undefined;
        try {
          login = track(native('/credentials', { email: ownerEmail, password }));
          await waitBlockedBy(writer.pid, login);
        } finally {
          writer.release();
          await writer.held;
        }
        const response = await bounded(login!);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual(INVALID_CREDENTIALS);
        expect(await liveRefreshRows(ownerId)).toEqual([]);
        // The next attempt checks what is current before bcrypt and is stamped with it.
        const next = await issued('/credentials', {
          email: ownerEmail,
          password: moved === 'hash' ? newPassword : password,
        });
        expect(decodeJwt(next.jwt)).toMatchObject({ gen: moved === 'hash' ? 0 : 1 });
      },
      20_000,
    );

    it('never makes a sign-in wait for a sync page holding the climber, and a reset waits it out', async () => {
      const token = await issueRecoveryToken(ownerEmail);
      // A logbook sync page: a foreign-key insert naming the climber, held open.
      const page = await hold(blocker, (transaction) =>
        transaction.insert(mobileRefreshTokens).values({
          userId: ownerId,
          tokenHash: tokenHash(randomUUID()),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      let reset: Promise<unknown> | undefined;
      let pageEndedAt = 0;
      try {
        const startedAt = performance.now();
        expect(await bounded(signIn(db, ownerEmail, password), 3000)).toMatchObject({ outcome: 'authenticated' });
        expect((await bounded(native('/credentials', { email: ownerEmail, password }), 3000)).status).toBe(200);
        expect(performance.now() - startedAt).toBeLessThan(1500);
        // A reset needs the climber FOR UPDATE, so it queues behind the page.
        reset = track(resetPassword(drizzle(bystander) as unknown as DbInstance, token));
        await waitBlockedBy(page.pid, reset);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } finally {
        pageEndedAt = performance.now();
        page.release();
        await page.held;
      }
      // Waited out within its 4 s limit, where a 250 ms limit gave up.
      expect(await bounded(reset!)).toMatchObject({ outcome: 'reset' });
      expect(performance.now() - pageEndedAt).toBeLessThan(2000);
    }, 20_000);

    it('still signs in on a second attempt right after the reset, on the old password never', async () => {
      const token = await issueRecoveryToken(ownerEmail);
      expect(await resetPassword(db, token)).toMatchObject({ outcome: 'reset' });
      expect((await native('/credentials', { email: ownerEmail, password })).status).toBe(401);
      expect((await signIn(db, ownerEmail, password)).outcome).toBe('invalid_credentials');
      expect((await signIn(db, ownerEmail, newPassword)).outcome).toBe('authenticated');
    });
  });

  describe('refresh racing a reset leaves no live child', () => {
    it('answers 401 and mints nothing when the reset holds the climber first', async () => {
      const parent = await issued('/credentials', { email: ownerEmail, password });
      const token = await issueRecoveryToken(ownerEmail);
      const resetKey = randomInt(1, 2_147_483_647);
      await installPark('public.auth_security_mutation_events', 'AFTER INSERT', `NEW.user_id='${ownerId}'`, resetKey);
      const park = await holdKey(resetKey);
      let reset: Promise<unknown> | undefined;
      let refresh: Promise<Response> | undefined;
      try {
        reset = track(resetPassword(db, token));
        const resetPid = await waiterOn(resetKey);
        refresh = track(native('/refresh', { refreshToken: parent.refreshToken }));
        await waitBlockedBy(resetPid, refresh);
      } finally {
        park.release();
        await park.held;
      }
      expect(await bounded(reset!)).toMatchObject({ outcome: 'reset' });
      expect((await bounded(refresh!)).status).toBe(401);
      expect(await liveRefreshRows(ownerId)).toEqual([]);
      expect(await db.$count(mobileRefreshTokens, eq(mobileRefreshTokens.userId, ownerId))).toBe(1);
    }, 20_000);

    it('revokes the child when the refresh holds the climber first, and every reader refuses it', async () => {
      const parent = await issued('/credentials', { email: ownerEmail, password });
      const token = await issueRecoveryToken(ownerEmail);
      const refreshKey = randomInt(1, 2_147_483_647);
      await installPark('public.mobile_refresh_tokens', 'AFTER INSERT', `NEW.user_id='${ownerId}'`, refreshKey);
      const park = await holdKey(refreshKey);
      let refresh: Promise<Response> | undefined;
      let reset: Promise<unknown> | undefined;
      try {
        // Parked after inserting its child, holding the climber FOR KEY SHARE.
        refresh = track(native('/refresh', { refreshToken: parent.refreshToken }));
        const refreshPid = await waiterOn(refreshKey);
        reset = track(resetPassword(drizzle(bystander) as unknown as DbInstance, token));
        await waitBlockedBy(refreshPid, reset);
      } finally {
        park.release();
        await park.held;
      }
      const response = await bounded(refresh!);
      expect(response.status).toBe(200);
      const child = (await response.json()) as TokenPair;
      expect(await bounded(reset!)).toMatchObject({ outcome: 'reset' });
      const [childRow] = await db
        .select()
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.tokenHash, tokenHash(child.refreshToken)));
      expect(childRow.revokedAt).not.toBeNull();
      expect(childRow.subjectGeneration).toBe(0);
      expect(await liveRefreshRows(ownerId)).toEqual([]);
      expect(await validateMobileJwt(child.jwt)).toBeNull();
      expect((await native('/refresh', { refreshToken: child.refreshToken })).status).toBe(401);
    }, 20_000);

    it('makes every generation writer wait for a refresh in flight, so its child is ended, never missed', async () => {
      const parent = await issued('/credentials', { email: ownerEmail, password });
      const refreshKey = randomInt(1, 2_147_483_647);
      await installPark('public.mobile_refresh_tokens', 'AFTER INSERT', `NEW.user_id='${ownerId}'`, refreshKey);
      const park = await holdKey(refreshKey);
      let refresh: Promise<Response> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        refresh = track(native('/refresh', { refreshToken: parent.refreshToken }));
        const refreshPid = await waiterOn(refreshKey);
        // recordSecurityMutation itself takes users FOR UPDATE before the cutoff row.
        mutation = track(
          drizzle(bystander).transaction((transaction) =>
            recordSecurityMutation(transaction as unknown as CurrentStoreTransaction, {
              ...authority,
              operationId: randomUUID(),
              userId: ownerId,
              expectedGeneration: 0,
              kind: 'password-change',
              domains: ['first-party', 'partner'],
            }),
          ),
        );
        await waitBlockedBy(refreshPid, mutation);
      } finally {
        park.release();
        await park.held;
      }
      const child = (await (await bounded(refresh!)).json()) as TokenPair;
      await bounded(mutation!);
      expect(decodeJwt(child.jwt)).toMatchObject({ gen: 0 });
      expect(await validateMobileJwt(child.jwt)).toBeNull();
      expect((await native('/refresh', { refreshToken: child.refreshToken })).status).toBe(401);
    }, 20_000);

    it('decides the parent on the generation read after the user lock, not before it', async () => {
      const parent = await issued('/credentials', { email: ownerEmail, password });
      // A generation writer that revokes no refresh row: only the decision can stop the child.
      const writer = await hold(blocker, async (transaction) => {
        await transaction.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update');
        await transaction.insert(authSubjectCutoffs).values({
          userId: ownerId,
          generation: 1,
          nativeGeneration: 0,
          revokedThrough: new Date(),
          lastOperationId: randomUUID(),
        });
      });
      let refresh: Promise<Response> | undefined;
      try {
        refresh = track(native('/refresh', { refreshToken: parent.refreshToken }));
        await waitBlockedBy(writer.pid, refresh);
      } finally {
        writer.release();
        await writer.held;
      }
      expect((await bounded(refresh!)).status).toBe(401);
      // Refused before any write: the parent stays as it was and has no child.
      expect(await liveRefreshRows(ownerId)).toHaveLength(1);
      expect(await db.$count(mobileRefreshTokens, eq(mobileRefreshTokens.userId, ownerId))).toBe(1);
    }, 20_000);
  });

  describe('heavy account deletion', () => {
    it('deletes a 40,000-tick account well under the 45 s production statement limit, with short limits only on its bookkeeping', async () => {
      const ticks = 40_000;
      // The hand-written test schema leaves out production's tick foreign key,
      // so the cascade would skip every tick. Add it as production has it, for
      // new rows only (NOT VALID), so other files' leftover ticks never matter.
      await db.execute(
        sql.raw(`ALTER TABLE boardsesh_ticks ADD CONSTRAINT ${fixtureName}_tick_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE NOT VALID`),
      );
      await db.execute(sql`
          INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
          SELECT gen_random_uuid()::text, ${ownerId}, 'kilter', 'heavy-climb-' || (series % 500), 40,
                 'send', now() - (series || ' minutes')::interval
          FROM generate_series(1, ${ticks}) AS series`);
      expect(await db.$count(boardseshTicks, eq(boardseshTicks.userId, ownerId))).toBe(ticks);
      // What each phase ran under, written from inside the real statements.
      await db.execute(
        sql.raw(`CREATE TABLE ${fixtureName}_limits (phase text, statement_timeout text, lock_timeout text)`),
      );
      try {
        const recordLimits = async (phase: string, table: string, timing: string, condition: string) => {
          const name = `${fixtureName}_limits_${phase}`;
          await db.execute(
            sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $record$
                BEGIN
                  IF ${condition} THEN
                    INSERT INTO ${fixtureName}_limits
                    VALUES ('${phase}', current_setting('statement_timeout'), current_setting('lock_timeout'));
                  END IF;
                  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
                END; $record$`),
          );
          await db.execute(
            sql.raw(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`),
          );
          installedTriggers.push({ table, name });
        };
        await recordLimits('cascade', 'public.users', 'BEFORE DELETE', `OLD.id = '${ownerId}'`);
        await recordLimits(
          'bookkeeping',
          'public.auth_security_mutation_events',
          'AFTER INSERT',
          `NEW.user_id = '${ownerId}'`,
        );

        const startedAt = performance.now();
        expect(await bounded(deleteAccount(ownerId), 45_000)).toBe(true);
        const elapsed = performance.now() - startedAt;
        console.info(`[per-user-locks] staged deletion of ${ticks} ticks: ${elapsed.toFixed(0)} ms`);
        expect(elapsed).toBeLessThan(45_000);
        expect(await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId))).toEqual([]);
        expect(await db.$count(boardseshTicks, eq(boardseshTicks.userId, ownerId))).toBe(0);
        expect(await db.$count(logbookChanges, eq(logbookChanges.userId, ownerId))).toBe(0);
        const limits = await executeFirstRow<{ rows: unknown }>(
          db,
          sql.raw(
            `SELECT json_agg(json_build_object('phase', phase, 'statement', statement_timeout, 'lock', lock_timeout) ORDER BY phase) AS rows FROM ${fixtureName}_limits`,
          ),
        );
        const session = await executeFirstRow<{ statementTimeout: string; lockTimeout: string }>(
          db,
          sql`SELECT current_setting('statement_timeout') AS "statementTimeout", current_setting('lock_timeout') AS "lockTimeout"`,
        );
        // The cascade keeps the connection's own limits; only the bookkeeping is short.
        expect(limits?.rows).toEqual([
          { phase: 'bookkeeping', statement: '5s', lock: '4s' },
          { phase: 'cascade', statement: session?.statementTimeout, lock: session?.lockTimeout },
        ]);
      } finally {
        await dropParks();
        await db.execute(sql.raw(`DROP TABLE IF EXISTS ${fixtureName}_limits`));
        await db.execute(sql.raw(`ALTER TABLE boardsesh_ticks DROP CONSTRAINT IF EXISTS ${fixtureName}_tick_user`));
      }
    }, 90_000);
  });

  describe('no deadlock against the partner lock order (users FOR SHARE, connection, provider rows)', () => {
    let partnerRows: PartnerRows;
    const partnerDatabase = () => drizzle(partnerConnection, { schema: partnerAdapterSchema });

    beforeEach(async () => {
      const developerId = await createUser('lock-developer');
      createdUserIds.add(developerId);
      partnerRows = await attachPartnerState(ownerId, await createApp(developerId));
    });

    /** A partner flow parked after its first two locks, in its own order, then finishing. */
    function partnerFlow(kind: 'disconnect' | 'consent' | 'refresh') {
      const arrived = barrier(),
        release = barrier();
      let pid = 0;
      const done = track(
        partnerDatabase().transaction(async (transaction) => {
          const partner = transaction as unknown as PartnerDatabase;
          const [row] = await transaction.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          pid = Number(row.pid);
          await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
          if (kind === 'disconnect') {
            const connection = await lockPartnerConnection(partner, ownerId, partnerRows.clientId);
            arrived.release();
            await release.promise;
            if (connection && !connection.revokedAt)
              await endPartnerConnection(partner, connection, 'climber_disconnect');
            return;
          }
          if (kind === 'consent') {
            // A consent answer: the climber, its link, then the connection.
            expect(await lockClimber(partner, ownerId)).toBe(true);
            await transaction
              .select()
              .from(oauthConsentInteractions)
              .where(eq(oauthConsentInteractions.digest, partnerRows.interactionDigest))
              .for('update');
            arrived.release();
            await release.promise;
            await selectConnectionForUpdate(partner, ownerId, partnerRows.clientId);
            return;
          }
          // A partner refresh: the climber, the connection, then a new token row.
          await lockCurrentGrant(partner, {
            clientId: partnerRows.clientId,
            userId: ownerId,
            authorizationCodeId: partnerRows.authorizationCodeId,
          });
          arrived.release();
          await release.promise;
          await transaction.execute(
            sql`UPDATE oauth_connections SET updated_at = now() WHERE id = ${partnerRows.connectionId}`,
          );
        }),
      );
      return { done, arrived: arrived.promise, release: release.release, pid: () => pid };
    }

    const firstPartyOperations: Record<FirstPartyOperation, () => Promise<() => Promise<unknown>>> = {
      'staged reset': async () => {
        const token = await issueRecoveryToken(ownerEmail);
        return () => resetPassword(db, token);
      },
      'staged deletion': async () => () => deleteAccount(ownerId),
      'web sign-in': async () => () => signIn(db, ownerEmail, password),
      'native refresh': async () => {
        const pair = await issued('/credentials', { email: ownerEmail, password });
        return () => native('/refresh', { refreshToken: pair.refreshToken });
      },
    };

    describe.each(['disconnect', 'consent', 'refresh'] as const)('partner %s in flight first', (kind) => {
      it.each(FIRST_PARTY_OPERATIONS)(
        '%s waits or passes, and both finish without 40P01',
        async (operationName) => {
          const run = await firstPartyOperations[operationName]();
          const partner = partnerFlow(kind);
          await bounded(partner.arrived);
          const operation = track(settled(run()));
          // FOR UPDATE writers wait for the partner's FOR SHARE; KEY SHARE readers pass it.
          if (operationName === 'staged reset' || operationName === 'staged deletion')
            await waitBlockedBy(partner.pid(), operation);
          partner.release();
          await bounded(partner.done);
          const outcome = await bounded(operation, 15_000);
          if (outcome.status === 'rejected') {
            expect(getPostgresErrorCode(outcome.reason)).not.toBe('40P01');
            throw outcome.reason;
          }
          if (operationName === 'native refresh') expect((outcome.value as Response).status).toBe(200);
        },
        25_000,
      );
    });

    it.each(FIRST_PARTY_OPERATIONS.filter((name) => name !== 'web sign-in'))(
      '%s in flight first lets disconnect, consent and partner refresh queue and finish without 40P01',
      async (operationName) => {
        const run = await firstPartyOperations[operationName]();
        const parkKey = randomInt(1, 2_147_483_647);
        if (operationName === 'native refresh')
          await installPark('public.mobile_refresh_tokens', 'AFTER INSERT', `NEW.user_id='${ownerId}'`, parkKey);
        else if (operationName === 'staged deletion')
          await installPark('public.users', 'BEFORE DELETE', `OLD.id='${ownerId}'`, parkKey);
        else
          await installPark(
            'public.auth_security_mutation_events',
            'AFTER INSERT',
            `NEW.user_id='${ownerId}'`,
            parkKey,
          );
        const park = await holdKey(parkKey);
        let operation: ReturnType<typeof settled<unknown>> | undefined;
        const partners: ReturnType<typeof partnerFlow>[] = [];
        try {
          operation = track(settled(run()));
          const operationPid = await waiterOn(parkKey);
          if (operationName === 'native refresh') {
            // A refresh holds the climber FOR KEY SHARE, which a partner's FOR SHARE
            // passes: each partner flow runs to the end while the refresh is parked.
            // One at a time, since a partner refresh queues on a Disconnect's connection.
            for (const kind of ['disconnect', 'consent', 'refresh'] as const) {
              const partner = partnerFlow(kind);
              partners.push(partner);
              await bounded(partner.arrived);
              partner.release();
              await bounded(partner.done);
            }
          } else {
            // The deletion and the reset hold the climber FOR UPDATE, so each partner
            // flow queues on its first lock, holding nothing yet.
            for (const kind of ['disconnect', 'consent', 'refresh'] as const) partners.push(partnerFlow(kind));
            await waitBlockedBy(operationPid, operation, 3);
          }
        } finally {
          park.release();
          await park.held;
        }
        for (const partner of partners) partner.release();
        const outcome = await bounded(operation!, 15_000);
        if (outcome.status === 'rejected') throw outcome.reason;
        const partnerOutcomes = await bounded(Promise.all(partners.map((partner) => settled(partner.done))), 15_000);
        for (const partnerOutcome of partnerOutcomes) {
          if (partnerOutcome.status === 'rejected') {
            // A deletion removes the climber, so a partner flow may find nothing: never a deadlock.
            expect(getPostgresErrorCode(partnerOutcome.reason)).not.toBe('40P01');
          }
        }
        if (operationName === 'staged reset') {
          const [connection] = await db
            .select()
            .from(oauthConnections)
            .where(eq(oauthConnections.id, partnerRows.connectionId));
          expect(connection.revokedAt).not.toBeNull();
        }
      },
      30_000,
    );
  });
});
