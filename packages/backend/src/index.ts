// MUST be the first import: initializes Sentry + loads dotenv before any
// instrumented module (HTTP, Postgres, Redis) is required.
import './instrument';
import * as Sentry from '@sentry/node';
import { startServer } from './server';
import { redisClientManager } from './redis/client';
import { closePool, closeReadPool } from '@boardsesh/db/client';
import { shutdownServerAnalytics } from './analytics/server-analytics';

async function main() {
  const { wss, httpServer, cleanupIntervals, shutdownServices } = await startServer();

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    console.info('\nShutting down Boardsesh Daemon...');

    // Force exit after 10 seconds if graceful shutdown stalls
    const forceTimer = setTimeout(() => {
      console.info('Forcing shutdown...');
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
        console.info('WebSocket server closed');
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        console.info('HTTP server closed');
        resolve();
      });
    });

    // Flush + close PostHog server-side analytics (no-op if disabled)
    try {
      await shutdownServerAnalytics();
    } catch (error) {
      console.warn('Error shutting down server analytics:', error);
    }

    // Disconnect from Redis
    await redisClientManager.disconnect();

    // Close database connection pools (primary + read replica)
    try {
      await closeReadPool();
      await closePool();
      console.info('Database pools closed');
    } catch (error) {
      console.warn('Error closing database pools:', error);
    }

    await Sentry.flush(2000);
    console.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error('Failed to start server:', error);
  Sentry.captureException(error);
  await Sentry.flush(2000);
  process.exit(1);
});
