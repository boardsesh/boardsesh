import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from '@boardsesh/auth-protocol/transport';
import { authEmailReservations, authSubjectCutoffs, users, verificationTokens } from '@boardsesh/db/schema/auth';
import {
  backgroundJobRuns,
  boardSetterStats,
  playlistOwnership,
  playlists,
  userHoldClassifications,
} from '@boardsesh/db/schema';
import { executeBackgroundJob, handlerForRole, type BackgroundJobHandler } from '../../../workers/jobs';
import type { BackgroundJobContext } from '../../../workers/families';
import { clearBatchJobFixture, seedBatchJobFixture } from '../../../__tests__/helpers/batch-job-fixture';
import { BatchSystemUserProof } from './fixtures/batch-system-user-proof';

let proof: BatchSystemUserProof;
function inspectContext(transform: (context: BackgroundJobContext) => BackgroundJobContext): BackgroundJobHandler {
  const base = handlerForRole('batch');
  return {
    ...base,
    resolveFamily(name) {
      const family = base.resolveFamily(name);
      return family
        ? { ...family, execute: (context, payload) => family.execute(transform(context), payload) }
        : undefined;
    },
  };
}
async function run(family: string, payload: Record<string, unknown> = {}, handler = handlerForRole('batch')) {
  const { job } = await proof.active(family, payload, false);
  const outcome = await executeBackgroundJob(
    proof.workerDatabase,
    proof.workerBoss,
    job,
    handler,
    new AbortController().signal,
  );
  const [record] = await proof.db.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, job.id));
  return { outcome, record, queueJob: await proof.boss.getJobById(job.name, job.id) };
}
async function cli(script: string) {
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const child = spawn('vp', ['exec', 'node', '--import', 'tsx', `packages/db/scripts/${script}`], {
    cwd: root,
    shell: false,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: 'backend-staging',
      DATABASE_URL: 'postgresql://owned:unused@127.0.0.1:1/unused',
      READ_REPLICA_URL: 'postgresql://owned:unused@127.0.0.1:1/unused',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let expired = false;
  const terminate = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* The owned child may have exited already. */
    }
  };
  const timer = setTimeout(() => {
    expired = true;
    terminate();
  }, 15_000);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 32_768) terminate();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 32_768) terminate();
  });
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { exit, output, expired };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) terminate();
  }
}

