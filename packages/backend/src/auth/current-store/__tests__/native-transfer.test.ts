import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbInstance } from '@boardsesh/db/client';
import { authEmailProjection, users, verificationTokens, authSubjectCutoffs } from '@boardsesh/db/schema/auth';
import {
  nativeTransferCommandSchema,
  NATIVE_TRANSFER_COMMAND_PATH,
  type NativeTransferCommand,
} from '@boardsesh/auth-protocol/native-oauth-transfer';
import { getWorkerDatabaseUrl, setupWorkerDatabase } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { resetAllRateLimits } from '../../../utils/rate-limiter';
import { claimBrowserNativeTransfer } from '../native-transfer';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from '../foundation-context';
import { handleCurrentStoreNativeTransfer } from '../../../handlers/current-store-native-transfer';

const dependencies = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock('../../credential-database', () => ({ getCredentialDatabase: dependencies.database }));
const transferSecret = 'owned-browser-transfer-key-synthetic';
const rpcSecret = 'owned-private-browser-transfer-command-secret';
const role = `native_transfer_${randomBytes(8).toString('hex')}`;
const rolePassword = randomBytes(24).toString('hex');
const applicationName = `transfer-fixture-${randomBytes(6).toString('hex')}`;
let writerPool: ReturnType<typeof postgres>;
let writer: DbInstance;
let server: Server;
let origin: string;
let authority: ExpectedCurrentStoreAuthority;
const userId = randomUUID();
const releases: (() => Promise<void>)[] = [];

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function transfer(claims: Record<string, unknown> = {}) {
  const second = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ userId, nextPath: '/', iat: second, exp: second + 120, gen: 3, ...claims }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', transferSecret).update(payload).digest('base64url')}`;
}
function command(transferToken = transfer()): NativeTransferCommand {
  return nativeTransferCommandSchema.parse({
    nativeTransferProtocolVersion: 1,
    operation: 'claim',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { transferToken },
  });
}
/** Independent frozen old writer recipe: never derive the control marker through the new codec. */
function oldMarker(token: string) {
  const encodedPayload = token.split('.')[0];
  const { exp } = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as { exp: number };
  const digest = createHash('sha256').update(`native-oauth-transfer-v1\0${encodedPayload}`).digest('hex');
  return { identifier: `ba03-web-auth:${digest}`, token: digest, expires: new Date((exp + 5 + 300) * 1000) };
}
async function oldClaim(token: string) {
  return db
    .insert(verificationTokens)
    .values(oldMarker(token))
    .onConflictDoNothing()
    .returning({ token: verificationTokens.token });
}
async function rows(token: string) {
  return db
    .select()
    .from(verificationTokens)
    .where(eq(verificationTokens.identifier, oldMarker(token).identifier));
}
async function post(body: unknown, options: { authorization?: string; origin?: string; path?: string } = {}) {
  return fetch(`${origin}${options.path ?? NATIVE_TRANSFER_COMMAND_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: options.authorization ?? `Bearer ${rpcSecret}`,
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function pauseUser() {
  const locked = deferred();
  const release = deferred();
  const pending = db.transaction(async (transaction) => {
    await transaction.select().from(users).where(eq(users.id, userId)).for('update');
    locked.resolve();
    await release.promise;
  });
  const finish = async () => {
    release.resolve();
    await pending;
  };
  releases.push(finish);
  await locked.promise;
  return finish;
}
async function observeWriterLock() {
  await vi.waitFor(
    async () => {
      const result = await db.execute<{ waiting: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = ${applicationName} AND wait_event_type = 'Lock') AS waiting`,
      );
      expect(result[0]?.waiting).toBe(true);
    },
    { interval: 5, timeout: 200 },
  );
}

