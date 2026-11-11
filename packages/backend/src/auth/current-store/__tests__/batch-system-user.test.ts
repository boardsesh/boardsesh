import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  sessions,
  users,
  userCredentials,
  userProfiles,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { claimBackgroundJobRun } from '@boardsesh/db/queries';
import { BATCH_SYSTEM_USER_COMMAND_PATH } from '@boardsesh/auth-protocol';
import { createBatchSystemUserClient } from '../batch-system-user-client';
import { consumeEmailVerification } from '../email-verification';
import { lockAuthorityGateExclusively } from '../foundation-context';
import { logger } from '../../../utils/logger';
import { BatchSystemUserProof } from './fixtures/batch-system-user-proof';

let proof: BatchSystemUserProof;
async function state() {
  return {
    users: await proof.db.select().from(users).orderBy(users.id),
    reservations: await proof.db.select().from(authEmailReservations).orderBy(authEmailReservations.normalizedEmail),
    members: await proof.db
      .select()
      .from(authEmailReservationMembers)
      .orderBy(authEmailReservationMembers.normalizedEmail, authEmailReservationMembers.userId),
    nonces: await proof.db.select().from(verificationTokens).orderBy(verificationTokens.identifier),
    credentials: await proof.db.select().from(userCredentials),
    accounts: await proof.db.select().from(accounts),
    sessions: await proof.db.select().from(sessions),
    refresh: await proof.db.select().from(mobileRefreshTokens),
    profiles: await proof.db.select().from(userProfiles),
    cutoffs: await proof.db.select().from(authSubjectCutoffs),
    events: await proof.db.select().from(authSecurityMutationEvents),
  };
}
async function request(family = 'refresh-recommendations', payload: Record<string, unknown> = {}) {
  const { job, token } = await proof.active(family, payload);
  if (!token) throw new Error('Owned fixture expected a real claimed attempt');
  return { job, token, command: proof.command(job.id, token) };
}
function deferred() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

