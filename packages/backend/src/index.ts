// MUST be the first import: initializes Sentry + loads dotenv before any
// instrumented module (HTTP, Postgres, Redis) is required.
import './instrument';
import * as Sentry from '@sentry/node';
import { startServer } from './server';
import { redisClientManager } from './redis/client';
import { closePool, closeReadPool } from '@boardsesh/db/client';
import { shutdownPosthog } from './services/analytics/posthog';
import { logger } from './utils/logger';

async function main() {
  const { wss, httpServer, cleanupIntervals, shutdownServices } = await startServer();

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('\nShutting down Boardsesh Daemon...');

    // Force exit after 10 seconds if graceful shutdown stalls
    const forceTimer = setTimeout(() => {
      logger.info('Forcing shutdown...');
      void Sentry.flush(2000).finally(() => process.exit(1));
    }, 10000);
    forceTimer.unref();

    // Stop periodic tasks first
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

    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
      // close() stops accepting new connections but still waits for every open
      // one, and the Cloudflare -> Railway edge holds keep-alive sockets open
      // between requests. Without this the close would always stall until the
      // force timer above, so a draining window (railway.toml drainingSeconds)
      // would buy nothing. closeIdleConnections only drops sockets that are
      // between requests — connections mid-request are left to finish.
      httpServer.closeIdleConnections();
    });

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
