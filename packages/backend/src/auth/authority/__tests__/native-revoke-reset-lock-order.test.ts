import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type ResetPasswordCommand } from '@boardsesh/auth-protocol';
import * as schema from '@boardsesh/db/schema';
import {
  authEmailProjection,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { revokeNativeCredentials } from '../native-revocation';
import type { NativeRevocationMode } from '../native-revocation-configuration';
import { decideCredential } from '../../credential-cutoffs';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { consumePasswordRecovery, requestPasswordRecovery } from '../../current-store/password-recovery';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { barrier, blockedStatement, bounded, connectAs, parkBeforeCommit } from './lock-order-harness';

/**
 * The BA-04 activation gate NATIVE_REVOKE_RESET_LOCK_ORDER: native sign-out
 * (revokeNativeCredentials) and a staged password reset (consumePasswordRecovery)
 * on the same climber, each on its own PostgreSQL connection. Both take the shared
 * authority gate and then the climber's users row FOR UPDATE before any other row of
 * that climber, so whichever starts second queues on the users row and nothing can
 * close a cycle. Each order parks the first command before COMMIT, holding every
 * lock it takes, and proves the second waits on exactly that users row.
 */
const RESET_APPLICATION = 'ba04-lock-order-reset';
const REVOKE_APPLICATION = 'ba04-lock-order-revoke';
const NEXT_PASSWORD = 'lock order replacement password';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let resetClient: ReturnType<typeof postgres>;
let revokeClient: ReturnType<typeof postgres>;
let observer: ReturnType<typeof postgres>;
let resetDatabase: typeof environment.database;
let revokeDatabase: typeof environment.database;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
  emailVerificationEnabled: false,
};

const isResetReply = (result: unknown) =>
  typeof result === 'object' && result !== null && 'operation' in result && result.operation === 'reset-password';

async function fixture() {
  const userId = randomUUID();
  const email = `lock-order-${userId}@example.com`;
  const presentedTokenHash = randomUUID();
  await environment.database.insert(users).values({ id: userId, email });
  await environment.database.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
    await transaction
      .insert(userCredentials)
      .values({ userId, passwordHash: await bcrypt.hash('lock order original password', 4) });
    // The phone signing out, and a second device that must not survive the reset.
    await transaction.insert(mobileRefreshTokens).values(
      [presentedTokenHash, randomUUID()].map((tokenHash) => ({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 3600000),
        subjectGeneration: 0,
        nativeGeneration: 0,
      })),
    );
  });
  const reply = await requestPasswordRecovery(environment.database, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'forgot-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  });
  if (reply.outcome !== 'accepted' || !reply.mailPlan) throw new Error('Missing owned recovery fixture');
  return { userId, presentedTokenHash, recoveryToken: reply.mailPlan.token };
}

function resetCommand(token: string): ResetPasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'reset-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token, password: NEXT_PASSWORD, confirmPassword: NEXT_PASSWORD },
  };
}

async function expectResetEndState(userId: string, nativeSignouts: number) {
  const [credential] = await environment.database
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
  expect(await bcrypt.compare(NEXT_PASSWORD, credential.passwordHash)).toBe(true);
  const refreshRows = await environment.database
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.userId, userId));
  expect(refreshRows).toHaveLength(2);
  expect(refreshRows.every((row) => row.revokedAt !== null)).toBe(true);
  const [cutoff] = await environment.database
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId));
  expect(cutoff.generation).toBe(1);
  expect(cutoff.nativeGeneration).toBe(nativeSignouts);
  const state = {
    generation: cutoff.generation,
    nativeGeneration: cutoff.nativeGeneration,
    deniedSessionKeys: new Set<string>(),
  };
  // Every credential issued before the reset is refused, on the web and in the app.
  expect(
    decideCredential(
      { kind: 'web-session', generationClaim: 0, sessionKeyClaim: randomUUID(), authTimeClaim: undefined },
      state,
      Date.now(),
    ).denial,
  ).toBe('generation');
  expect(
    decideCredential(
      { kind: 'native-refresh', subjectGeneration: 0, nativeGeneration: 0, authenticatedAt: null },
      state,
      Date.now(),
    ).denial,
  ).toBe('generation');
  const events = await environment.database
    .select({ kind: authSecurityMutationEvents.kind })
    .from(authSecurityMutationEvents)
    .where(eq(authSecurityMutationEvents.userId, userId));
  expect(events.filter((event) => event.kind === 'password-reset')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'native-signout')).toHaveLength(nativeSignouts);
}

