// MUST be the first import: initializes Sentry + loads dotenv before any
// instrumented module (HTTP, Postgres, Redis) is required.
import './instrument';
import * as Sentry from '@sentry/node';
import { startServer } from './server';
import { redisClientManager } from './redis/client';
import { closePool, closeReadPool } from '@boardsesh/db/client';
import { shutdownPosthog } from './services/analytics/posthog';
import { logger } from './utils/logger';
import { FORCE_SHUTDOWN_TIMEOUT_MS } from './shutdown-timing';

async function main() {
  const { wss, httpServer, cleanupIntervals, shutdownServices } = await startServer();

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('\nShutting down Boardsesh Daemon...');

    // Force exit if the graceful shutdown stalls (see shutdown-timing.ts)
    const forceTimer = setTimeout(() => {
      logger.info('Forcing shutdown...');
      void Sentry.flush(2000).finally(() => process.exit(1));
    }, FORCE_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    // Stop accepting new connections before anything slow runs. `close()` only
    // shuts the listener — its callback waits for the already-open connections
    // to finish — so start it here and await the result at the end.
    //
    // The ordering matters. `wss.close()` below does not resolve until every
    // client is gone (the server is attached via `options.server`, so ws waits
    // on `clients.size`), and a peer that never answers our close frame holds
    // it for ws's 30s `closeTimeout` — three times FORCE_SHUTDOWN_TIMEOUT_MS.
    // Closing the listener only after that would leave the process accepting
    // new HTTP requests right up to a force exit that then severs them, which
    // is the exact failure this shutdown path exists to prevent.
    //
    // No `closeIdleConnections()` call: since Node 19 `close()` drops idle
    // keep-alive connections on its own, and package.json pins Node 22.
    const httpServerClosed = new Promise<void>((resolve) => {
      httpServer.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });

    // Stop periodic tasks
    cleanupIntervals();

    // Shutdown EventBroker + RoomManager (flushes pending writes)
    await shutdownServices();

    // Close WebSocket connections
    wss.clients.forEach((client) => {
      client.close(1000, 'Server shutting down');
    });

    // Wait for WS and HTTP servers to close before touching the DB pool
    await new Promise<void>((resolve) => {
      wss.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    });

    await httpServerClosed;

    // Disconnect from Redis
    await redisClientManager.disconnect();

    // Close database connection pools (primary + read replica)
    try {
      await closeReadPool();
      await closePool();
      logger.info('Database pools closed');
    } catch (error) {
      logger.warn('Error closing database pools:', error);
    }

    await shutdownPosthog();
    await Sentry.flush(2000);
    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  // logger.error forwards to Sentry via SentryWinstonTransport; no need for
  // an explicit captureException here. Keep the Sentry.flush so the event
  // makes it out before the process exits.
  logger.error('Failed to start server:', error);
  await Sentry.flush(2000);
  process.exit(1);
});
