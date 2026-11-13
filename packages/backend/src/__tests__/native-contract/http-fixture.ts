import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { schemaSQL } from '../schema-sql';

type NativeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** Refuse ambient application URLs; own a brand-new synthetic database per run. */
export async function createNativeHttpFixture() {
  const rawAdminUrl = process.env.NATIVE_CONTRACT_DATABASE_URL;
  const rawRedisUrl = process.env.NATIVE_CONTRACT_REDIS_URL;
  if (!rawAdminUrl || !rawRedisUrl) throw new Error('Explicit isolated native-contract fixture URLs required');
  const adminUrl = new URL(rawAdminUrl);
  const redisUrl = new URL(rawRedisUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(adminUrl.hostname) ||
    !['127.0.0.1', 'localhost'].includes(redisUrl.hostname)
  ) {
    throw new Error('Native-contract fixtures must be loopback synthetic services');
  }
  const databaseName = `native_contract_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  const cleanups: (() => Promise<void>)[] = [
    async () => {
      await admin.end();
    },
  ];
  const pending = new Set<Promise<void>>();
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled(pending);
    const errors: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned native-contract fixture cleanup failed');
  }
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    // Register deletion only AFTER this invocation successfully created the DB.
    // No discovery, prefix cleanup, reset, force-drop or shared DB is allowed.
    cleanups.push(async () => {
      await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    });
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.READ_REPLICA_URL = '';
    process.env.REDIS_URL = redisUrl.toString();
    process.env.NEXTAUTH_SECRET = 'native-contract-only-synthetic-signing-key';
    process.env.CURRENT_STORE_NATIVE_REGISTRATION_MODE = '';
    process.env.CURRENT_STORE_NATIVE_OAUTH_MODE = '';
    const connection = postgres(databaseUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
    cleanups.push(async () => {
      await connection.end();
    });
    await connection.unsafe(schemaSQL);
    const { closePool, closeReadPool } = await import('@boardsesh/db/client');
    cleanups.push(closePool, closeReadPool);
    const { closeAdmissionPool } = await import('../../auth/admission-pool');
    cleanups.push(closeAdmissionPool);
    const native = await import('../../handlers/native-auth');
    const { db } = await import('../../db/client');
    const { redisClientManager } = await import('../../redis/client');
    cleanups.push(async () => {
      await redisClientManager.disconnect();
    });
    await redisClientManager.connect();
    const handlers: Record<string, NativeHandler> = {
      '/auth/native/credentials': native.handleNativeAuthCredentials,
      '/auth/native/register': native.handleNativeAuthRegister,
      '/auth/native/oauth': native.handleNativeAuthOAuth,
      '/auth/native/exchange': native.handleNativeAuthExchange,
      '/auth/native/refresh': native.handleNativeAuthRefresh,
      '/auth/native/revoke': native.handleNativeAuthRevoke,
      '/api/watch/pair-code': native.handleWatchPairCode,
      '/api/watch/pair': native.handleWatchPair,
    };
    const server = createServer((request, response) => {
      const handler = handlers[new URL(request.url ?? '/', 'http://localhost').pathname];
      if (!handler) {
        response.writeHead(404).end();
        return;
      }
      const operation = handler(request, response);
      pending.add(operation);
      void operation
        .catch(() => {
          if (!response.headersSent) response.writeHead(500).end();
        })
        .finally(() => pending.delete(operation));
    });
    cleanups.push(async () => {
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Native-contract HTTP listener unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const requests: { path: string; method: string; body: unknown; authorization: string | null }[] = [];
    const network: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return fetch(`${origin}${url.pathname}${url.search}`, { ...init, signal: AbortSignal.timeout(7000) });
    };
    return {
      db,
      connection,
      native,
      redis: redisClientManager,
      origin,
      requests,
      network,
      ownership: { databaseName, postgresHost: adminUrl.host, createdFreshByThisInvocation: true as const },
      async post(path: string, body: unknown, bearer?: string) {
        return network(`${origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
          body: JSON.stringify(body),
        });
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native-contract fixture startup and cleanup failed');
    }
    throw error;
  }
}
