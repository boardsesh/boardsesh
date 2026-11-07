import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority } from './authority';
import { createPrototypeNativeFacade, PrototypeNativeCredentialError } from './identity-native-facade';
import { createPrototypeLegacyHandler } from './legacy-bridge';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { validateProcessFixtureDatabaseUrl } from './process-fixture';

export const PROTOTYPE_TRANSPORT_KEY = new TextEncoder().encode('boardsesh-disposable-transport-signing-key-6975');
export const PROTOTYPE_TRANSPORT_RECEIPT_PREFIX = 'prototype-transport-receipt:';

interface TransportIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export interface PrototypeTransportHooks {
  /** Test-owned ordering barriers; no request field selects these hooks. */
  readonly afterAuthorized?: (operationId: string) => Promise<void>;
  readonly afterReceiptWritten?: (operationId: string) => Promise<void>;
  readonly afterCommitted?: (operationId: string) => Promise<void>;
  readonly onLifecycleRequest?: (path: string) => void;
}

export interface PrototypeTransportFixture {
  readonly origin: string;
  readonly websocketUrl: string;
  readonly closeDatabase: () => Promise<void>;
  readonly close: () => Promise<void>;
}

type OperationResult = {
  status: 200 | 401 | 503;
  body: Record<string, string | number>;
};

function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function record(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function bearer(headers: IncomingMessage['headers']): string | null {
  const authorization = headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
}

function operationId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && /^[0-9a-f-]{36}$/.test(candidate);
}

function json(outgoing: ServerResponse, status: number, body: unknown): void {
  outgoing.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  outgoing.end(JSON.stringify(body));
}