async function bounded<Result>(pending: Promise<Result>, milliseconds = 5_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned batch barrier deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function observeBarrier(signal: Promise<void>, work: Promise<unknown>) {
  await bounded(
    Promise.race([
      signal,
      work.then(() => {
        throw new Error('Owned blocker ended before its barrier');
      }),
    ]),
  );
}

describe('actual private batch identity command and PostgreSQL attempt fencing', () => {
  beforeAll(async () => {
    proof = new BatchSystemUserProof();
    await proof.start();
  });
  beforeEach(async () => {
    await proof.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await proof?.close();
  });

  it.each([
    ['refresh-recommendations', 'system-recommendations', 'recommendations@boardsesh.com', 'Boardsesh'],
    ['refresh-hold-features', 'system-hold-classifier', 'hold-classifier@boardsesh.com', 'Boardsesh Hold Classifier'],
  ])('derives the fixed %s identity under a real restricted backend role', async (family, userId, email, name) => {
    await proof.prepare();
    const { command } = await request(family);
    const { response, body } = await proof.post(command);
    expect(response.status).toBe(200);
    expect(body).toEqual({ protocolVersion: 1, operation: 'ensure', requestId: command.requestId, outcome: 'ensured' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const created = await state();
    expect(created.users).toHaveLength(1);
    expect(created.users[0]).toMatchObject({ id: userId, email, name, emailVerified: null, image: null });
    expect(created.reservations).toHaveLength(1);
    expect(created.reservations[0]).toMatchObject({ normalizedEmail: email, ownerUserId: userId, state: 'owned' });
    expect(created.members).toHaveLength(1);
    expect(created.members[0]).toMatchObject({ normalizedEmail: email, userId });
    expect(created.nonces).toHaveLength(1);
    expect(created.nonces[0].identifier).toMatch(/^ba03-batch-system-user:v1:[a-f0-9]{64}$/);
    for (const field of ['credentials', 'accounts', 'sessions', 'refresh', 'profiles', 'cutoffs', 'events'] as const)
      expect(created[field]).toEqual([]);
  });
  it('preserves existing user/profile/cutoff fields while consuming only a new command', async () => {
    await proof.db.insert(users).values({
      id: 'system-recommendations',
      email: ' Recommendations@Boardsesh.com ',
      name: 'Existing owner',
      emailVerified: new Date('2020-01-01T00:00:00Z'),
      image: 'https://example.invalid/image.png',
      createdAt: new Date('2019-01-01T00:00:00Z'),
      updatedAt: new Date('2021-01-01T00:00:00Z'),
    });
    await proof.db.insert(userProfiles).values({ userId: 'system-recommendations', displayName: 'Existing display' });
    await proof.db.insert(authSubjectCutoffs).values({
      userId: 'system-recommendations',
      generation: 2,
      revokedThrough: new Date('2022-01-01T00:00:00Z'),
      lastOperationId: 'existing-cutoff',
    });
    await proof.prepare();
    const before = await state();
    const { command } = await request();
    expect((await proof.post(command)).response.status).toBe(200);
    const after = await state();
    expect({ ...after, nonces: [] }).toEqual({ ...before, nonces: [] });
    expect(after.nonces).toHaveLength(1);
  });
  it.each([
    'bad-secret',
    'human-secret',
    'browser-origin',
    'cookie-only',
    'legacy-mode',
    'bad-mode',
    'query-path',
    'wrong-method',
    'content-type',
  ])('rejects %s before any identity or nonce write', async (fault) => {
    await proof.prepare();
    const { command } = await request();
    const before = await state();
    if (fault === 'legacy-mode') proof.environment.CURRENT_STORE_BATCH_SYSTEM_USERS_MODE = 'legacy';
    if (fault === 'bad-mode') proof.environment.CURRENT_STORE_BATCH_SYSTEM_USERS_MODE = 'unknown';
    const result = await proof.post(command, {
      ...(fault === 'bad-secret' ? { secret: 'incorrect-owned-fixture-secret' } : {}),
      ...(fault === 'human-secret' ? { secret: proof.environment.CURRENT_STORE_AUTH_RPC_SECRET } : {}),
      ...(fault === 'cookie-only'
        ? { secret: '', headers: { Cookie: 'next-auth.session-token=owned-not-authority' } }
        : {}),
      ...(fault === 'browser-origin' ? { headers: { Origin: proof.origin } } : {}),
      ...(fault === 'query-path' ? { path: `${BATCH_SYSTEM_USER_COMMAND_PATH}?redirect=elsewhere` } : {}),
      ...(fault === 'wrong-method' ? { method: 'PUT' } : {}),
      ...(fault === 'content-type' ? { headers: { 'Content-Type': 'text/plain' } } : {}),
    });
    expect(result.response.status).toBe(
      fault === 'legacy-mode' || fault === 'query-path'
        ? 404
        : fault === 'bad-mode'
          ? 503
          : fault === 'wrong-method' || fault === 'content-type'
            ? 400
            : 401,
    );
    expect(await state()).toEqual(before);
  });
  it.each(['userId', 'email', 'kind', 'role', 'family'])(
    'refuses caller-selected %s even with the machine secret',
    async (field) => {
      await proof.prepare();
      const { command } = await request();
      const before = await state();
      const result = await proof.post({ ...command, payload: { ...command.payload, [field]: 'human-owner' } });
      expect(result.response.status).toBe(400);
      expect(await state()).toEqual(before);
    },
  );
  it.each(['wrong-token', 'finished-run', 'expired-run', 'expired-heartbeat', 'superseded-attempt'])(
    'rejects a %s with its actual durable queue/ledger state',
    async (fault) => {
      await proof.prepare();
      const { command, job } = await request();
      if (fault === 'wrong-token') command.payload.attemptToken = randomUUID();
      if (fault === 'finished-run')
        await proof.db.update(backgroundJobRuns).set({ status: 'succeeded' }).where(eq(backgroundJobRuns.id, job.id));
      if (fault === 'expired-run')
        await proof.ownerPool`UPDATE background_job_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${job.id}`;
      if (fault === 'expired-heartbeat')
        await proof.ownerPool`UPDATE pgboss.job SET heartbeat_on = clock_timestamp() - interval '31 seconds' WHERE id = ${job.id}`;
      if (fault === 'superseded-attempt')
        await proof.db
          .update(backgroundJobRuns)
          .set({ attemptToken: randomUUID() })
          .where(eq(backgroundJobRuns.id, job.id));
      const before = await state();
      const { response, body } = await proof.post(command);
      expect(response.status).toBe(409);
      expect(body).toMatchObject({ outcome: 'rejected', code: 'attempt_lost' });
      expect(await state()).toEqual(before);
    },
  );
  it.each(['family', 'role', 'malformed-payload', 'dry-run', 'no-shadow'])(
    'does not grant machine creation for an ineligible %s',
    async (fault) => {
      await proof.prepare();
      const { command, job } = await request();
      if (fault === 'family')
        await proof.db
          .update(backgroundJobRuns)
          .set({ family: 'worker-probe' })
          .where(eq(backgroundJobRuns.id, job.id));
      if (fault === 'role')
        await proof.db
          .update(backgroundJobRuns)
          .set({ role: 'maintenance-delivery' })
          .where(eq(backgroundJobRuns.id, job.id));
      if (fault === 'malformed-payload')
        await proof.db
          .update(backgroundJobRuns)
          .set({ payload: { unexpected: true } })
          .where(eq(backgroundJobRuns.id, job.id));
      if (fault === 'dry-run' || fault === 'no-shadow')
        await proof.db
          .update(backgroundJobRuns)
          .set({ family: 'refresh-hold-features', payload: fault === 'dry-run' ? { dryRun: true } : { shadow: false } })
          .where(eq(backgroundJobRuns.id, job.id));
      const before = await state();
      const { response, body } = await proof.post(command);
      expect(response.status).toBe(503);
      expect(body).toMatchObject({ outcome: 'rejected', code: 'unavailable' });
      expect(await state()).toEqual(before);
    },
  );
  it.each([-30_100, 10_000])(
    'rejects stale/future issuance offset %s without consuming the command',
    async (offset) => {
      await proof.prepare();
      const { command } = await request();
      command.issuedAt += offset;
      const before = await state();
      expect((await proof.post(command)).response.status).toBe(400);
      expect(await state()).toEqual(before);
    },
  );
  it('consumes one nonce atomically and rejects an exact replay', async () => {
    await proof.prepare();
    const { command } = await request();
    expect((await proof.post(command)).response.status).toBe(200);
    const committed = await state();
    const repeated = await proof.post(command);
    expect(repeated.response.status).toBe(409);
    expect(repeated.body).toMatchObject({ code: 'replayed_request' });
    expect(await state()).toEqual(committed);
  });
  it('never classifies a real machine nonce as a legacy email-verification record', async () => {
    const authority = await proof.prepare();
    const { command } = await request();
    expect((await proof.post(command)).response.status).toBe(200);
    const [machineNonce] = await proof.db.select().from(verificationTokens);
    const reply = await consumeEmailVerification(
      proof.db,
      { ...authority, emailVerificationEnabled: true },
      {
        protocolVersion: 2,
        operation: 'verify-email',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { email: machineNonce.identifier, token: machineNonce.token },
      },
    );
    expect(reply.outcome).toBe('invalid_token');
    expect(
      await proof.db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, machineNonce.identifier)),
    ).toEqual([machineNonce]);
    expect((await proof.post(command)).body).toMatchObject({ outcome: 'rejected', code: 'replayed_request' });
  });
  it('concurrent distinct commands converge without rewriting the fixed identity', async () => {
    await proof.prepare();
    const { command } = await request();
    const responses = await Promise.all([proof.post(command), proof.post({ ...command, requestId: randomUUID() })]);
    expect(responses.map((entry) => entry.response.status)).toEqual([200, 200]);
    const committed = await state();
    expect(committed.users).toHaveLength(1);
    expect(committed.members).toHaveLength(1);
    expect(committed.reservations).toHaveLength(1);
    expect(committed.nonces).toHaveLength(2);
  });
  it('rolls back nonce and reservation on real late users INSERT permission denial', async () => {
    await proof.prepare();
    const { command } = await request();
    await proof.db.execute(sql`REVOKE INSERT ON TABLE ${users} FROM ${sql.identifier(proof.backendRole)}`);
    try {
      const [privileges] =
        await proof.backendPool`SELECT has_table_privilege(current_user, 'users', 'INSERT') AS can_insert`;
      expect(privileges.can_insert).toBe(false);
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const before = await state();
      const result = await proof.post(command);
      expect(result.response.status).toBe(503);
      expect(result.body).toMatchObject({ outcome: 'rejected', code: 'unavailable' });
      expect(await state()).toEqual(before);
      expect(warning.mock.calls).toEqual([
        ['[auth] Batch system-user authority unavailable', { category: 'authority-or-database' }],
      ]);
    } finally {
      await proof.db.execute(sql`GRANT INSERT ON TABLE ${users} TO ${sql.identifier(proof.backendRole)}`);
    }
  });
  it('installs its own SQL wait limits before the first ledger lock', async () => {
    await proof.prepare();
    const { command, job } = await request();
    const locked = deferred();
    const release = deferred();
    const blocker = proof.db.transaction(async (transaction) => {
      await transaction.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, job.id)).for('update');
      locked.release();
      await release.pending;
    });
    let pending: ReturnType<BatchSystemUserProof['post']> | undefined;
    let settledProofWork: PromiseSettledResult<unknown>[] = [];
    try {
      await observeBarrier(locked.pending, blocker);
      const before = await state();
      pending = proof.post(command);
      await proof.waitForBackendLock();
      // The backend pool deliberately has zero connection-level timeouts.
      // This 503 must arrive while the ledger blocker is still held.
      const result = await bounded(pending, 8_000);
      expect(result.response.status).toBe(503);
      expect(result.body).toMatchObject({ outcome: 'rejected', code: 'unavailable' });
      expect(await state()).toEqual(before);
    } finally {
      release.release();
      settledProofWork = await bounded(Promise.allSettled([blocker, ...(pending ? [pending] : [])]), 13_000);
    }
    for (const outcome of settledProofWork) if (outcome.status === 'rejected') throw outcome.reason;
  }, 20_000);
  it('rolls back every identity change when the run expires during an observed manifest wait', async () => {
    await proof.prepare();
    const { command, job } = await request();
    const locked = deferred();
    const release = deferred();
    const blocker = proof.db.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      locked.release();
      await release.pending;
    });
    let pending: ReturnType<BatchSystemUserProof['post']> | undefined;
    let settledProofWork: PromiseSettledResult<unknown>[] = [];
    try {
      await observeBarrier(locked.pending, blocker);
      await proof.ownerPool`UPDATE background_job_runs SET deadline_at = clock_timestamp() + interval '2 seconds' WHERE id = ${job.id}`;
      const before = await state();
      pending = proof.post(command);
      await proof.waitForBackendLock();
      const [observed] =
        await proof.ownerPool`SELECT clock_timestamp() < deadline_at AS live FROM background_job_runs WHERE id = ${job.id}`;
      expect(observed.live).toBe(true);
      const expiryObservationDeadline = performance.now() + 3_000;
      let observedExpired = false;
      while (performance.now() < expiryObservationDeadline) {
        const [clock] =
          await proof.ownerPool`SELECT clock_timestamp() >= deadline_at AS expired FROM background_job_runs WHERE id = ${job.id}`;
        if (clock.expired) {
          observedExpired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedExpired).toBe(true);
      release.release();
      await blocker;
      const result = await pending;
      expect(result.response.status).toBe(409);
      expect(result.body).toMatchObject({ code: 'attempt_lost' });
      expect(await state()).toEqual(before);
    } finally {
      release.release();
      settledProofWork = await bounded(Promise.allSettled([blocker, ...(pending ? [pending] : [])]), 13_000);
    }
    for (const outcome of settledProofWork) if (outcome.status === 'rejected') throw outcome.reason;
  }, 15_000);
  it('withholds acknowledgement after a real committed 200 reply-body loss; a later attempt revalidates', async () => {
    await proof.prepare();
    const { command, job } = await request();
    proof.dropReplies = true;
    let observedStatus: number | undefined;
    const observedFetch: typeof fetch = async (input, options) => {
      const response = await fetch(input, options);
      observedStatus = response.status;
      proof.releaseDroppedReplies();
      return response;
    };
    const client = createBatchSystemUserClient({
      environment: { ...proof.environment, CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN: proof.origin },
      fetch: observedFetch,
    });
    await expect(client.ensure(command)).rejects.toThrow();
    expect(observedStatus).toBe(200);
    expect(proof.requestCount).toBe(1);
    const committed = await state();
    expect(committed.users).toHaveLength(1);
    expect(committed.nonces).toHaveLength(1);
    proof.dropReplies = false;
    await proof.ownerPool`UPDATE pgboss.job SET retry_count = retry_count + 1 WHERE id = ${job.id}`;
    await proof.db.update(backgroundJobRuns).set({ status: 'retrying' }).where(eq(backgroundJobRuns.id, job.id));
    const nextToken = await claimBackgroundJobRun(proof.db, job.id, job.name, job.retryCount + 1);
    expect(nextToken).toBeTypeOf('string');
    if (!nextToken) throw new Error('Expected a real later claim');
    expect((await proof.post(proof.command(job.id, nextToken))).response.status).toBe(200);
    const revalidated = await state();
    expect(revalidated.users).toEqual(committed.users);
    expect(revalidated.members).toEqual(committed.members);
    expect(revalidated.reservations).toEqual(committed.reservations);
    expect(revalidated.nonces).toHaveLength(2);
  });
  it('retains and rejects unexpected credential history without creating a nonce', async () => {
    await proof.db.insert(users).values({ id: 'system-recommendations', email: 'recommendations@boardsesh.com' });
    await proof.db
      .insert(userCredentials)
      .values({ userId: 'system-recommendations', passwordHash: randomBytes(32).toString('hex') });
    await proof.prepare();
    const { command } = await request();
    const before = await state();
    expect((await proof.post(command)).response.status).toBe(503);
    expect(await state()).toEqual(before);
  });
});
