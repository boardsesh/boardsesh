/** Real GraphQL/REST server for local tutorial captures, without production dotenv or vendor workers. */
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.BOARDSESH_TUTORIAL_DEMO !== '1' ||
    !['localhost', '127.0.0.1'].includes(database.hostname) ||
    database.pathname !== '/boardsesh_tutorial'
  )
    throw new Error('Tutorial server requires its isolated loopback database');
  const { startServer } = await import('../server');
  const { closePool, closeReadPool } = await import('@boardsesh/db/client');
  const { redisClientManager } = await import('../redis/client');
  const { shutdownPosthog } = await import('../services/analytics/posthog');
  const { wss, httpServer, cleanupIntervals, shutdownServices } = await startServer({ host: '127.0.0.1' });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    cleanupIntervals();
    const closed = new Promise<void>((accept) => httpServer.close(() => accept()));
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((accept) => wss.close(() => accept()));
    await shutdownServices();
    await closed;
    await redisClientManager.disconnect();
    await closeReadPool();
    await closePool();
    await shutdownPosthog();
  };
  const stopOnSignal = (): void => {
    void stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('[tutorial-demo] Server shutdown failed', { error });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', stopOnSignal);
  process.on('SIGINT', stopOnSignal);
}
void main().catch((error: unknown) => {
  logger.error('[tutorial-demo] Server failed', { error });
  process.exitCode = 1;
});
