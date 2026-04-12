import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { WebSocketServer } from 'ws';
import { pubsub } from './pubsub/index';
import { roomManager } from './services/room-manager';
import { redisClientManager } from './redis/client';
import { eventBroker, NotificationWorker } from './events/index';
import { sql } from 'drizzle-orm';
import { db } from './db/client';
import { initCors, applyCorsHeaders } from './handlers/cors';
import { handleHealthCheck } from './handlers/health';
import { handleSessionJoin } from './handlers/join';
import { handleAvatarUpload } from './handlers/avatars';
import { handleStaticAvatar } from './handlers/static';
import { handleSyncCron } from './handlers/sync';
import { handleOcrTestDataUpload } from './handlers/ocr-test-data';
import { handleWidgetNavigate } from './handlers/widget-navigate';
import { createYogaInstance } from './graphql/yoga';
import { setupWebSocketServer } from './websocket/setup';
import { runInferredSessionBuilderBatched } from './jobs/inferred-session-builder';
import { warmPopularConfigsCache } from './graphql/resolvers/social/boards';
import { initializeApns, shutdownApns, sendLiveActivityUpdate } from './services/apns';
import type { QueueEvent } from '@boardsesh/shared-schema';
import type { LiveActivityContentState } from './services/apns';

/**
 * Start the Boardsesh Backend server
 *
 * This server uses GraphQL Yoga for HTTP GraphQL requests and graphql-ws
 * for WebSocket subscriptions. Non-GraphQL routes are handled by custom
 * request handlers.
 */
export interface ServerResources {
  wss: WebSocketServer;
  httpServer: ReturnType<typeof createServer>;
  cleanupIntervals: () => void;
  shutdownServices: () => Promise<void>;
}

