import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authEmailVerificationTokens,
  authEmailVerificationState,
  authPasswordRecoveryTokens,
  authPasswordRecoveryState,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  users,
  userCredentials,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../foundation-context';

const role = `ba03_consumer_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(32).toString('hex');
const secret = randomBytes(32).toString('hex');
const trackedRoles: string[] = [];
const mutable = [
  users,
  userCredentials,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  mobileRefreshTokens,
];
const insertable = [authSubjectCutoffs, authPasswordRecoveryState, authPasswordRecoveryTokens];
const append = [verificationTokens, authSecurityMutationEvents];
const allTables = [...mutable, ...insertable, ...append];
const handlers = new Set<Promise<void>>();
const sockets = new Set<Socket>();
const children = new Set<ChildProcess>();
const childCompletions = new Map<ChildProcess, Promise<void>>();
let accepting = false;
let cleanupFailed = false;
let pool: ReturnType<typeof postgres> | undefined;
let writer: DbInstance;
let server: Server;
let origin: string;
let projectionId: string;
let originalHash: string;

async function bounded<T>(pending: Promise<T>, milliseconds = 18000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned consumer deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
function child(roleName: 'web' | 'native' | 'expo') {
  const require = createRequire(import.meta.url);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://owned_probe:unused@127.0.0.1:1/owned_probe',
    READ_REPLICA_URL: 'postgresql://owned_probe:unused@127.0.0.1:1/owned_probe',
    TSX_TSCONFIG_PATH: fileURLToPath(
      new URL(
        roleName === 'web' ? '../../../../../web/tsconfig.json' : '../../../../../mobile/tsconfig.json',
        import.meta.url,
      ),
    ),
  };
  // The private web credential arrives only in its own IPC message. An installed
  // consumer process never inherits a server credential from its test parent.
  for (const key of Object.keys(environment))
    if (/^(?:CURRENT_STORE_|NEXTAUTH_SECRET$|AUTH_SECRET$|CRON_SECRET$)/.test(key)) delete environment[key];
  const processHandle = spawn(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      ...(roleName === 'web' ? ['--conditions=react-server'] : []),
      '--import',
      require.resolve('tsx'),
      fileURLToPath(new URL('./fixtures/recovery-public-consumer-probe.ts', import.meta.url)),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: environment,
    },
  );
  children.add(processHandle);
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let exited = false;
  const completion = new Promise<void>((resolve, reject) => {
    processHandle.once('error', () => {
      exited = true;
      reject(new Error('Owned consumer child failed'));
      for (const listener of listeners) listener();
    });
    processHandle.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && !Array.isArray(message))
        messages.push(message as Record<string, unknown>);
      for (const listener of listeners) listener();
    });
    processHandle.once('exit', (code) => {
      exited = true;
      children.delete(processHandle);
      childCompletions.delete(processHandle);
      if (code === 0) resolve();
      else reject(new Error('Owned consumer child failed'));
      for (const listener of listeners) listener();
    });
  });
  childCompletions.set(processHandle, completion);
  void completion.catch(() => {});
  async function wait(kind: string) {
    let wake = () => {};
    try {
      return await bounded(
        new Promise<Record<string, unknown>>((resolve, reject) => {
          wake = () => {
            const failure = messages.find((message) => message.kind === 'failure');
            if (failure) {
              const phase =
                typeof failure.phase === 'string' &&
                /^(?:input|web-config|web-load|web-listen|consumer-config|consumer-load|consumer-request)$/.test(
                  failure.phase,
                )
                  ? failure.phase
                  : 'unknown';
              const code =
                typeof failure.code === 'string' && /^ERR_[A-Z_]+$/.test(failure.code)
                  ? failure.code
                  : 'fixture_failure';
              reject(new Error(`Owned fixture failed during ${phase} (${code})`));
              return;
            }
            const found = messages.find((message) => message.kind === kind);
            if (found) resolve(found);
            else if (exited) reject(new Error('Owned child ended before receipt'));
          };
          listeners.add(wake);
          wake();
        }),
      );
    } finally {
      listeners.delete(wake);
    }
  }
  return { process: processHandle, completion, wait };
}
async function webHost() {
  const host = child('web');
  host.process.send({ role: 'web', origin, secret });
  const ready = await host.wait('ready');
  if (typeof ready.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin))
    throw new Error('Invalid owned public origin');
  return {
    ...host,
    origin: ready.origin,
    async stop() {
      if (host.process.exitCode === null) host.process.send({ action: 'stop' });
      await bounded(host.completion);
    },
  };
}
async function consumer(
  roleName: 'native' | 'expo',
  publicOrigin: string,
  operation: 'forgot' | 'reset',
  email: string,
  token?: string,
) {
  const probe = child(roleName);
  try {
    probe.process.send({ role: roleName, origin: publicOrigin, operation, email, ...(token ? { token } : {}) });
    const report = await probe.wait('result');
    await bounded(probe.completion);
    expect(report.ok).toBe(true);
    expect(report.noCookies).toBe(true);
    expect(report.noAuthority).toBe(true);
    expect(report.publicShape).toBe(true);
    expect(report.exactlyOne).toBe(true);
    expect(report.noOutside).toBe(true);
    expect(report.oldPreserved).toBe(true);
    expect(report.noWrites).toBe(true);
    expect(report.sameGeneration).toBe(true);
    return { success: report.success, status: report.status, network: report.network };
  } finally {
    if (probe.process.exitCode === null && probe.process.signalCode === null) probe.process.kill('SIGKILL');
    await Promise.allSettled([probe.completion]);
  }
}
async function seed() {
  const userId = randomUUID();
  const email = `Mixed.${randomUUID()}+Tag@Example.TEST`;
  await db.insert(users).values({ id: userId, email });
  await db.insert(userCredentials).values({ userId, passwordHash: originalHash });
  await db.transaction((transaction) =>
    reserveEnforcedEmail(transaction, {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
      rawEmail: email,
      requestedUserId: userId,
    }),
  );
  return { userId, email };
}

describe('real public recovery routes, private HTTP and installed native/Expo consumers', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Only owned worker database allowed');
    originalHash = await bcrypt.hash('original-consumer-password', 12);
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      trackedRoles.push(role);
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(
        sql`GRANT SELECT, UPDATE ON TABLE ${sql.join(mutable, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${sql.join(insertable, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${sql.join(append, sql`, `)} TO ${sql.identifier(role)}`,
      );
    });
    url.username = role;
    url.password = rolePassword;
    pool = postgres(url.toString(), {
      max: 2,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 6000, lock_timeout: 4000 },
    });
    writer = drizzle(pool);
    server = createServer((request, response) => {
      if (!accepting) {
        response.destroy();
        return;
      }
      const pending = handleCurrentStoreWebAuth(request, response, writer).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      });
      handlers.add(pending);
      void pending.finally(() => handlers.delete(pending));
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned private bind failed');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    if (cleanupFailed || handlers.size || children.size) throw new Error('Owned consumer fixture not quiescent');
    for (const table of [
      authPasswordRecoveryTokens,
      authPasswordRecoveryState,
      authEmailVerificationTokens,
      authEmailVerificationState,
      authEmailReservationMembers,
      authEmailReservations,
      authSecurityMutationEvents,
      authSubjectCutoffs,
      authEmailProjection,
      verificationTokens,
      users,
    ])
      await db.delete(table);
    projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('DEBUG_SQL', 'false');
    accepting = true;
  });
  afterEach(async () => {
    accepting = false;
    for (const processHandle of children) processHandle.kill('SIGKILL');
    try {
      await bounded(Promise.allSettled(childCompletions.values()), 6000);
      await bounded(Promise.allSettled(handlers), 10000);
      if (handlers.size || children.size) throw new Error('Owned consumer teardown not quiescent');
    } catch {
      cleanupFailed = true;
      throw new Error('Owned consumer teardown failed; environment retained');
    }
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    accepting = false;
    const failures: string[] = [];
    for (const processHandle of children) processHandle.kill('SIGKILL');
    try {
      await bounded(Promise.allSettled(childCompletions.values()), 6000);
    } catch {
      failures.push('children');
    }
    try {
      if (server) {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await bounded(new Promise<void>((resolve) => server.close(() => resolve())), 6000);
      }
    } catch {
      failures.push('http');
    }
    try {
      await bounded(Promise.allSettled(handlers), 10000);
      if (handlers.size || children.size) throw new Error('Active fixture work');
    } catch {
      failures.push('handlers');
    }
    try {
      await pool?.end({ timeout: 4 });
    } catch {
      failures.push('pool');
    }
    for (const name of trackedRoles) {
      let exists = true;
      try {
        exists = (await admin(sql`SELECT 1 FROM pg_roles WHERE rolname=${name}`)).length > 0;
      } catch {
        failures.push('role-lookup');
      }
      if (!exists) continue;
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(allTables, sql`, `)} FROM ${sql.identifier(name)}`);
      } catch {
        failures.push('table-grants');
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(name)}`);
      } catch {
        failures.push('schema-grants');
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(name)}`);
      } catch {
        failures.push('role');
      }
    }
    if (!cleanupFailed && !failures.length) vi.unstubAllEnvs();
    if (failures.length) throw new Error(`Owned consumer cleanup failed: ${failures.join(',')}`);
  });

  it.each(['native', 'expo'] as const)(
    'runs actual %s forgot/mail/reset with a non-authoritative email hint and preserves local credentials',
    async (platform) => {
      const owner = await seed();
      const host = await webHost();
      try {
        expect(await consumer(platform, host.origin, 'forgot', owner.email)).toEqual({
          success: true,
          status: 200,
          network: false,
        });
        expect(
          (await db.select({ userId: authPasswordRecoveryTokens.userId }).from(authPasswordRecoveryTokens)).length,
        ).toBe(1);
        const mailPhase = await host.wait('mail-phase');
        expect(mailPhase.transportSelected).toBe(true);
        expect(mailPhase.compiledText).toBe(true);
        expect(mailPhase.compiledHtml).toBe(true);
        const mail = await host.wait('mail');
        expect(mail.roundTrip).toBe(true);
        expect(mail.email === owner.email).toBe(true);
        if (typeof mail.token !== 'string') throw new Error('Owned mail capability absent');
        expect(await consumer(platform, host.origin, 'reset', 'wrong-hint@example.test', mail.token)).toEqual({
          success: true,
          status: 200,
          network: false,
        });
        const [credential] = await db.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId));
        expect(await bcrypt.compare('new-consumer-password', credential.passwordHash)).toBe(true);
        const [cutoff] = await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId));
        expect(cutoff.generation).toBe(1);
        expect((await db.select().from(authSecurityMutationEvents)).map((event) => event.userId)).toEqual([
          owner.userId,
        ]);
      } finally {
        await host.stop();
      }
    },
    30000,
  );
  it.each(['native', 'expo'] as const)(
    'keeps actual %s invalid400 and backend-unavailable503 from storing credentials or falling back',
    async (platform) => {
      const host = await webHost();
      try {
        expect(await consumer(platform, host.origin, 'reset', 'hint@example.test', `pr1_${'A'.repeat(43)}`)).toEqual({
          success: false,
          status: 400,
          network: false,
        });
        host.process.send({ action: 'unavailable' });
        await host.wait('unavailable');
        expect(await consumer(platform, host.origin, 'forgot', 'hint@example.test')).toEqual({
          success: false,
          status: 503,
          network: false,
        });
        expect(await db.select().from(authPasswordRecoveryTokens)).toHaveLength(0);
      } finally {
        await host.stop();
      }
    },
    30000,
  );
  it.each(['native', 'expo'] as const)(
    'keeps actual %s network failure from changing credentials or generation',
    async (platform) => {
      const host = await webHost();
      await host.stop();
      expect(await consumer(platform, host.origin, 'forgot', 'hint@example.test')).toEqual({
        success: false,
        status: null,
        network: true,
      });
    },
    30000,
  );
});