async function requestBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > 8192) throw new Error('Oversized disposable transport request.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Real loopback sockets and independent pools, never a product router. Protected
 * operations participate in the same transaction fence as the prototype's
 * credential mutations; a startup-authenticated socket is not an auth cache.
 */
export async function startPrototypeTransportFixture(
  databaseUrl: string,
  hooks: PrototypeTransportHooks = {},
): Promise<PrototypeTransportFixture> {
  const client = postgres(validateProcessFixtureDatabaseUrl(databaseUrl), {
    max: 4,
    connect_timeout: 5,
    connection: { application_name: 'boardsesh-disposable-auth-transport', statement_timeout: 10000 },
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });
  const native = createPrototypeNativeFacade(database, PROTOTYPE_TRANSPORT_KEY);
  const legacy = createPrototypeLegacyHandler(database);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  let databaseClose: Promise<void> | undefined;
  let fixtureClose: Promise<void> | undefined;
  let closed = false;

  async function perform(token: string, id: string): Promise<OperationResult> {
    try {
      const result = await database.transaction(async (transaction): Promise<OperationResult> => {
        await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
        const authority = createPrototypeNativeFacade(transaction, PROTOTYPE_TRANSPORT_KEY);
        const identity = await authority.validateAccessToken(token);
        if (!identity) return { status: 401, body: { type: 'error', id, code: 'UNAUTHORIZED' } };
        await hooks.afterAuthorized?.(id);
        const receiptId = `${PROTOTYPE_TRANSPORT_RECEIPT_PREFIX}${randomUUID()}`;
        await transaction.insert(schema.verification).values({
          id: receiptId,
          identifier: receiptId,
          value: JSON.stringify({ type: 'prototype-transport-receipt', operationId: id, ...identity }),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        await hooks.afterReceiptWritten?.(id);
        return { status: 200, body: { type: 'result', id, receiptId, ...identity } };
      });
      // Network delivery cannot be atomic with the database commit. The test
      // uses this separate barrier to demonstrate the precise in-flight limit.
      if (result.status === 200) await hooks.afterCommitted?.(id);
      return result;
    } catch {
      // A read/transaction outage is unavailable, never confirmed bad credentials.
      return { status: 503, body: { type: 'error', id, code: 'UNAVAILABLE' } };
    }
  }

  function send(socket: WebSocket, body: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
  }

  function rejectSocket(
    socket: WebSocket,
    code: 'UNAUTHORIZED' | 'UNAVAILABLE' | 'INVALID_MESSAGE',
    id?: string,
  ): void {
    send(socket, { type: 'error', ...(id ? { id } : {}), code });
    const closeCode = code === 'UNAUTHORIZED' ? 4401 : code === 'UNAVAILABLE' ? 1013 : 4400;
    socket.close(closeCode, code);
  }

  function attachSocket(socket: WebSocket): void {
    let token: string | null = null;
    let boundIdentity: TransportIdentity | null = null;
    let pending = Promise.resolve();
    async function message(bytes: RawData): Promise<void> {
      if (socket.readyState !== WebSocket.OPEN) return;
      let body: unknown;
      try {
        const buffer = Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : Buffer.isBuffer(bytes)
            ? bytes
            : Buffer.from(bytes);
        body = JSON.parse(buffer.toString('utf8'));
      } catch {
        rejectSocket(socket, 'INVALID_MESSAGE');
        return;
      }
      if (!record(body)) {
        rejectSocket(socket, 'INVALID_MESSAGE');
        return;
      }
      if (body.type === 'authenticate' && token === null && typeof body.token === 'string') {
        try {
          const identity = await native.validateAccessToken(body.token);
          if (!identity) {
            rejectSocket(socket, 'UNAUTHORIZED');
            return;
          }
          token = body.token;
          boundIdentity = identity;
          send(socket, { type: 'connected', ...identity });
        } catch {
          rejectSocket(socket, 'UNAVAILABLE');
        }
        return;
      }
      if (body.type !== 'command' || !operationId(body.id)) {
        rejectSocket(socket, 'INVALID_MESSAGE');
        return;
      }
      if (token === null || boundIdentity === null) {
        rejectSocket(socket, 'UNAUTHORIZED', body.id);
        return;
      }
      const result = await perform(token, body.id);
      if (result.status === 200) {
        // The request cannot substitute a new owner or a new token after init.
        if (result.body.userId !== boundIdentity.userId || result.body.sessionId !== boundIdentity.sessionId) {
          rejectSocket(socket, 'UNAUTHORIZED', body.id);
          return;
        }
        send(socket, result.body);
      } else {
        rejectSocket(socket, result.status === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE', body.id);
      }
    }
    socket.on('message', (bytes) => {
      pending = pending.then(() => message(bytes)).catch(() => rejectSocket(socket, 'UNAVAILABLE'));
    });
    // A peer disappearing during an operation does not turn the operation into
    // another person's request. Avoid an unhandled transport error during close.
    socket.on('error', () => {});
  }

  const server = createServer(async (incoming, outgoing) => {
    outgoing.on('error', () => {});
    try {
      const requestUrl = new URL(incoming.url ?? '/', PROTOTYPE_ISSUER);
      if (requestUrl.pathname === '/__fixture/ready') {
        json(outgoing, 200, { ready: true });
        return;
      }
      const raw = ['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? '' : await requestBody(incoming);
      if (requestUrl.pathname.startsWith('/api/auth/')) {
        hooks.onLifecycleRequest?.(requestUrl.pathname);
        const headers = new Headers();
        for (const [name, content] of Object.entries(incoming.headers)) {
          if (typeof content === 'string') headers.set(name, content);
          else if (content) for (const part of content) headers.append(name, part);
        }
        const response = await legacy(
          new Request(requestUrl, {
            method: incoming.method,
            headers,
            ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: raw }),
          }),
        );
        for (const [name, content] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, content);
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies);
        outgoing.writeHead(response.status);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (incoming.method !== 'POST') {
        json(outgoing, 405, { code: 'METHOD_NOT_ALLOWED' });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        json(outgoing, 400, { code: 'INVALID_REQUEST' });
        return;
      }
      if (!record(body)) {
        json(outgoing, 400, { code: 'INVALID_REQUEST' });
        return;
      }
      if (
        requestUrl.pathname === '/__fixture/sign-in' &&
        typeof body.email === 'string' &&
        typeof body.password === 'string'
      ) {
        json(outgoing, 200, await native.credentials(body.email, body.password));
        return;
      }
      if (requestUrl.pathname === '/__fixture/revoke' && typeof body.refreshToken === 'string') {
        await native.revoke(body.refreshToken);
        json(outgoing, 200, { revoked: true });
        return;
      }
      if (requestUrl.pathname === '/protected/operation' && operationId(body.id)) {
        const token = bearer(incoming.headers);
        if (!token) {
          json(outgoing, 401, { type: 'error', id: body.id, code: 'UNAUTHORIZED' });
          return;
        }
        const result = await perform(token, body.id);
        json(outgoing, result.status, result.body);
        return;
      }
      json(outgoing, 404, { code: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof PrototypeNativeCredentialError) json(outgoing, 401, { code: 'UNAUTHORIZED' });
      else json(outgoing, 503, { code: 'UNAVAILABLE' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('upgrade', (incoming, socket, head) => {
    try {
      const requestUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      if (closed || requestUrl.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(incoming, socket, head, attachSocket);
    } catch {
      socket.destroy();
    }
  });

  function closeDatabase(): Promise<void> {
    databaseClose ??= client.end({ timeout: 2 });
    return databaseClose;
  }

  function close(): Promise<void> {
    if (fixtureClose) return fixtureClose;
    closed = true;
    for (const socket of sockets.clients) socket.terminate();
    const closeSockets = new Promise<void>((resolve) => sockets.close(() => resolve()));
    const closeHttp = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    fixtureClose = bounded(
      Promise.all([closeSockets, closeHttp, closeDatabase()]).then(() => {}),
      5000,
      'The disposable transport fixture did not close within 5 seconds.',
    );
    return fixtureClose;
  }

  try {
    await bounded(
      createPrototypeAuthority(database).$context,
      10000,
      'The disposable transport authority did not initialize within 10 seconds.',
    );
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }),
      5000,
      'The disposable transport listener did not start within 5 seconds.',
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The auth transport fixture has no loopback port.');
    return {
      origin: `http://127.0.0.1:${address.port}`,
      websocketUrl: `ws://127.0.0.1:${address.port}/ws`,
      closeDatabase,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