export async function startServer(): Promise<ServerResources> {
  // Initialize PubSub (connects to Redis if configured)
  // This must happen before we start accepting connections
  await pubsub.initialize();

  // Initialize RoomManager with Redis for session persistence
  if (redisClientManager.isRedisConfigured() && redisClientManager.isRedisConnected()) {
    const { publisher, streamConsumer } = redisClientManager.getClients();
    await roomManager.initialize(publisher);

    // Initialize EventBroker and NotificationWorker (requires Redis)
    try {
      await eventBroker.initialize(publisher, streamConsumer);
      const notificationWorker = new NotificationWorker(eventBroker);
      notificationWorker.start();
      console.log('[Server] EventBroker and NotificationWorker started');
    } catch (error) {
      console.error('[Server] Failed to initialize EventBroker:', error);
    }
  } else {
    await roomManager.initialize(); // Postgres-only mode
    console.log('[Server] No Redis - EventBroker disabled, inline notification fallback active');
  }

  // Initialize APNs for iOS Live Activity push notifications
  initializeApns();

  // Wire PubSub queue events to APNs Live Activity updates.
  // The hook is fire-and-forget: it reads queue state from roomManager and
  // sends a debounced push via the APNs service. Failures are logged, never
  // thrown, so they cannot block PubSub dispatch.
  const APNS_RELEVANT_EVENTS = new Set([
    'CurrentClimbChanged',
    'FullSync',
    'QueueItemAdded',
    'QueueItemRemoved',
    'QueueReordered',
  ]);

  pubsub.setQueueEventHook((sessionId: string, event: QueueEvent) => {
    if (!APNS_RELEVANT_EVENTS.has(event.__typename)) return;

    // Async work wrapped in a void IIFE — never awaited, never throws
    void (async () => {
      try {
        const queueState = await roomManager.getQueueState(sessionId);
        const { queue, currentClimbQueueItem } = queueState;

        if (!currentClimbQueueItem) return;

        const currentIndex = queue.findIndex(
          (item) => item.uuid === currentClimbQueueItem.uuid,
        );

        const contentState: LiveActivityContentState = {
          climbName: currentClimbQueueItem.climb.name,
          climbDifficulty: currentClimbQueueItem.climb.difficulty,
          angle: currentClimbQueueItem.climb.angle,
          currentIndex: currentIndex >= 0 ? currentIndex : 0,
          totalClimbs: queue.length,
          hasNext: currentIndex < queue.length - 1,
          hasPrevious: currentIndex > 0,
          climbUuid: currentClimbQueueItem.climb.uuid,
        };

        sendLiveActivityUpdate(sessionId, contentState);
      } catch (error) {
        console.error(`[APNs Hook] Failed to send Live Activity update for session ${sessionId}:`, error);
      }
    })();
  });

  const PORT = parseInt(process.env.PORT || '8080', 10);
  const BOARDSESH_URL = process.env.BOARDSESH_URL || 'https://boardsesh.com';

  // Initialize CORS with allowed origins
  initCors(BOARDSESH_URL);

  // Create GraphQL Yoga instance
  const yoga = createYogaInstance();

  /**
   * Custom request handler that routes requests to appropriate handlers
   */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // Health check endpoint
      if (pathname === '/health' && req.method === 'GET') {
        await handleHealthCheck(req, res);
        return;
      }

      // Session join redirect endpoint
      if (pathname.startsWith('/join/') && req.method === 'GET') {
        const sessionId = pathname.slice('/join/'.length);
        await handleSessionJoin(req, res, sessionId, PORT, BOARDSESH_URL);
        return;
      }

      // Avatar upload endpoint (handle OPTIONS for CORS preflight)
      if (pathname === '/api/avatars' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleAvatarUpload(req, res);
        return;
      }

      // OCR test data upload endpoint (handle OPTIONS for CORS preflight)
      if (pathname === '/api/ocr-test-data' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleOcrTestDataUpload(req, res);
        return;
      }

      // Static avatar files
      if (pathname.startsWith('/static/avatars/')) {
        const fileName = pathname.slice('/static/avatars/'.length);
        if (fileName) {
          await handleStaticAvatar(req, res, fileName);
          return;
        }
      }

      // Widget queue navigation endpoint (called by iOS lock-screen widget)
      if (pathname === '/api/widget/navigate' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleWidgetNavigate(req, res);
        return;
      }

      // Sync cron endpoint (triggered by external cron service)
      if (pathname === '/sync-cron' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleSyncCron(req, res);
        return;
      }

      // GraphQL endpoint - delegate to Yoga
      if (pathname === '/graphql') {
        // Apply CORS for GraphQL requests
        if (!applyCorsHeaders(req, res)) return;

        // Yoga handles the request and writes directly to the response
        await yoga.handle(req, res);
        return;
      }

      // 404 for all other routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('Request handler error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  }

  // Create HTTP server with custom request handler
  const httpServer = createServer(handleRequest);

  // Setup WebSocket server for GraphQL subscriptions (includes ping/pong heartbeat)
  const { wss, pingInterval } = setupWebSocketServer(httpServer);

  // Track intervals for cleanup
  const intervals: NodeJS.Timeout[] = [pingInterval];

  console.log(`Boardsesh Backend starting on port ${PORT}...`);

  // Start HTTP server (WebSocket server is attached to it)
  httpServer.listen(PORT, () => {
    console.log(`Boardsesh Backend is running on port ${PORT}`);
    console.log(`  GraphQL HTTP: http://0.0.0.0:${PORT}/graphql`);
    console.log(`  GraphQL WS: ws://0.0.0.0:${PORT}/graphql`);
    console.log(`  Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`  Join session: http://0.0.0.0:${PORT}/join/:sessionId`);
    console.log(`  Avatar upload: http://0.0.0.0:${PORT}/api/avatars`);
    console.log(`  Avatar files: http://0.0.0.0:${PORT}/static/avatars/`);
    console.log(`  OCR test data: http://0.0.0.0:${PORT}/api/ocr-test-data`);
    console.log(`  Widget navigate: http://0.0.0.0:${PORT}/api/widget/navigate`);
    console.log(`  Sync cron: http://0.0.0.0:${PORT}/sync-cron`);

    // Warm up popular board configs cache in the background.
    // Uses a Redis lock so only one node across the cluster runs the query.
    warmPopularConfigsCache().catch((err) => {
      console.error('[Server] Popular configs cache warm-up failed:', err);
    });
  });

  httpServer.on('error', (error) => {
    console.error('HTTP server error:', error);
  });

  /**
   * Clean up intervals and timers on shutdown
   */
  function cleanupIntervals(): void {
    console.log(`[Server] Cleaning up ${intervals.length} intervals`);
    intervals.forEach(interval => clearInterval(interval));
    intervals.length = 0;
  }

  /**
   * Shutdown services (EventBroker + RoomManager).
   * Called by the centralized shutdown handler in index.ts.
   */
  async function shutdownServices(): Promise<void> {
    eventBroker.shutdown();

    try {
      await shutdownApns();
      console.log('[Server] APNs shutdown complete');
    } catch (error) {
      console.error('[Server] Error during APNs shutdown:', error);
    }

    try {
      await roomManager.shutdown();
      console.log('[Server] RoomManager shutdown complete');
    } catch (error) {
      console.error('[Server] Error during RoomManager shutdown:', error);
    }
  }

  // Periodic flush as backup (every 60 seconds)
  const flushInterval = setInterval(async () => {
    try {
      await roomManager.flushPendingWrites();
    } catch (error) {
      console.error('[Server] Error in periodic flush:', error);
    }
  }, 60000);
  intervals.push(flushInterval);

  // Periodic notification cleanup (once per day)
  const notificationCleanupInterval = setInterval(async () => {
    try {
      await db.execute(sql`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'`);
    } catch (error) {
      console.error('[Server] Notification cleanup error:', error);
    }
  }, 24 * 60 * 60 * 1000);
  intervals.push(notificationCleanupInterval);

  // Periodic feed items cleanup (hourly, retains 180 days)
  const feedCleanupInterval = setInterval(async () => {
    try {
      const result = await db.execute(sql`DELETE FROM feed_items WHERE created_at < NOW() - INTERVAL '180 days'`);
      const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      if (deleted > 0) {
        console.log(`[Server] Feed cleanup: deleted ${deleted} old feed items`);
      }
    } catch (error) {
      console.error('[Server] Feed cleanup error:', error);
    }
  }, 60 * 60 * 1000);
  intervals.push(feedCleanupInterval);

  // Periodic TTL refresh for active sessions (every 2 minutes)
  const ttlRefreshInterval = setInterval(async () => {
    try {
      if (redisClientManager.isRedisConnected() && roomManager['redisStore']) {
        const activeSessions = roomManager.getAllActiveSessions();

        if (activeSessions.length > 0) {
          console.log(`[Server] Refreshing TTL for ${activeSessions.length} active sessions`);

          // Batch refresh to avoid overwhelming Redis
          const batchSize = 50;
          for (let i = 0; i < activeSessions.length; i += batchSize) {
            const batch = activeSessions.slice(i, i + batchSize);
            await Promise.all(
              batch.map(sessionId =>
                roomManager['redisStore']?.refreshTTL(sessionId).catch(err =>
                  console.error(`[Server] TTL refresh failed for ${sessionId}:`, err)
                )
              )
            );
          }
        }
      }
    } catch (error) {
      console.error('[Server] Error in periodic TTL refresh:', error);
    }
  }, 120000); // 2 minutes
  intervals.push(ttlRefreshInterval);

  // Periodic inferred session builder (every 30 minutes)
  const inferredSessionInterval = setInterval(async () => {
    try {
      const result = await runInferredSessionBuilderBatched();
      if (result.ticksAssigned > 0) {
        console.log(`[Server] Inferred session builder: assigned ${result.ticksAssigned} ticks for ${result.usersProcessed} users`);
      }
    } catch (error) {
      console.error('[Server] Inferred session builder error:', error);
    }
  }, 30 * 60 * 1000);
  intervals.push(inferredSessionInterval);

  return { wss, httpServer, cleanupIntervals, shutdownServices };
}
