import { createServer, type IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { blockedOperationNames, objectRecord, observationHttpPolicy, permitGraphqlRead } from './guards';

export function websocketText(message: RawData): string {
  return Array.isArray(message)
    ? Buffer.concat(message).toString('utf8')
    : Buffer.isBuffer(message)
      ? message.toString('utf8')
      : Buffer.from(message).toString('utf8');
}

/** Temporary observation proxy: live reads plus existing-account auth; all application writes fail closed. */
export async function startObservationProxy(
  snapshot: (phase: 'before' | 'after') => unknown,
  testOptions: { port?: number; upstream?: string; websocketUpstream?: string } = {},
) {
  const counters = {
    liveReads: 0,
    authExchanges: 0,
    blockedWrites: 0,
    malformedRequests: 0,
    blockedOperationNames: {} as Record<string, number>,
  };
  const shutdown = new AbortController();
  const blocked = (payload: unknown) => {
    for (const name of blockedOperationNames(payload))
      counters.blockedOperationNames[name] = (counters.blockedOperationNames[name] ?? 0) + 1;
  };
  const sockets = new Set<WebSocket>();
  const upstream = testOptions.upstream ?? 'https://ws.boardsesh.com';
  const headers = (request: IncomingMessage) =>
    Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name, content]) =>
          [
            'authorization',
            'content-type',
            'accept',
            'x-client-name',
            'x-client-version',
            'x-client-platform',
            'x-client-build',
            'x-boardsesh-client',
          ].includes(name) && typeof content === 'string',
      ),
    ) as Record<string, string>;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const reply = (status: number, payload: unknown) => {
      if (response.destroyed || response.headersSent) return;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'GET' && ['/__observation/before', '/__observation/after'].includes(pathname)) {
      try {
        snapshot(pathname.endsWith('/before') ? 'before' : 'after');
        reply(200, { ok: true });
      } catch {
        reply(500, { error: 'bounded_sensor_snapshot_failed' });
      }
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          reply(413, { error: 'request_too_large' });
          return;
        }
      }
      const payload: unknown =
        request.method === 'POST' && ['/graphql', '/graphql/batch'].includes(pathname) ? JSON.parse(body) : null;
      const policy = observationHttpPolicy(request.method, pathname, payload);
      if (policy === 'blocked') {
        counters.blockedWrites++;
        if (payload) blocked(payload);
        else counters.blockedOperationNames.non_auth_http = (counters.blockedOperationNames.non_auth_http ?? 0) + 1;
        reply(403, { errors: [{ message: 'Observation blocks application writes' }] });
        return;
      }
      if (policy === 'auth') counters.authExchanges++;
      else counters.liveReads++;
      const result = await fetch(`${upstream}${request.url}`, {
        method: request.method,
        headers: headers(request),
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(20_000), shutdown.signal]),
      });
      const responseBytes = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'application/octet-stream',
      });
      response.end(responseBytes);
    } catch {
      counters.malformedRequests++;
      reply(502, { errors: [{ message: 'Observation read unavailable' }] });
    }
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/graphql') {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => {
      const remote = new WebSocket(
        testOptions.websocketUpstream ?? 'wss://ws.boardsesh.com/graphql',
        'graphql-transport-ws',
        { headers: headers(request), maxPayload: 2 * 1024 * 1024, handshakeTimeout: 20_000 },
      );
      sockets.add(client);
      sockets.add(remote);
      const pending: string[] = [];
      const send = (message: string) => {
        if (remote.readyState === WebSocket.OPEN) remote.send(message);
        else if (pending.length < 128) pending.push(message);
        else client.close(1008);
      };
      remote.once('open', () => pending.splice(0).forEach((message) => remote.send(message)));
      client.on('message', (message) => {
        try {
          const parsed = objectRecord(JSON.parse(websocketText(message)));
          if (
            !parsed ||
            typeof parsed.type !== 'string' ||
            !['connection_init', 'ping', 'pong', 'complete', 'subscribe'].includes(parsed.type)
          )
            throw new Error('invalid_frame');
          if (parsed.type === 'subscribe' && !permitGraphqlRead(parsed.payload)) {
            counters.blockedWrites++;
            blocked(parsed.payload);
            client.send(
              JSON.stringify({
                id: parsed.id,
                type: 'error',
                payload: [{ message: 'Observation blocks application writes' }],
              }),
            );
            return;
          }
          if (parsed.type === 'subscribe') counters.liveReads++;
          send(websocketText(message));
        } catch {
          counters.malformedRequests++;
          client.close(1008);
        }
      });
      remote.on('message', (message) => {
        if (client.readyState === WebSocket.OPEN) client.send(websocketText(message));
      });
      for (const [first, second] of [
        [client, remote],
        [remote, client],
      ]) {
        first.on('error', () => second.terminate());
        first.on('close', () => {
          sockets.delete(first);
          second.terminate();
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(testOptions.port ?? 8119, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as { port: number }).port,
    counters,
    async close() {
      shutdown.abort();
      server.closeAllConnections();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => server.close(() => resolve())));
    },
  };
}
