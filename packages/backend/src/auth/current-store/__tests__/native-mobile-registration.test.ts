import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authEmailVerificationTokens,
  authEmailVerificationState,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  users,
  userCredentials,
  userProfiles,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';

const roleSalt = randomUUID().replaceAll('-', '');
const writerRole = `ba03_mobile_${roleSalt}`;
const oldRole = `ba03_old_mobile_${roleSalt}`;
const rolePassword = randomBytes(32).toString('hex');
const issuerSecret = randomBytes(32).toString('hex');
const trackedRoles: string[] = [];
const sockets = new Set<Socket>();
const password = '  Native café 山🧗 password  ';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let writerPool: ReturnType<typeof postgres> | undefined;
let writer: DbInstance;
let server: Server | undefined;
let origin: string;
let projectionId: string;
let dropNetwork = false;
let dropResponseBody = false;

type MobileProbe = {
  ok: boolean;
  registrationThrew: boolean;
  success: boolean;
  failureStatus: number | null;
  networkFailure: boolean;
  observed201: boolean;
  flat: boolean;
  signatureValid: boolean;
  lifetimeValid: boolean;
  receiptMatches: boolean;
  noAuthority: boolean;
  exactlyOneRequest: boolean;
  noExternalCalls: boolean;
  nativeClientIdentity: boolean;
  storedPairMatches: boolean;
  writeOrder: boolean;
  newGeneration: boolean;
  oldPreserved: boolean;
  noWritesOnFailure: boolean;
  sameGeneration: boolean;
  ownerHash: string | null;
  refreshHash: string | null;
  createdAtHash: string | null;
};
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
    return transaction.execute(statement);
  });
}
async function mobileProbe(email: string): Promise<MobileProbe> {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--import',
      require.resolve('tsx'),
      fileURLToPath(new URL('./fixtures/native-registration-mobile-probe.ts', import.meta.url)),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../mobile/tsconfig.json', import.meta.url)),
      },
    },
  );
  let report: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Owned native client child failed to start')));
    child.on('message', (message: unknown) => {
      report = message;
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else {
        const record = report && typeof report === 'object' ? (report as Record<string, unknown>) : {};
        const phase = ['input', 'load-store', 'load-auth', 'seed', 'register', 'readback', 'verify'].includes(
          String(record.phase),
        )
          ? String(record.phase)
          : 'unknown';
        const category =
          typeof record.code === 'string' && /^ERR_[A-Z_]+$/.test(record.code) ? record.code : 'probe_failure';
        reject(new Error(`Owned native client failed during ${phase} (${category})`));
      }
    });
  });
  try {
    child.send({ origin, email, password, issuerVerificationSecret: issuerSecret });
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned mobile probe deadline')), 18000);
      }),
    ]);
    if (!report || typeof report !== 'object' || !('ok' in report) || report.ok !== true)
      throw new Error('Invalid owned mobile probe report');
    return report as MobileProbe;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled([completion]);
  }
}
function installedRequest(report: MobileProbe) {
  expect(report.noAuthority).toBe(true);
  expect(report.exactlyOneRequest).toBe(true);
  expect(report.noExternalCalls).toBe(true);
  expect(report.nativeClientIdentity).toBe(true);
}
function preserved(report: MobileProbe) {
  installedRequest(report);
  expect(report.success).toBe(false);
  expect(report.oldPreserved).toBe(true);
  expect(report.noWritesOnFailure).toBe(true);
  expect(report.sameGeneration).toBe(true);
}