describe('native revoke and password reset share one lock order', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    const connect = (applicationName: string) => connectAs(environment.client.options.database, applicationName);
    resetClient = connect(RESET_APPLICATION);
    revokeClient = connect(REVOKE_APPLICATION);
    observer = connect('ba04-lock-order-observer');
    resetDatabase = drizzle(resetClient, { schema });
    revokeDatabase = drizzle(revokeClient, { schema });
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-lock-order-retired-mailbox-key-6975');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await Promise.allSettled([resetClient, revokeClient, observer].map((client) => client?.end({ timeout: 5 })));
    await environment?.close();
  });

  for (const mode of ['legacy', 'generation'] as const satisfies readonly NativeRevocationMode[]) {
    it(`reset first: a ${mode} sign-out waits on the users row, then both finish`, async () => {
      const subject = await fixture();
      const parked = parkBeforeCommit(resetDatabase, isResetReply);
      const reset = consumePasswordRecovery(resetDatabase, authority, resetCommand(subject.recoveryToken));
      let revoke: Promise<boolean> | undefined;
      try {
        // The reset holds the gate, users row, cutoff, credential and every refresh row.
        await bounded(parked.reached);
        revoke = revokeNativeCredentials(revokeDatabase, subject.presentedTokenHash, mode);
        const waiting = await blockedStatement(observer, REVOKE_APPLICATION, revoke);
        expect(waiting.query).toMatch(/from "users" where "users"\."id" = \$1 for update/i);
        expect(waiting.blockers).toEqual([RESET_APPLICATION]);
      } finally {
        parked.release();
      }
      const [resetReply, revoked] = await bounded(Promise.all([reset, revoke]));
      expect(resetReply.outcome).toBe('reset');
      // The reset already revoked the presented refresh token, so the sign-out finds nothing live.
      expect(revoked).toBe(false);
      await expectResetEndState(subject.userId, 0);
    });

    it(`revoke first: the reset waits on the users row behind a ${mode} sign-out, then both finish`, async () => {
      const subject = await fixture();
      const parked = parkBeforeCommit(revokeDatabase, () => true);
      const revoke = revokeNativeCredentials(revokeDatabase, subject.presentedTokenHash, mode);
      let reset: ReturnType<typeof consumePasswordRecovery> | undefined;
      try {
        // The sign-out holds the gate, users row and every refresh row (plus the cutoff in generation mode).
        await bounded(parked.reached);
        reset = consumePasswordRecovery(resetDatabase, authority, resetCommand(subject.recoveryToken));
        const waiting = await blockedStatement(observer, RESET_APPLICATION, reset);
        expect(waiting.query).toMatch(/from "users" where "users"\."id" = \$1 for update/i);
        expect(waiting.blockers).toEqual([REVOKE_APPLICATION]);
      } finally {
        parked.release();
      }
      const [resetReply, revoked] = await bounded(Promise.all([reset, revoke]));
      expect(revoked).toBe(true);
      expect(resetReply.outcome).toBe('reset');
      await expectResetEndState(subject.userId, mode === 'generation' ? 1 : 0);
    });
  }

  it('control: a sign-out that locked a refresh row before the users row would deadlock with the reset', async () => {
    const subject = await fixture();
    const refreshLocked = barrier();
    const lockUser = barrier();
    // The order revokeNativeCredentials must never use: refresh row first, users row second.
    const reversed = revokeDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      await transaction
        .select({ tokenHash: mobileRefreshTokens.tokenHash })
        .from(mobileRefreshTokens)
        .where(
          and(
            eq(mobileRefreshTokens.userId, subject.userId),
            eq(mobileRefreshTokens.tokenHash, subject.presentedTokenHash),
          ),
        )
        .for('update');
      refreshLocked.resolve();
      await lockUser.promise;
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, subject.userId)).for('update');
    });
    let reset: ReturnType<typeof consumePasswordRecovery> | undefined;
    try {
      await bounded(refreshLocked.promise);
      reset = consumePasswordRecovery(resetDatabase, authority, resetCommand(subject.recoveryToken));
      // The reset now holds the users row and waits for the refresh row.
      const waiting = await blockedStatement(observer, RESET_APPLICATION, reset);
      expect(waiting.query).toMatch(/update "mobile_refresh_tokens"/i);
      expect(waiting.blockers).toEqual([REVOKE_APPLICATION]);
    } finally {
      lockUser.resolve();
    }
    const outcomes = await bounded(Promise.allSettled([reset, reversed]));
    const deadlocks = outcomes.filter(
      (outcome) => outcome.status === 'rejected' && getPostgresErrorCode(outcome.reason) === '40P01',
    );
    expect(deadlocks).toHaveLength(1);
  });
});
