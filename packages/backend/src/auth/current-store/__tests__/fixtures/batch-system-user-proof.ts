// Establish the owned worker URL before imports can construct backend DB singletons.
import { getWorkerDatabaseName, getWorkerDatabaseUrl } from '../../../../__tests__/worker-db';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { BATCH_SYSTEM_USER_COMMAND_PATH, type BatchSystemUserCommand } from '@boardsesh/auth-protocol';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { claimBackgroundJobRun } from '@boardsesh/db/queries';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  sessions,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { db as administratorDatabase } from '../../../../db/client';
import { handleCurrentStoreBatchSystemUsers } from '../../../../handlers/current-store-batch-system-users';
import { enqueueBackgroundJob, type BackgroundJobPayload } from '../../../../workers/jobs';
import { prepareProjectionUnderUsersTableLock } from '../../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../../foundation-context';

async function bounded<Result>(pending: Promise<Result>, milliseconds = 8_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned batch system-user fixture deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Disposable local proof only. Construction performs no database or network work. */
export class BatchSystemUserProof {
  readonly db = administratorDatabase;
  backendDatabase!: DbInstance;
  workerDatabase!: DbInstance;
  ownerPool!: ReturnType<typeof postgres>;
  backendPool!: ReturnType<typeof postgres>;
  workerPool!: ReturnType<typeof postgres>;
  boss!: PgBoss;
  workerBoss!: PgBoss;
  readonly backendRole = `ba03_batch_backend_${randomUUID().replaceAll('-', '')}`;
  readonly workerRole = `ba03_batch_worker_${randomUUID().replaceAll('-', '')}`;
  readonly environment: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: 'backend-staging',
    CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET: randomBytes(32).toString('hex'),
    CURRENT_STORE_AUTH_RPC_SECRET: randomBytes(32).toString('hex'),
    NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
    CRON_SECRET: randomBytes(32).toString('hex'),
    CURRENT_STORE_DELETED_EMAIL_KEY: randomBytes(32).toString('hex'),
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: 'legacy',
    CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
    CURRENT_STORE_WEB_OAUTH_MODE: 'legacy',
    CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'legacy',
    CURRENT_STORE_NATIVE_OAUTH_MODE: 'legacy',
    EMAIL_VERIFICATION_ENABLED: 'false',
    DEBUG_SQL: 'false',
  };
  private readonly initialEnvironment = { ...this.environment };
  origin = '';
  requestCount = 0;
  dropReplies = false;
  private readonly ownedRoles: string[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly activeRequests = new Set<Promise<void>>();
  private readonly droppedReplies = new Set<ServerResponse>();
  private server: Server | undefined;
  private started = false;
  private accepting = false;
  private closing: Promise<void> | undefined;

  private ownedDatabaseUrl(): URL {
    const address = new URL(process.env.DATABASE_URL ?? '');
    const saltedName = /^boardsesh_backend_test_w(?:0|[1-9][0-9]*)_[a-f0-9]{12}$/;
    const isolatedCiName = /^boardsesh_backend_test_w(?:0|[1-9][0-9]*)$/;
    const name = address.pathname.slice(1);
    const ci = process.env.CI === 'true' || process.env.CI === '1';
    // 5433 trusts the canonical test workflow, not attested cluster ownership:
    // global setup can reuse an already reachable service instead of Docker.
    const canonicalTestPort =
      address.port === '5433' &&
      ((ci && process.env.GITHUB_ACTIONS === 'true') ||
        (process.env.VITEST === 'true' && !process.env.CI && process.env.SKIP_TEST_INFRA !== '1'));
    if (
      !['postgres:', 'postgresql:'].includes(address.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      (!['15475', '15478'].includes(address.port) && !canonicalTestPort) ||
      process.env.DEBUG_SQL === 'true' ||
      address.search ||
      address.hash ||
      (!saltedName.test(name) && !(ci && isolatedCiName.test(name))) ||
      name !== getWorkerDatabaseName() ||
      address.href !== new URL(getWorkerDatabaseUrl()).href
    )
      throw new Error('Batch proof requires its exact owned local worker database');
    return address;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Owned batch fixture cannot be started twice');
    const address = this.ownedDatabaseUrl();
    this.started = true;
    const poolOptions = {
      max: 2,
      connect_timeout: 3,
      idle_timeout: 1,
      onnotice: () => {},
      connection: { statement_timeout: 5_000, lock_timeout: 4_000 },
    };
    // pg-boss initialization issues BEGIN/COMMIT through this one connection.
    this.ownerPool = postgres(address.href, { ...poolOptions, max: 1 });
    const backendPassword = randomBytes(32).toString('hex');
    const workerPassword = randomBytes(32).toString('hex');
    for (const [role, password] of [
      [this.backendRole, backendPassword],
      [this.workerRole, workerPassword],
    ]) {
      if (!/^ba03_batch_(?:backend|worker)_[a-f0-9]{32}$/.test(role)) throw new Error('Unsafe owned batch role name');
      const [existing] = await this.ownerPool`SELECT 1 AS present FROM pg_roles WHERE rolname = ${role}`;
      if (existing) throw new Error('Owned batch role name was already present');
      // Track before CREATE acknowledgement, including uncertain partial startup.
      this.ownedRoles.push(role);
      await this.db.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
      );
    }
    // The normal test schema omits the durable job ledger. Reuse its checked-in
    // generated migrations, as the existing queue integration fixtures do.
    const [ledger] = await this.ownerPool`SELECT to_regclass('public.background_job_runs') AS present`;
    if (!ledger.present) {
      await this.ownerPool.unsafe(
        readFileSync(new URL('../../../../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8'),
      );
    }
    const [family] = await this
      .ownerPool`SELECT 1 AS present FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'background_job_runs' AND column_name = 'family'`;
    if (!family) {
      await this.ownerPool.unsafe(
        readFileSync(new URL('../../../../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8'),
      );
    }
    await initializeJobQueueSchema(drizzle(this.ownerPool), undefined, undefined, [`batch=${this.workerRole}`]);
    await this.db.execute(
      sql`REVOKE INSERT (id, name, email) ON TABLE ${users} FROM ${sql.identifier(this.workerRole)}`,
    );
    await this.db.execute(sql`GRANT USAGE ON SCHEMA public, pgboss TO ${sql.identifier(this.backendRole)}`);
    await this.db.execute(
      sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${users}, ${authEmailReservations} TO ${sql.identifier(this.backendRole)}`,
    );
    await this.db.execute(
      sql`GRANT SELECT, INSERT ON TABLE ${authEmailReservationMembers}, ${verificationTokens} TO ${sql.identifier(this.backendRole)}`,
    );
    await this.db.execute(
      sql`GRANT SELECT, UPDATE ON TABLE ${authEmailProjection}, ${authSubjectCutoffs}, ${backgroundJobRuns}, pgboss.job TO ${sql.identifier(this.backendRole)}`,
    );
    await this.db.execute(
      sql`GRANT SELECT ON TABLE ${userCredentials}, ${accounts}, ${sessions}, ${mobileRefreshTokens} TO ${sql.identifier(this.backendRole)}`,
    );

    const backendUrl = new URL(address),
      workerUrl = new URL(address);
    backendUrl.username = this.backendRole;
    backendUrl.password = backendPassword;
    workerUrl.username = this.workerRole;
    workerUrl.password = workerPassword;
    // Deliberately no connection-level limits: the real command must install
    // its statement/lock limits before its first ledger lock for the proof.
    this.backendPool = postgres(backendUrl.href, {
      ...poolOptions,
      connection: { statement_timeout: 0, lock_timeout: 0 },
    });
    this.workerPool = postgres(workerUrl.href, poolOptions);
    this.backendDatabase = drizzle(this.backendPool) as unknown as DbInstance;
    this.workerDatabase = drizzle(this.workerPool) as unknown as DbInstance;
    const bossOptions = { max: 1, migrate: false, supervise: false, schedule: false };
    this.boss = new PgBoss({ ...bossOptions, connectionString: address.href });
    this.workerBoss = new PgBoss({ ...bossOptions, connectionString: workerUrl.href });
    this.boss.on('error', () => {});
    this.workerBoss.on('error', () => {});
    await this.boss.start();
    await this.workerBoss.start();

    this.accepting = true;
    this.server = createServer((request, response) => {
      if (!this.accepting) {
        response.destroy();
        return;
      }
      this.requestCount += 1;
      response.setHeader('Connection', 'close');
      const originalEnd = response.end.bind(response);
      response.end = ((...endArguments: unknown[]) => {
        if (this.dropReplies && response.statusCode === 200) {
          // The actual handler committed before end(): send its real headers,
          // retain its body, then let the test explicitly destroy this socket.
          response.flushHeaders();
          this.droppedReplies.add(response);
          return response;
        }
        return Reflect.apply(originalEnd, response, endArguments) as ServerResponse;
      }) as typeof response.end;
      const pending = handleCurrentStoreBatchSystemUsers(
        request,
        response,
        this.backendDatabase,
        this.environment,
      ).catch(() => {
        response.destroy();
      });
      this.activeRequests.add(pending);
      void pending.finally(() => this.activeRequests.delete(pending));
    });
    this.server.requestTimeout = 12_000;
    this.server.headersTimeout = 12_000;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => this.sockets.delete(socket));
    });
    await bounded(
      new Promise<void>((resolve, reject) => {
        this.server!.once('error', () => reject(new Error('Owned batch HTTP listener failed')));
        this.server!.listen(0, '127.0.0.1', resolve);
      }),
    );
    const bound = this.server.address();
    if (!bound || typeof bound === 'string') throw new Error('Owned batch HTTP did not bind');
    this.origin = `http://127.0.0.1:${bound.port}`;
    this.environment.CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN = this.origin;
  }

  async reset(): Promise<void> {
    this.ownedDatabaseUrl();
    this.releaseDroppedReplies();
    await bounded(Promise.all(this.activeRequests));
    await this.boss.deleteAllJobs(BACKGROUND_JOB_QUEUES.batch);
    await this.db.delete(backgroundJobRuns);
    await this.db.delete(verificationTokens);
    await this.db.delete(authEmailReservationMembers);
    await this.db.delete(authEmailReservations);
    await this.db.delete(authSecurityMutationEvents);
    await this.db.delete(authSubjectCutoffs);
    await this.db.delete(authEmailProjection);
    await this.db.delete(users);
    this.requestCount = 0;
    for (const name of Object.keys(this.environment)) delete this.environment[name];
    Object.assign(this.environment, this.initialEnvironment, { CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN: this.origin });
  }

  async prepare(): Promise<ExpectedCurrentStoreAuthority> {
    this.ownedDatabaseUrl();
    const projectionId = randomUUID();
    await this.db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      // Test-owned fixture only. Production has no phase activation endpoint.
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    this.environment.CURRENT_STORE_AUTH_PROJECTION_ID = projectionId;
    this.environment.CURRENT_STORE_AUTH_WRITER_EPOCH = '1';
    return {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
  }

  async active(
    family: string,
    payload: Record<string, unknown> = {},
    claim = true,
  ): Promise<{
    job: JobWithMetadata<BackgroundJobPayload>;
    token: string | null;
  }> {
    this.ownedDatabaseUrl();
    const enqueued = await enqueueBackgroundJob(this.db, this.boss, {
      family,
      payload,
      role: 'batch',
      singletonKey: randomUUID(),
    });
    const [job] = await this.workerBoss.fetch<BackgroundJobPayload>(BACKGROUND_JOB_QUEUES.batch, {
      includeMetadata: true,
      batchSize: 1,
    });
    if (!job || job.id !== enqueued.runId) throw new Error('Owned batch fetch did not return its enqueued job');
    const token = claim ? await claimBackgroundJobRun(this.workerDatabase, job.id, job.name, job.retryCount) : null;
    if (claim && !token) throw new Error('Owned batch attempt did not become active');
    return { job, token };
  }

  command(runId: string, attemptToken: string): BatchSystemUserCommand {
    return {
      protocolVersion: 1,
      operation: 'ensure',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { runId, attemptToken },
    };
  }

  async post(
    command: unknown,
    options: { secret?: string; headers?: Record<string, string>; method?: string; path?: string } = {},
  ): Promise<{ response: Response; body: unknown }> {
    const address = new URL(options.path ?? BATCH_SYSTEM_USER_COMMAND_PATH, this.origin);
    if (address.origin !== this.origin) throw new Error('Owned batch request escaped its listener');
    const method = options.method ?? 'POST';
    const response = await fetch(address, {
      method,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.secret ?? this.environment.CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET}`,
        ...options.headers,
      },
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(command) }),
    });
    const body: unknown = await response.json();
    return { response, body };
  }

  releaseDroppedReplies(): void {
    this.dropReplies = false;
    for (const response of this.droppedReplies) response.destroy();
    this.droppedReplies.clear();
  }

  async waitForBackendLock(): Promise<void> {
    this.ownedDatabaseUrl();
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      const [waiting] = await bounded(
        this
          .ownerPool`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename = ${this.backendRole} AND wait_event_type = 'Lock'`,
        Math.max(1, deadline - performance.now()),
      );
      if (waiting.count > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Owned backend lock wait was not observed');
  }

  async close(): Promise<void> {
    return (this.closing ??= this.closeOwned());
  }

  private async closeOwned(): Promise<void> {
    this.accepting = false;
    this.releaseDroppedReplies();
    const failures: Error[] = [];
    const cleanup = async (action: () => Promise<unknown>, category: string) => {
      try {
        await bounded(action(), 12_000);
      } catch {
        failures.push(new Error(`Owned batch ${category} cleanup failed`));
      }
    };
    if (this.server) {
      const server = this.server;
      await cleanup(async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        for (const socket of this.sockets) socket.destroy();
        await closed;
      }, 'HTTP listener');
    }
    await cleanup(() => Promise.all(this.activeRequests), 'HTTP handlers');
    for (const boss of [this.workerBoss, this.boss]) {
      if (boss) await cleanup(() => boss.stop({ graceful: false, close: true }), 'queue client');
    }
    for (const pool of [this.workerPool, this.backendPool]) {
      if (pool) await cleanup(() => pool.end({ timeout: 3 }), 'LOGIN pool');
    }
    if (this.ownerPool) {
      for (const role of this.ownedRoles) {
        await cleanup(async () => {
          if (!/^ba03_batch_(?:backend|worker)_[a-f0-9]{32}$/.test(role))
            throw new Error('Unsafe owned batch cleanup role');
          const [existing] = await this.ownerPool`SELECT oid FROM pg_roles WHERE rolname = ${role}`;
          if (!existing) return;
          const [owned] = await this
            .ownerPool`SELECT count(*)::integer AS count FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = ${existing.oid} AND deptype = 'o'`;
          if (owned.count !== 0) throw new Error('Owned fixture role unexpectedly owns objects');
          await this.ownerPool.unsafe(`DROP OWNED BY "${role}"`);
          await this.ownerPool.unsafe(`DROP ROLE "${role}"`);
        }, 'role grants');
      }
      await cleanup(() => this.ownerPool.end({ timeout: 3 }), 'owner pool');
    }
    if (failures.length) throw new AggregateError(failures, 'Owned batch fixture cleanup incomplete');
  }
}
