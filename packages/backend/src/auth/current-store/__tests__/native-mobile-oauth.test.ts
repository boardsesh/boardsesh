import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
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
  accounts,
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
import { createNativeOAuthProviderFixture } from './fixtures/native-oauth-provider-fixture';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';

const roleSalt = randomUUID().replaceAll('-', '');
const writerRole = `ba03_mobile_oauth_${roleSalt}`;
const oldRole = `ba03_old_oauth_${roleSalt}`;
const rolePassword = randomBytes(32).toString('hex');
const issuerSecret = randomBytes(32).toString('hex');
const trackedRoles: string[] = [];
const sockets = new Set<Socket>();
const activeHandlers = new Set<Promise<void>>();
const googleAudience = 'owned-mobile-oauth-google';
const appleAudience = 'com.boardsesh.test.mobile.oauth';
let providers: Awaited<ReturnType<typeof createNativeOAuthProviderFixture>>;
let restoreProviderFetch: (() => void) | undefined;
let oauthHandler: (request: IncomingMessage, response: ServerResponse, database: DbInstance) => Promise<void>;
let resetNative: () => void;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let writerPool: ReturnType<typeof postgres> | undefined;
let writer: DbInstance;
let server: Server | undefined;
let origin: string;
let projectionId: string;
let dropNetwork = false;
let acceptingRequests = true;