beforeAll(async () => {
  await setupWorkerDatabase();
  const connection = new URL(getWorkerDatabaseUrl());
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
    !connection.pathname.startsWith('/boardsesh_backend_test_w')
  )
    throw new Error('Transfer fixture requires its owned local worker database');
  await db.execute(
    sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
  );
  await db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
  await db.execute(sql`GRANT SELECT, UPDATE ON TABLE ${users} TO ${sql.identifier(role)}`);
  await db.execute(sql`GRANT SELECT ON TABLE ${authEmailProjection} TO ${sql.identifier(role)}`);
  await db.execute(sql`GRANT SELECT, INSERT ON TABLE ${verificationTokens} TO ${sql.identifier(role)}`);
  connection.username = role;
  connection.password = rolePassword;
  writerPool = postgres(connection.toString(), {
    max: 2,
    onnotice: () => {},
    connection: { application_name: applicationName },
  });
  writer = drizzle(writerPool);
  server = createServer((request, response) => {
    void handleCurrentStoreNativeTransfer(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Transfer fixture listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetAllRateLimits();
  dependencies.database.mockReset();
  dependencies.database.mockResolvedValue(writer);
  vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  await db.delete(verificationTokens);
  await db.delete(authEmailProjection);
  await db.delete(authSubjectCutoffs);
  await db.delete(users);
  const projectionId = randomUUID();
  authority = {
    expectedProjectionId: projectionId,
    expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    expectedWriterEpoch: 1,
  };
  await db.insert(users).values({ id: userId, email: 'transfer-fixture@example.test', name: 'Original climber' });
  await db.insert(authEmailProjection).values({
    projectionId,
    normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    phase: 'enforced',
    writerEpoch: 1,
    preparedAt: new Date(),
  });
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
  vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'legacy');
  vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
  vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-transfer-deleted-email-key-at-least-32-bytes');
  vi.stubEnv('NEXTAUTH_SECRET', transferSecret);
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await writerPool?.end({ timeout: 3 });
  await db.execute(sql`DROP OWNED BY ${sql.identifier(role)}`);
  await db.execute(sql`DROP ROLE ${sql.identifier(role)}`);
});

describe('restricted browser native-transfer command', () => {
  it.each(['current-store', 'better-auth'] as const)(
    'claims through the actual LOGIN under %s without changing source proof',
    async (writerAuthority) => {
      await db.update(authEmailProjection).set({ writerAuthority });
      await db
        .insert(authSubjectCutoffs)
        .values({ userId, generation: 9, revokedThrough: new Date(), lastOperationId: randomUUID() });
      const source = {
        authSessionId: 'original-source-sid',
        auth_time: Math.floor(Date.now() / 1000) - 3600,
        link_guarded: true,
        legacy_no_sid: true,
      };
      const token = transfer(source);
      const response = await post(command(token));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        outcome: 'claimed',
        sourceGeneration: 3,
        user: { id: userId },
        credentialProof: {
          authSessionId: source.authSessionId,
          generation: 3,
          authenticatedAt: new Date(source.auth_time * 1000).toISOString(),
          linkGuarded: true,
          requiresAccountCutoff: true,
        },
      });
      expect(dependencies.database).toHaveBeenCalledWith('private-web-v1');
      expect(await writerPool`SELECT current_user, session_user`).toMatchObject([
        { current_user: role, session_user: role },
      ]);
      expect(await rows(token)).toEqual([oldMarker(token)]);
      expect((await post(command(token))).status).toBe(401);
      expect(await oldClaim(token)).toEqual([]); // A reverted web version sees the same spend.
      await expect(
        writer.insert(users).values({ id: randomUUID(), email: 'forbidden@example.test' }),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(writer.delete(verificationTokens)).rejects.toMatchObject({ cause: { code: '42501' } });
    },
  );
  it('preserves generation-only transfers without creating a fresh proof', async () => {
    const response = await post(command());
    expect(response.status).toBe(200);
    const reply = await response.json();
    expect(reply).toMatchObject({ sourceGeneration: 3 });
    expect(reply).not.toHaveProperty('credentialProof');
  });
  it('rejects an old-writer spend and leaves its original expiry unchanged', async () => {
    const token = transfer();
    expect(await oldClaim(token)).toHaveLength(1);
    expect((await post(command(token))).status).toBe(401);
    expect(await rows(token)).toEqual([oldMarker(token)]);
  });
  it('observes the old-first unique-key race and admits exactly its winner', async () => {
    const token = transfer();
    const inserted = deferred();
    const release = deferred();
    const old = db.transaction(async (transaction) => {
      const result = await transaction
        .insert(verificationTokens)
        .values(oldMarker(token))
        .onConflictDoNothing()
        .returning({ token: verificationTokens.token });
      inserted.resolve();
      await release.promise;
      return result;
    });
    releases.push(async () => {
      release.resolve();
      await old;
    });
    await inserted.promise;
    const next = claimBrowserNativeTransfer(writer, authority, command(token), transferSecret);
    await observeWriterLock();
    release.resolve();
    expect(await old).toHaveLength(1);
    expect((await next).outcome).toBe('denied');
    expect(await rows(token)).toEqual([oldMarker(token)]);
  });
  it('observes the backend-first unique-key race and admits exactly its winner', async () => {
    const token = transfer();
    const inserted = deferred();
    const release = deferred();
    const held = Object.create(writer) as DbInstance;
    held.transaction = async <Result>(work: (transaction: CurrentStoreTransaction) => Promise<Result>) =>
      writer.transaction(async (transaction) => {
        const result = await work(transaction);
        inserted.resolve();
        await release.promise;
        return result;
      });
    const next = claimBrowserNativeTransfer(held, authority, command(token), transferSecret);
    releases.push(async () => {
      release.resolve();
      await next;
    });
    await inserted.promise;
    let oldFinished = false;
    const old = oldClaim(token).then((result) => {
      oldFinished = true;
      return result;
    });
    await vi.waitFor(
      async () => {
        const result = await db.execute<{ waiting: boolean }>(
          sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%verificationTokens%') AS waiting`,
        );
        expect(result[0]?.waiting).toBe(true);
      },
      { interval: 5, timeout: 500 },
    );
    expect(oldFinished).toBe(false);
    release.resolve();
    expect((await next).outcome).toBe('claimed');
    expect(await old).toEqual([]);
    expect(await rows(token)).toEqual([oldMarker(token)]);
  });
  it('rolls back a claim on failure and keeps a committed lost reply terminal', async () => {
    const token = transfer();
    const failing = Object.create(writer) as DbInstance;
    failing.transaction = async <Result>(work: (transaction: CurrentStoreTransaction) => Promise<Result>) =>
      writer.transaction(async (transaction): Promise<Result> => {
        await work(transaction);
        throw new Error('Synthetic failure before commit');
      });
    await expect(claimBrowserNativeTransfer(failing, authority, command(token), transferSecret)).rejects.toThrow(
      'Synthetic failure',
    );
    expect(await rows(token)).toEqual([]);
    const lost = Object.create(writer) as DbInstance;
    lost.transaction = async <Result>(
      work: (transaction: CurrentStoreTransaction) => Promise<Result>,
    ): Promise<Result> => {
      await writer.transaction(work);
      throw new Error('Synthetic lost committed reply');
    };
    await expect(claimBrowserNativeTransfer(lost, authority, command(token), transferSecret)).rejects.toThrow(
      'Synthetic lost',
    );
    expect((await claimBrowserNativeTransfer(writer, authority, command(token), transferSecret)).outcome).toBe(
      'denied',
    );
    expect(await oldClaim(token)).toEqual([]);
  });
  it('does not extend transfer expiry while waiting for the user row', async () => {
    const issuedAt = Date.now();
    const token = transfer();
    const release = await pauseUser();
    const pending = claimBrowserNativeTransfer(writer, authority, command(token), transferSecret);
    await observeWriterLock();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(issuedAt + 126_000);
    await release();
    expect((await pending).outcome).toBe('denied');
    expect(await rows(token)).toEqual([]);
  });
  it.each([
    ['bad service secret', { authorization: 'Bearer wrong' }, 401],
    ['browser origin', { origin: 'https://www.boardsesh.test' }, 401],
    ['query variant', { path: `${NATIVE_TRANSFER_COMMAND_PATH}?unexpected=1` }, 400],
  ])('rejects %s before opening the credential database', async (_label, options, status) => {
    expect((await post(command(), options)).status).toBe(status);
    expect(dependencies.database).not.toHaveBeenCalled();
  });
  it.each(['legacy', 'better-auth'])(
    'keeps the command disabled when selected web/browser mode is %s',
    async (mode) => {
      if (mode === 'legacy') vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
      else vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
      expect((await post(command())).status).toBe(404);
      expect(dependencies.database).not.toHaveBeenCalled();
    },
  );
  it.each(['invalid-signature', 'expired-signed-token'])(
    'rejects %s before opening the credential pool',
    async (kind) => {
      dependencies.database.mockRejectedValue(new Error('A rejected token must never reach the pool'));
      const second = Math.floor(Date.now() / 1000);
      const token = kind === 'invalid-signature' ? `${transfer()}x` : transfer({ iat: second - 126, exp: second - 6 });
      const response = await post(command(token));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ outcome: 'denied' });
      expect(dependencies.database).not.toHaveBeenCalled();
      expect(await rows(token)).toEqual([]);
    },
  );
  it('rejects wrong/expired envelopes before the database and makes backend failure unavailable', async () => {
    expect((await post({ ...command(), extra: true })).status).toBe(400);
    expect((await post({ ...command(), issuedAt: Date.now() - 121_000 })).status).toBe(400);
    expect(dependencies.database).not.toHaveBeenCalled();
    dependencies.database.mockRejectedValueOnce(new Error('SQL with a private transfer token'));
    const unavailable = await post(command());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private transfer token');
  });
});
