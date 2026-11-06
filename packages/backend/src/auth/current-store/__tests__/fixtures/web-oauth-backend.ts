import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { DbInstance } from '@boardsesh/db/client';
import { handleCurrentStoreWebOAuth } from '../../../../handlers/current-store-web-oauth';

async function bounded<Result>(pending: Promise<Result>, milliseconds = 8000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_accept, reject) => {
        timer = setTimeout(() => reject(new Error('Owned web OAuth backend deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Owned test transport only. The caller supplies its restricted DB and service environment. */
export async function startWebOAuthBackend(database: DbInstance) {
  const sockets = new Set<Socket>();
  const active = new Set<Promise<void>>();
  const requests: { operation: string; status: number }[] = [];
  let accepting = true;
  const server = createServer((request, response) => {
    if (!accepting) {
      response.destroy();
      return;
    }
    response.once('finish', () => {
      const operation = request.url?.endsWith('/intent')
        ? 'intent'
        : request.url?.endsWith('/resolve')
          ? 'resolve'
          : 'unknown';
      requests.push({ operation, status: response.statusCode });
    });
    const pending = handleCurrentStoreWebOAuth(request, response, database).catch(() => {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unavailable' }));
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      accepting = false;
      const failures: Error[] = [];
      const closed = new Promise<void>((accept) => server.close(() => accept()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      try {
        await bounded(closed);
      } catch {
        failures.push(new Error('Owned web OAuth listener cleanup failed'));
      }
      try {
        await bounded(Promise.allSettled(active));
      } catch {
        failures.push(new Error('Owned web OAuth handler cleanup failed'));
      }
      if (active.size || server.listening) failures.push(new Error('Owned web OAuth backend did not quiesce'));
      if (failures.length) throw new AggregateError(failures, 'Owned web OAuth backend cleanup failed');
    })());
  try {
    await bounded(
      new Promise<void>((accept, reject) => {
        server.once('error', () => reject(new Error('Owned web OAuth listener failed')));
        server.listen(0, '127.0.0.1', accept);
      }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned identity listener did not bind');
    return { origin: `http://127.0.0.1:${address.port}`, requests, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