describe('real restricted worker dispatch and direct CLI batch identity adoption', () => {
  beforeAll(async () => {
    proof = new BatchSystemUserProof();
    await proof.start();
  });
  beforeEach(async () => {
    await clearBatchJobFixture(proof.db);
    await proof.reset();
    await seedBatchJobFixture(proof.db);
    await proof.prepare();
    vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN', proof.origin);
    vi.stubEnv(
      'CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET',
      proof.environment.CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET!,
    );
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await clearBatchJobFixture(proof.db);
  });
  afterAll(async () => {
    await proof?.close();
  });

  it.each([
    ['refresh-recommendations', 'system-recommendations'],
    ['refresh-hold-features', 'system-hold-classifier'],
  ])(
    'runs the actual %s family without worker users INSERT or auth-table access',
    async (family, userId) => {
      const [privileges] =
        await proof.workerPool`SELECT has_any_column_privilege(current_user, 'users', 'INSERT') AS user_insert, has_table_privilege(current_user, 'auth_email_projection', 'SELECT') AS auth_read, has_table_privilege(current_user, 'user_credentials', 'INSERT') AS credential_insert`;
      expect(privileges).toEqual({ user_insert: false, auth_read: false, credential_insert: false });
      await expect(proof.workerPool`SELECT * FROM auth_email_projection LIMIT 1`).rejects.toMatchObject({
        code: '42501',
      });
      const result = await run(family);
      expect(result.outcome).toBe('succeeded');
      expect(result.record).toMatchObject({ status: 'succeeded', attemptToken: null });
      expect(result.queueJob?.state).toBe('completed');
      expect(proof.requestCount).toBe(1);
      expect(await proof.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
      expect(
        await proof.db.select().from(authEmailReservations).where(eq(authEmailReservations.ownerUserId, userId)),
      ).toHaveLength(1);
      if (family === 'refresh-recommendations') {
        expect(
          await proof.db.select().from(playlists).where(isNotNull(playlists.generatedRecommendation)),
        ).not.toHaveLength(0);
        expect(
          await proof.db.select().from(playlistOwnership).where(eq(playlistOwnership.userId, userId)),
        ).not.toHaveLength(0);
      } else
        expect(
          await proof.db.select().from(userHoldClassifications).where(eq(userHoldClassifications.userId, userId)),
        ).not.toHaveLength(0);
    },
    30_000,
  );
  it.each([{ dryRun: true }, { shadow: false }])(
    'does not request an identity for classifier options %j',
    async (payload) => {
      const result = await run('refresh-hold-features', payload);
      expect(result.outcome).toBe('succeeded');
      expect(result.queueJob?.state).toBe('completed');
      expect(proof.requestCount).toBe(0);
      expect(await proof.db.select().from(users).where(eq(users.id, 'system-hold-classifier'))).toEqual([]);
      expect(await proof.db.select().from(verificationTokens)).toEqual([]);
    },
  );
  it('settles a failed command without any local data transaction or direct-write fallback', async () => {
    proof.environment.CURRENT_STORE_BATCH_SYSTEM_USERS_MODE = 'legacy';
    let batches = 0;
    const handler = inspectContext((context) => ({
      ...context,
      transaction: (callback) => {
        batches += 1;
        return context.transaction(callback);
      },
    }));
    const result = await run('refresh-recommendations', {}, handler);
    expect(result.outcome).toBe('failed');
    expect(result.record.status).toBe('retrying');
    expect(result.queueJob?.state).toBe('retry');
    expect(batches).toBe(0);
    expect(proof.requestCount).toBe(1);
    expect(await proof.db.select().from(users).where(eq(users.id, 'system-recommendations'))).toEqual([]);
    expect(await proof.db.select().from(verificationTokens)).toEqual([]);
  });
  it('rejects a stripped staging capability before any direct writer is invoked', async () => {
    let observed: unknown;
    let batches = 0;
    const base = handlerForRole('batch');
    const handler: BackgroundJobHandler = {
      ...base,
      resolveFamily(name) {
        const family = base.resolveFamily(name);
        return family
          ? {
              ...family,
              async execute(context, payload) {
                try {
                  await family.execute(
                    {
                      ...context,
                      systemUserAuthority: undefined,
                      transaction: (callback) => {
                        batches += 1;
                        return context.transaction(callback);
                      },
                    },
                    payload,
                  );
                } catch (error) {
                  observed = error;
                  throw error;
                }
              },
            }
          : undefined;
      },
    };
    expect((await run('refresh-recommendations', {}, handler)).outcome).toBe('failed');
    expect(observed).toBeInstanceOf(AuthBackendUnavailableError);
    expect(observed).toMatchObject({ message: AUTH_BACKEND_UNAVAILABLE });
    expect(batches).toBe(0);
    expect(proof.requestCount).toBe(0);
  });
  it('keeps the captured staging authority when process configuration changes during family dispatch', async () => {
    const handler = inspectContext((context) => {
      vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_MODE', 'legacy');
      vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN', 'http://127.0.0.1:1');
      vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET', 'incorrect-after-dispatch');
      return context;
    });
    expect((await run('refresh-recommendations', {}, handler)).outcome).toBe('succeeded');
    expect(proof.requestCount).toBe(1);
    expect(
      await proof.db
        .select()
        .from(authEmailReservations)
        .where(eq(authEmailReservations.ownerUserId, 'system-recommendations')),
    ).toHaveLength(1);
  }, 30_000);
  it('retains the committed owner when a later real data batch is denied', async () => {
    await proof.db.execute(sql`REVOKE INSERT ON TABLE ${boardSetterStats} FROM ${sql.identifier(proof.workerRole)}`);
    try {
      const result = await run('refresh-recommendations');
      expect(result.outcome).toBe('failed');
      expect(result.record.status).toBe('retrying');
      expect(proof.requestCount).toBe(1);
      expect(await proof.db.select().from(users).where(eq(users.id, 'system-recommendations'))).toHaveLength(1);
      expect(await proof.db.select().from(verificationTokens)).toHaveLength(1);
    } finally {
      await proof.db.execute(sql`GRANT INSERT ON TABLE ${boardSetterStats} TO ${sql.identifier(proof.workerRole)}`);
    }
  });
  it('preserves the legacy three-column writer and never requires a machine endpoint', async () => {
    await proof.db.execute(
      sql`GRANT INSERT (id, name, email) ON TABLE ${users} TO ${sql.identifier(proof.workerRole)}`,
    );
    try {
      vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_MODE', 'legacy');
      vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN', 'not-a-url');
      vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET', '');
      const result = await run('refresh-recommendations');
      expect(result.outcome).toBe('succeeded');
      expect(proof.requestCount).toBe(0);
      expect(
        await proof.db
          .select()
          .from(users)
          .where(and(eq(users.id, 'system-recommendations'), eq(users.email, 'recommendations@boardsesh.com'))),
      ).toHaveLength(1);
      expect(
        await proof.db
          .select()
          .from(authEmailReservations)
          .where(eq(authEmailReservations.ownerUserId, 'system-recommendations')),
      ).toEqual([]);
      expect(await proof.db.select().from(authSubjectCutoffs)).toEqual([]);
    } finally {
      await proof.db.execute(
        sql`REVOKE INSERT (id, name, email) ON TABLE ${users} FROM ${sql.identifier(proof.workerRole)}`,
      );
    }
  }, 30_000);
  it.each(['refresh-recommendations.ts', 'refresh-hold-features.ts'])(
    'rejects the unqueued staging CLI %s before opening its deliberately unusable database',
    async (script) => {
      const result = await cli(script);
      expect(result.expired).toBe(false);
      expect(result.exit).toBe(1);
      expect(result.output).toContain(
        'Batch system user authority requires running this job through the queue operator',
      );
      expect(result.output).not.toContain('ECONNREFUSED');
      expect(proof.requestCount).toBe(0);
    },
    20_000,
  );
});