type MobileProbe = {
  ok: boolean;
  registrationThrew: boolean;
  success: boolean;
  failureStatus: number | null;
  networkFailure: boolean;
  observed200: boolean;
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
async function mobileProbe(
  provider: 'apple' | 'google',
  identityToken: string,
  options: { nonce?: string; expectedCreated?: boolean; name?: { firstName?: string; lastName?: string } } = {},
): Promise<MobileProbe> {
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
    child.send({
      origin,
      operation: 'oauth',
      provider,
      identityToken,
      ...options,
      issuerVerificationSecret: issuerSecret,
    });
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

async function identity(
  provider: 'google' | 'apple',
  options: { subject?: string; email?: string | null; emailVerified?: boolean; wrongKey?: boolean } = {},
) {
  const subject = options.subject ?? `owned-mobile-${randomUUID()}`;
  const email = options.email === undefined ? `Mixed.${randomUUID()}+Tag@Example.TEST` : options.email;
  const nonce = provider === 'apple' ? randomBytes(16).toString('hex') : undefined;
  const token = await providers.sign(
    provider,
    {
      sub: subject,
      ...(email === null ? {} : { email }),
      email_verified: options.emailVerified ?? true,
      name: 'Signed provider name',
      ...(nonce === undefined ? {} : { nonce: hash(nonce) }),
    },
    { wrongKey: options.wrongKey },
  );
  return { provider, subject, email, token, nonce };
}
async function seedThroughHttp(issued: Awaited<ReturnType<typeof identity>>) {
  const response = await fetch(`${origin}/auth/native/oauth`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: issued.provider,
      identityToken: issued.token,
      ...(issued.nonce === undefined ? {} : { nonce: issued.nonce }),
    }),
    signal: AbortSignal.timeout(8000),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

describe('actual mobile OAuth client and auth-store through owned provider verification and public HTTP', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    vi.stubEnv('APPLE_BUNDLE_ID', appleAudience);
    const handlers = await import('../../../handlers/native-auth');
    oauthHandler = handlers.handleNativeAuthOAuth;
    resetNative = handlers.__resetNativeAuthStateForTests;
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
      if (!acceptingRequests || dropNetwork) {
        request.socket.destroy();
        return;
      }
      if (request.url !== '/auth/native/oauth') {
        response.writeHead(404);
        response.end();
        return;
      }
      const handler = oauthHandler(request, response, writer).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      activeHandlers.add(handler);
      void handler.then(
        () => activeHandlers.delete(handler),
        () => activeHandlers.delete(handler),
      );
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
    providers = await createNativeOAuthProviderFixture({ googleAudience, appleAudience });
    restoreProviderFetch = providers.installFetch([origin]);
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    dropNetwork = false;
    resetNative();
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
        sql`GRANT SELECT, INSERT ON TABLE ${users}, ${accounts}, ${userProfiles}, ${mobileRefreshTokens} TO ${sql.identifier(oldRole)}`,
      );
      await transaction.execute(
        sql`LOCK TABLE ${users}, ${accounts}, ${userProfiles}, ${mobileRefreshTokens} IN ACCESS EXCLUSIVE MODE`,
      );
      await transaction.execute(
        sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userProfiles}, ${mobileRefreshTokens} FROM ${sql.identifier(oldRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${users}, ${accounts} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT INSERT ON TABLE ${userProfiles}, ${mobileRefreshTokens} TO ${sql.identifier(writerRole)}`,
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
    vi.stubEnv('CURRENT_STORE_NATIVE_OAUTH_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'legacy');
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', googleAudience);
    vi.stubEnv('GOOGLE_IOS_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_ANDROID_CLIENT_ID', '');
    vi.stubEnv('APPLE_BUNDLE_ID', appleAudience);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    vi.stubEnv('NEXTAUTH_SECRET', issuerSecret);
    vi.stubEnv('DEBUG_SQL', 'false');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
  });
  afterAll(async () => {
    acceptingRequests = false;
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
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let handlersStopped = false;
    try {
      await Promise.race([
        Promise.allSettled(activeHandlers),
        new Promise<never>((_resolve, reject) => {
          drainTimer = setTimeout(() => reject(new Error('Owned native handler drain deadline')), 5000);
        }),
      ]);
      handlersStopped = activeHandlers.size === 0;
      if (!handlersStopped) throw new Error('Owned native handlers remain active');
    } catch {
      failures.push(new Error('Owned native handler cleanup failed'));
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
    for (const role of trackedRoles) {
      try {
        const present = await admin(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`);
        if (present[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned native role lookup cleanup failed'));
      }
      try {
        await admin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userProfiles}, ${mobileRefreshTokens}, ${authEmailProjection}, ${authSubjectCutoffs}, ${authEmailReservations}, ${authEmailReservationMembers} FROM ${sql.identifier(role)}`,
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
    // A late preflight must never resume into real provider HTTP after teardown.
    // On incomplete cleanup, retain both guards until the isolated worker exits.
    if (handlersStopped && !server?.listening) {
      restoreProviderFetch?.();
      vi.unstubAllEnvs();
    }
    if (failures.length) throw new AggregateError(failures, 'Owned mobile client fixture cleanup failed');
  });

  it.each(['google', 'apple'] as const)(
    'runs real mobile %s verification, flat200 storage and provider-specific receipt',
    async (provider) => {
      const [actor] = await writer.execute(
        sql`SELECT current_user AS actor, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
      );
      expect(actor).toMatchObject({ actor: writerRole, superuser: false });
      const emailVerified = provider === 'apple';
      const issued = await identity(provider, { emailVerified });
      const report = await mobileProbe(provider, issued.token, {
        nonce: issued.nonce,
        name: { firstName: 'Forwarded', lastName: 'Climber' },
      });
      installedRequest(report);
      for (const proof of [
        report.success,
        report.observed200,
        report.flat,
        report.signatureValid,
        report.lifetimeValid,
        report.receiptMatches,
        report.storedPairMatches,
        report.writeOrder,
        report.newGeneration,
      ])
        expect(proof).toBe(true);
      const [user] = await db.select().from(users);
      expect(Boolean(user)).toBe(true);
      expect(user.email).toBe(issued.email!.toLowerCase());
      expect(user.emailVerified !== null).toBe(emailVerified);
      expect(user.name).toBe('Forwarded Climber');
      expect(hash(user.id) === report.ownerHash).toBe(true);
      expect(hash(user.createdAt.toISOString()) === report.createdAtHash).toBe(true);
      const storedRefresh = await db.select().from(mobileRefreshTokens);
      expect(storedRefresh).toHaveLength(1);
      expect(storedRefresh[0].userId === user.id && storedRefresh[0].tokenHash === report.refreshHash).toBe(true);
      const linked = await db.select().from(accounts);
      expect(linked).toHaveLength(1);
      expect(
        linked[0].provider === provider &&
          linked[0].providerAccountId === issued.subject &&
          linked[0].userId === user.id,
      ).toBe(true);
      expect(await db.select().from(userCredentials)).toEqual([]);
      expect(await db.select().from(verificationTokens)).toEqual([]);
      expect(await db.select().from(authEmailVerificationTokens)).toEqual([]);
      expect(providers.counters.blocked).toBe(0);
    },
    22000,
  );

  it.each(['google', 'apple'] as const)(
    'keeps the original %s owner/creation receipt when the provider returns changed or omitted email',
    async (provider) => {
      const first = await identity(provider);
      await seedThroughHttp(first);
      const [before] = await db.select().from(users);
      const repeated = await identity(provider, {
        subject: first.subject,
        email: provider === 'apple' ? null : 'Changed@example.test',
        emailVerified: false,
      });
      const report = await mobileProbe(provider, repeated.token, {
        nonce: repeated.nonce,
        expectedCreated: false,
        name: { firstName: 'Changed', lastName: 'Name' },
      });
      installedRequest(report);
      expect(report.success).toBe(true);
      expect(report.receiptMatches).toBe(true);
      expect(report.storedPairMatches).toBe(true);
      expect(hash(before.id) === report.ownerHash).toBe(true);
      expect(hash(before.createdAt.toISOString()) === report.createdAtHash).toBe(true);
      const [after] = await db.select().from(users);
      expect(after).toEqual(before);
      expect(await db.select().from(accounts)).toHaveLength(1);
      expect(await db.select().from(mobileRefreshTokens)).toHaveLength(2);
    },
    22000,
  );

  it.each(['google', 'apple'] as const)(
    'keeps the real old pair/generation on a verified-email %s conflict409',
    async (provider) => {
      const first = await identity(provider);
      await seedThroughHttp(first);
      const [before] = await db.select().from(users);
      const conflicting = await identity(provider, {
        email: `  ${first.email!.toUpperCase()}\u00a0`,
        emailVerified: true,
      });
      const report = await mobileProbe(provider, conflicting.token, { nonce: conflicting.nonce });
      preserved(report);
      expect(report.failureStatus).toBe(409);
      expect(report.registrationThrew).toBe(false);
      expect(await db.select().from(users)).toEqual([before]);
      expect(await db.select().from(accounts)).toHaveLength(1);
      expect(await db.select().from(mobileRefreshTokens)).toHaveLength(1);
    },
    22000,
  );

  it.each(['google', 'apple'] as const)(
    'keeps old credentials when actual JOSE rejects a known-key bad %s signature401',
    async (provider) => {
      const issued = await identity(provider, { wrongKey: true });
      const report = await mobileProbe(provider, issued.token, { nonce: issued.nonce });
      preserved(report);
      expect(report.failureStatus).toBe(401);
      expect(report.registrationThrew).toBe(false);
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
    },
    22000,
  );

  it.each(['google', 'apple'] as const)(
    'keeps old credentials and avoids provider I/O for unready %s authority503',
    async (provider) => {
      await db
        .update(authEmailProjection)
        .set({ phase: 'prepared' })
        .where(eq(authEmailProjection.projectionId, projectionId));
      const initialFetches = providers.counters[provider];
      const issued = await identity(provider);
      const report = await mobileProbe(provider, issued.token, { nonce: issued.nonce });
      preserved(report);
      expect(report.failureStatus).toBe(503);
      expect(providers.counters[provider]).toBe(initialFetches);
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
    },
    22000,
  );

  it('preserves both old namespaces on an actual native OAuth socket failure without retry', async () => {
    const issued = await identity('google');
    dropNetwork = true;
    const report = await mobileProbe('google', issued.token);
    preserved(report);
    expect(report.failureStatus).toBeNull();
    expect(report.networkFailure).toBe(true);
    expect(report.registrationThrew).toBe(false);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(mobileRefreshTokens)).toEqual([]);
  }, 22000);
});