describe('actual installed mobile registration client and auth-store against owned public HTTP', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const ownedUrl = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(ownedUrl.hostname) ||
      !ownedUrl.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Mobile fixture requires owned local worker database');
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(oldRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      trackedRoles.push(oldRole);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(writerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      trackedRoles.push(writerRole);
    });
    ownedUrl.username = writerRole;
    ownedUrl.password = rolePassword;
    writerPool = postgres(ownedUrl.toString(), {
      max: 3,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 5000, lock_timeout: 4000 },
    });
    writer = drizzle(writerPool);
    server = createServer((request, response) => {
      if (dropNetwork) {
        request.socket.destroy();
        return;
      }
      if (request.url !== '/auth/native/register') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (dropResponseBody) {
        // Transport fault only: the real handler commits and prepares201, but
        // this owned socket publishes headers and loses its body. No issuer,
        // registration result, or mobile business logic is substituted.
        response.end = () => {
          response.flushHeaders();
          const timer = setTimeout(() => response.destroy(), 50);
          response.once('close', () => clearTimeout(timer));
          return response;
        };
      }
      void handleNativeAuthRegister(request, response, writer).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.headersTimeout = 9000;
    server.requestTimeout = 9000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned native server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    dropNetwork = false;
    dropResponseBody = false;
    __resetNativeAuthStateForTests();
    await db.delete(authEmailVerificationTokens);
    await db.delete(authEmailVerificationState);
    await db.delete(verificationTokens);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      await transaction.execute(
        sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(oldRole)}, ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens} TO ${sql.identifier(oldRole)}`,
      );
      await transaction.execute(
        sql`LOCK TABLE ${users}, ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens} IN ACCESS EXCLUSIVE MODE`,
      );
      await transaction.execute(
        sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens} FROM ${sql.identifier(oldRole)}`,
      );
      await transaction.execute(sql`GRANT SELECT, INSERT ON TABLE ${users} TO ${sql.identifier(writerRole)}`);
      await transaction.execute(sql`GRANT UPDATE (updated_at) ON TABLE ${users} TO ${sql.identifier(writerRole)}`);
      await transaction.execute(
        sql`GRANT INSERT ON TABLE ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, UPDATE ON TABLE ${authEmailProjection}, ${authSubjectCutoffs} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${authEmailReservations} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${authEmailReservationMembers} TO ${sql.identifier(writerRole)}`,
      );
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    vi.stubEnv('NEXTAUTH_SECRET', issuerSecret);
    vi.stubEnv('DEBUG_SQL', 'false');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    const failures: Error[] = [];
    try {
      if (server)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            reject(new Error('Owned native HTTP close deadline'));
          }, 3000);
          server!.close((error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
          server!.closeIdleConnections();
        });
    } catch {
      failures.push(new Error('Owned native HTTP cleanup failed'));
    }
    try {
      if (writerPool) await writerPool.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned native writer cleanup failed'));
    }
    for (const role of trackedRoles) {
      try {
        const present = await admin(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`);
        if (present[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned native role lookup cleanup failed'));
      }
      try {
        await admin(sql`REVOKE UPDATE (updated_at) ON TABLE ${users} FROM ${sql.identifier(role)}`);
        await admin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens}, ${authEmailProjection}, ${authSubjectCutoffs}, ${authEmailReservations}, ${authEmailReservationMembers} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned native table grants cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned native schema grants cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned native role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned mobile client fixture cleanup failed');
  });

  it('supports writer user KEY SHARE while identity-column changes and deletion remain denied', async () => {
    const probeId = randomUUID();
    const rollback = new Error('Owned mobile row-lock probe rollback');
    await expect(
      writer.transaction(async (transaction) => {
        await transaction.insert(users).values({ id: probeId, email: `${probeId}@mobile-lock-probe.example.test` });
        const [subject] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, probeId))
          .for('key share', { of: users });
        expect(subject?.id).toBe(probeId);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, probeId))).toEqual([]);
    await expect(writer.update(users).set({ id: randomUUID() }).where(eq(users.id, probeId))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(
      writer.update(users).set({ email: 'forbidden@mobile-lock-probe.example.test' }).where(eq(users.id, probeId)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(writer.delete(users).where(eq(users.id, probeId))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each(['false', 'true'])(
    'stores the real flat201 token pair and owner receipt when verification=%s',
    async (flag) => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', flag);
      const [actor] = await writer.execute(
        sql`SELECT current_user AS actor, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
      );
      expect(actor).toMatchObject({ actor: writerRole, superuser: false });
      const email = `  Mixed.${randomUUID()}+Tag@Example.TEST  `;
      const report = await mobileProbe(email);
      installedRequest(report);
      for (const proof of [
        report.success,
        report.observed201,
        report.flat,
        report.signatureValid,
        report.lifetimeValid,
        report.receiptMatches,
        report.storedPairMatches,
        report.writeOrder,
        report.newGeneration,
      ])
        expect(proof).toBe(true);
      const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
      expect(Boolean(user)).toBe(true);
      expect(user.name).toBe('Native Climber');
      expect(hash(user.id) === report.ownerHash).toBe(true);
      expect(hash(user.createdAt.toISOString()) === report.createdAtHash).toBe(true);
      expect(user.emailVerified === null).toBe(flag === 'true');
      const refresh = await db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, user.id));
      expect(refresh).toHaveLength(1);
      expect(refresh[0].tokenHash === report.refreshHash).toBe(true);
      expect((await db.select().from(authEmailReservations))[0].ownerUserId === user.id).toBe(true);
      expect(await db.select().from(verificationTokens)).toEqual([]);
      expect(await db.select().from(authEmailVerificationTokens)).toEqual([]);
    },
    22000,
  );
  it('preserves the seeded real-store pair and generation on a current occupied-key409', async () => {
    const email = `existing.${randomUUID()}@example.test`;
    const response = await fetch(`${origin}/auth/native/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8000),
    });
    expect(response.status).toBe(201);
    await response.arrayBuffer();
    const report = await mobileProbe(email);
    preserved(report);
    expect(report.failureStatus).toBe(409);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(mobileRefreshTokens)).toHaveLength(1);
  }, 22000);
  it('preserves both SecureStore namespaces and generation on unready-authority503', async () => {
    await db
      .update(authEmailProjection)
      .set({ phase: 'prepared' })
      .where(eq(authEmailProjection.projectionId, projectionId));
    const report = await mobileProbe(`unready.${randomUUID()}@example.test`);
    preserved(report);
    expect(report.failureStatus).toBe(503);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
  }, 22000);
  it('preserves seeded credentials on an actual loopback socket failure without retry', async () => {
    dropNetwork = true;
    const report = await mobileProbe(`offline.${randomUUID()}@example.test`);
    preserved(report);
    expect(report.failureStatus).toBeNull();
    expect(report.networkFailure).toBe(true);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
  }, 22000);
  it('keeps the installed old pair and generation after an actual validation400', async () => {
    const report = await mobileProbe('not-an-email');
    preserved(report);
    expect(report.failureStatus).toBe(400);
    expect(report.registrationThrew).toBe(false);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
  }, 22000);
  it('keeps the old pair on the real native limiter429', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${origin}/auth/native/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'invalid', password }),
        signal: AbortSignal.timeout(8000),
      });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    const report = await mobileProbe(`limited.${randomUUID()}@example.test`);
    preserved(report);
    expect(report.failureStatus).toBe(429);
    expect(report.registrationThrew).toBe(false);
    expect(await db.select().from(users)).toEqual([]);
  }, 22000);
  it('keeps the old pair on signing-secret503 and leaves no partial registration', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const report = await mobileProbe(`failed.${randomUUID()}@example.test`);
    preserved(report);
    expect(report.failureStatus).toBe(503);
    expect(report.registrationThrew).toBe(false);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
    expect(await db.select().from(authEmailReservations)).toEqual([]);
  }, 22000);
  it('characterizes a thrown201 body-read failure after commit without replacing old storage or retrying', async () => {
    dropResponseBody = true;
    const email = `lost.${randomUUID()}@example.test`;
    const report = await mobileProbe(email);
    preserved(report);
    expect(report.observed201).toBe(true);
    expect(report.registrationThrew).toBe(true);
    expect(report.networkFailure).toBe(false);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(mobileRefreshTokens)).toHaveLength(1);
    dropResponseBody = false;
    const retry = await mobileProbe(email);
    preserved(retry);
    expect(retry.failureStatus).toBe(409);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(mobileRefreshTokens)).toHaveLength(1);
  }, 22000);
});
