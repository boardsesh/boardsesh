import { createServer } from 'node:http';

let stopAfterDisconnect: (() => void) | undefined;
process.once('disconnect', () => {
  if (stopAfterDisconnect) stopAfterDisconnect();
  else process.exit(1);
});

// This fixture never imports worker-db (which creates/resets schemas) or a
// dotenv loader. Reject its explicit local authority before runtime imports.
function requireOwnedEnvironment() {
  const address = new URL(process.env.DATABASE_URL ?? 'invalid:');
  const expectedName = process.env.BOARDSESH_ADMISSION_FIXTURE_DB_NAME ?? '';
  const canonical =
    (['1', 'true'].includes(process.env.CI ?? '') && process.env.GITHUB_ACTIONS === 'true') ||
    process.env.BOARDSESH_ADMISSION_FIXTURE_CANONICAL === '1';
  if (
    !process.send ||
    process.env.NODE_ENV !== 'test' ||
    process.env.VITEST !== 'true' ||
    !/^boardsesh_backend_test_w\d+(?:_[a-f0-9]{12})?$/.test(expectedName) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
    !(address.port === '15478' || (address.port === '5433' && canonical)) ||
    address.pathname !== `/${expectedName}` ||
    process.env.READ_REPLICA_URL ||
    !process.env.NEXTAUTH_SECRET
  )
    throw new Error('Owned child authority is required');
  const redis = new URL(process.env.REDIS_URL ?? 'invalid:');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname) || !/^\/\d{1,2}$/.test(redis.pathname))
    throw new Error('Owned child Redis is required');
}

function send(message: object) {
  if (process.connected) process.send?.(message);
}
async function until(predicate: () => boolean, milliseconds = 4000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Owned child drain deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  requireOwnedEnvironment();
  const { logger } = await import('../../utils/logger');
  logger.silent = true;
  const [
    { setupWebSocketServer },
    { getConnectionCount },
    { pubsub },
    { redisClientManager },
    { closePool, closeReadPool },
    { closeAdmissionPool },
    { stopClientUsageReporter },
    { kilterLiveSync },
  ] = await Promise.all([
    import('../../websocket/setup'),
    import('../../graphql/context'),
    import('../../pubsub'),
    import('../../redis/client'),
    import('@boardsesh/db/client'),
    import('../../auth/admission-pool'),
    import('../../services/client-usage'),
    import('../../services/kilter-live-sync'),
  ]);
  const http = createServer((_request, response) => response.writeHead(404).end());
  const { wss, pingInterval } = setupWebSocketServer(http);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const watchdog = setTimeout(() => {
      send({ type: 'failure', phase: 'shutdown' });
      process.exit(1);
    }, 7000);
    try {
      clearInterval(pingInterval);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
      await until(() => getConnectionCount() === 0 && pubsub.getRuntimeStats().notification.subscribers === 0);
      await kilterLiveSync.shutdown();
      stopClientUsageReporter();
      await redisClientManager.disconnect();
      await Promise.all([closePool(), closeReadPool(), closeAdmissionPool()]);
      if (process.connected)
        await new Promise<void>((resolve, reject) =>
          process.send?.(
            {
              type: 'closed',
              registryDrained: true,
              listenersClosed: true,
              poolsClosed: true,
              redisClosed: true,
            },
            (error) => (error ? reject(error) : resolve()),
          ),
        );
      clearTimeout(watchdog);
      if (process.connected) process.disconnect?.();
      // Runtime imports also own unrelated referenced housekeeping intervals.
      // Exit only after our real resources drained and the receipt was flushed.
      process.exit(0);
    } catch {
      clearTimeout(watchdog);
      send({ type: 'failure', phase: 'shutdown' });
      process.exit(1);
    }
  };
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const request = message as { type?: unknown; requestId?: unknown };
    if (request.type === 'stop') void stop();
    if (request.type === 'status' && Number.isSafeInteger(request.requestId))
      send({
        type: 'status',
        requestId: request.requestId,
        connections: getConnectionCount(),
        notificationSubscribers: pubsub.getRuntimeStats().notification.subscribers,
      });
  });
  stopAfterDisconnect = () => {
    void stop();
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Owned child has no port');
  send({ type: 'ready', url: `ws://127.0.0.1:${address.port}/graphql` });
} catch {
  send({ type: 'failure', phase: 'startup' });
  process.exit(1);
}
