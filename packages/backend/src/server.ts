import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'node:fs';
import type { WebSocketServer } from 'ws';
import { pubsub } from './pubsub/index';
import { roomManager } from './services/room-manager';
import { redisClientManager } from './redis/client';
import { eventBroker, NotificationWorker } from './events/index';
import { initCors, applyCorsHeaders } from './handlers/cors';
import { handleDatabaseHealthCheck, handleHealthCheck } from './handlers/health';
import { recordDbConnectRetry } from './services/db-health';
import { handleSessionJoin } from './handlers/join';
import { handleAvatarUpload } from './handlers/avatars';
import { handleGymLogoUpload } from './handlers/gym-logos';
import { handleGymPhotoDelete, handleGymPhotoUpload } from './handlers/gym-photos';
import {
  handleStaticAvatar,
  handleStaticBetaThumbnail,
  handleStaticGymLogo,
  handleStaticGymPhoto,
} from './handlers/static';
import { staticPathToMediaRedirect } from './lib/media-url';
import { getMediaPublicBaseUrl } from './storage/s3';
import { handleOgClimb } from './handlers/og-climb';
import { handleBoardRender, isBoardRenderPath } from './handlers/board-render';
import { handleBoardGeometry, isBoardGeometryPath } from './handlers/board-geometry';
import { initBoardRenderer } from './services/board-render';
import { parseSizeParam } from './lib/image-resize';
import { handleOcrTestDataUpload } from './handlers/ocr-test-data';
import { handlePosthogProxy } from './handlers/posthog';
import { handleUserDataExport, handleUserDataExportDownload } from './handlers/user-data-export';
import { handleCncArtUpload } from './handlers/cnc-art-upload';
import { handleCncStripeWebhook } from './handlers/cnc-stripe-webhook';
import { handleCncWorkerApi } from './handlers/cnc-worker';
import { handleCncPackDownload } from './handlers/cnc-download';
import { pruneSyncDeletions } from './services/sync-deletions-prune';
import { handleAuroraCredentials, handleAuroraCredentialsUnsynced } from './handlers/aurora-credentials';
import { handleAuroraImport } from './handlers/aurora-import';
import { handleMoonBoardImport } from './handlers/moonboard-import';
import {
  handleKilterCredentialsCallback,
  handleKilterCredentialsFinalize,
  handleKilterCredentialsHandoff,
  handleKilterCredentialsPassword,
  handleKilterCredentialsStart,
} from './handlers/kilter-credentials-oauth';
import { handleGymClaimVerify } from './handlers/gym-claims';
import { handleWidgetNavigate } from './handlers/widget-navigate';
import { handleWidgetTakeControl } from './handlers/widget-take-control';
import { handleSessionNavigate, handleSessionTakeControl } from './handlers/session-actions';
import { handleSessionState } from './handlers/session-state';
import {
  handleNativeAuthCredentials,
  handleNativeAuthExchange,
  handleNativeAuthOAuth,
  handleNativeAuthRefresh,
  handleNativeAuthRegister,
  handleNativeAuthRevoke,
  handleWatchPair,
  handleWatchPairCode,
  startRefreshTokenCleanup,
  stopRefreshTokenCleanup,
} from './handlers/native-auth';
import { handleApnsStats } from './handlers/apns-stats';
import { handleIntegrationOAuthStart, handleIntegrationOAuthCallback } from './handlers/integrations-oauth';
import { createYogaInstance } from './graphql/yoga';
import { setupWebSocketServer } from './websocket/setup';
import { warmPopularConfigsCache } from './graphql/resolvers/social/boards';
import { warmRecentBetaLinksCache } from './graphql/resolvers/beta-videos/queries';
import {
  initializeApns,
  shutdownApns,
  sendLiveActivityUpdate,
  setSessionHolderResolver,
  isApnsConfigured,
} from './services/apns';
import { startApnsHeartbeat, stopApnsHeartbeat } from './services/apns/heartbeat';
import { startApnsStaleTokenCleanup, stopApnsStaleTokenCleanup } from './services/apns/cleanup';
import { buildContentStateFromQueueState } from './services/apns/content-state';
import { allocateBoardPresenceSeq, resolveBoardHolder } from './graphql/resolvers/board-presence/shared';
import { registerBoardQueuePreviewHook } from './services/board-queue-preview';
import { logger, setInstanceIdProvider } from './utils/logger';
import { isClientAbortError } from './utils/http-errors';
import { setDbConnectObserver } from '@boardsesh/db/client';
import { isProductionSentryEnvironment, resolveSentryEnvironment } from '@boardsesh/db/client/config';
import type { QueueEvent } from '@boardsesh/shared-schema';

/**
 * Start the Boardsesh Backend server
 *
 * This server uses GraphQL Yoga for HTTP GraphQL requests and graphql-ws
 * for WebSocket subscriptions. Non-GraphQL routes are handled by custom
 * request handlers.
 */
export type ServerResources = {
  wss: WebSocketServer;
  httpServer: ReturnType<typeof createServer>;
  cleanupIntervals: () => void;
  shutdownServices: () => Promise<void>;
};

/**
 * Build a Live Activity content snapshot from current room state and dispatch
 * a debounced APNs push. Pulled out of the queue-event hook so the call site
 * is a single promise chain whose rejections are explicitly swallowed at the
 * top — easier to grep, easier to attach a real observability sink to later.
 */
async function dispatchLiveActivityForSession(sessionId: string): Promise<void> {
  const queueState = await roomManager.getQueueState(sessionId);
  const contentState = buildContentStateFromQueueState(queueState);
  if (!contentState) return;
  sendLiveActivityUpdate(sessionId, contentState);
}

export async function startServer(): Promise<ServerResources> {
  // Surface database connect retries. `warn`, not `error`: SentryWinstonTransport
  // is constructed with `level: 'error'` (utils/sentry-transport.ts:80), so a
  // warn stays log-only and cannot double-report alongside the
  // Sentry.captureException that graphql/mask-error.ts already does for the
  // failures that outlive the retry.
  setDbConnectObserver((event) => {
    recordDbConnectRetry(event);
    logger.warn(
      `[db] connect retry ${event.attempt}/${event.maxAttempts} after ${event.code} ` +
        `(elapsed ${event.elapsedMs}ms, next attempt in ${event.delayMs}ms)`,
    );
  });

  // Initialize PubSub (connects to Redis if configured)
  // This must happen before we start accepting connections
  await pubsub.initialize();

  // Initialize the board renderer (loads the WASM overlay module + resolves
  // the board images root). Never throws — image endpoints return 503 on failure.
  await initBoardRenderer();

  // PostgreSQL owns sequence reservations; Redis supplies a fast candidate and
  // is mirrored up to the committed value. This also serializes allocations
  // against board-merge row locks, so resequencing cannot create collisions.
  pubsub.setBoardSeqAllocator(allocateBoardPresenceSeq);

  // Wire the logger to the pubsub instance id. The format step in the
  // logger reads this provider at log time, so we get the `[i:abcd1234]`
  // tag (dev) / `instanceId` field (prod) once Redis is connected, and
  // an untagged line when running without Redis.
  setInstanceIdProvider(() => pubsub.getInstanceId());

  // Initialize RoomManager with Redis for session persistence
  if (redisClientManager.isRedisConfigured() && redisClientManager.isRedisConnected()) {
    const { publisher, streamConsumer } = redisClientManager.getClients();
    await roomManager.initialize(publisher);

    // Initialize EventBroker and NotificationWorker (requires Redis)
    try {
      await eventBroker.initialize(publisher, streamConsumer);
      const notificationWorker = new NotificationWorker(eventBroker);
      notificationWorker.start();
      logger.info('[Server] EventBroker and NotificationWorker started');
    } catch (error) {
      logger.error('[Server] Failed to initialize EventBroker:', error);
    }
  } else {
    await roomManager.initialize(); // Postgres-only mode
    logger.info('[Server] No Redis - EventBroker disabled, inline notification fallback active');
  }

  // Holds the F10 multi-instance APNs config marker interval. Set when Redis
  // is configured (see below); cleared by `shutdownServices` so the timer
  // doesn't outlive the process during tests.
  let apnsInstanceConfigInterval: ReturnType<typeof setInterval> | null = null;

  // Initialize APNs for iOS Live Activity push notifications
  initializeApns();

  // Teach the APNs send path how to resolve a session's board holder so every
  // pushed Live Activity reflects WHO holds the board (connectedByMe on the
  // holder's device, heldByPeer on everyone else's). One lookup per send, keyed
  // by the session→board mapping `reportBoardClimb` persists. Returns null when
  // the board/holder can't be resolved (no mapping, no Redis, anonymous holder),
  // in which case boardConnection is omitted and the device keeps its own state.
  setSessionHolderResolver(async (sessionId: string) => {
    const boardId = await pubsub.getSessionBoard(sessionId);
    if (boardId === null) return null;
    const holder = await resolveBoardHolder(Number(boardId));
    // No holder, or an anonymous (`conn:`) holder (null userId): we can't tell
    // whether it's this device or a peer, so omit boardConnection.
    if (!holder || holder.userId == null) return null;
    return { holderUserId: holder.userId, holderDisplayName: holder.displayName ?? null };
  });

  // Start periodic cleanup of expired/revoked mobile refresh tokens.
  startRefreshTokenCleanup();

  // Surface APNs configuration status at startup. The queue event hook
  // wired below has *publisher-side* semantics: it only fires on the
  // instance that originates a queue event. So in a multi-instance cluster
  // every node that handles queue mutations must also have APNs configured —
  // otherwise queue mutations that land on the unconfigured node will silently
  // skip the Live Activity push.
  const instanceId = process.env.HOSTNAME || process.env.FLY_MACHINE_ID || 'local';
  if (isApnsConfigured()) {
    logger.info(`[Server] APNs configured for instance ${instanceId}`);
    // Heartbeat keeps the lock-screen Live Activity alive during long idle
    // periods. The 90-s tick re-sends the latest content state for every
    // session with at least one registered push token. Only one instance in
    // the cluster runs the sweep on any given tick (Redis lock).
    startApnsHeartbeat(roomManager, instanceId);
    // Periodic cleanup of week-old push tokens that never had a chance to
    // bounce back as stale via a real send.
    startApnsStaleTokenCleanup();
  } else {
    logger.warn(
      `[Server] APNs NOT configured on instance ${instanceId}. ` +
        'Live Activity push notifications will be silently dropped for queue ' +
        'events that originate on this instance. Set APNS_KEY_ID, APNS_TEAM_ID, ' +
        'and APNS_KEY_CONTENTS on every backend node that handles queue mutations.',
    );
  }

  // Multi-instance APNs configuration sanity check. Each instance writes its
  // own configured/unconfigured marker to a shared Redis hash. If any peer is
  // configured but we are not (or vice-versa), escalate to ERROR so a
  // half-rolled-out deploy doesn't silently lose pushes. Stored as a single
  // hash with HSET + HGETALL so reads are O(1) round-trips regardless of
  // cluster size, and stale entries time out via per-field expiry simulation
  // (instance writes its own value every 30 s; markers older than 60 s are
  // ignored by the freshness check below).
  if (redisClientManager.isRedisConfigured()) {
    const APNS_INSTANCE_HASH_KEY = 'boardsesh:apns:instance-config';
    const APNS_INSTANCE_STALE_MS = 60 * 1000;
    const APNS_INSTANCE_REFRESH_MS = 30 * 1000;

    async function refreshApnsInstanceConfigMarker(): Promise<void> {
      if (!redisClientManager.isRedisConnected()) return;
      try {
        const { publisher } = redisClientManager.getClients();
        const now = Date.now();
        const value = JSON.stringify({ configured: isApnsConfigured(), ts: now });
        await publisher.hset(APNS_INSTANCE_HASH_KEY, instanceId, value);

        const all = await publisher.hgetall(APNS_INSTANCE_HASH_KEY);
        let configuredPeers = 0;
        let unconfiguredPeers = 0;
        const stalePeers: string[] = [];
        for (const [peerId, raw] of Object.entries(all)) {
          if (peerId === instanceId) continue;
          try {
            const parsed = JSON.parse(raw) as { configured: boolean; ts: number };
            if (now - parsed.ts > APNS_INSTANCE_STALE_MS) {
              stalePeers.push(peerId);
              continue;
            }
            if (parsed.configured) configuredPeers++;
            else unconfiguredPeers++;
          } catch {
            stalePeers.push(peerId);
          }
        }
        if (stalePeers.length > 0) {
          await publisher.hdel(APNS_INSTANCE_HASH_KEY, ...stalePeers);
        }

        if (isApnsConfigured() && unconfiguredPeers > 0) {
          logger.error(
            `[APNs] Mixed cluster configuration detected: ${String(unconfiguredPeers)} peer(s) lack APNs env vars. ` +
              'Queue events originating on those instances will silently skip Live Activity pushes.',
          );
        } else if (!isApnsConfigured() && configuredPeers > 0) {
          logger.error(
            `[APNs] This instance (${instanceId}) is missing APNs env vars while ${String(configuredPeers)} peer(s) ` +
              'are configured. Push notifications will be silently dropped for queue events originating here.',
          );
        }
      } catch (error) {
        logger.warn('[APNs] Failed to refresh multi-instance config marker:', error);
      }
    }

    const initialApnsConfigDelay = setTimeout(() => {
      refreshApnsInstanceConfigMarker().catch((err) => {
        logger.warn('[APNs] Initial config marker refresh failed:', err);
      });
    }, 5_000);
    if (typeof initialApnsConfigDelay.unref === 'function') initialApnsConfigDelay.unref();

    apnsInstanceConfigInterval = setInterval(() => {
      refreshApnsInstanceConfigMarker().catch((err) => {
        logger.warn('[APNs] Config marker refresh failed:', err);
      });
    }, APNS_INSTANCE_REFRESH_MS);
    if (typeof apnsInstanceConfigInterval.unref === 'function') apnsInstanceConfigInterval.unref();
  }

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

  pubsub.addQueueEventHook((sessionId: string, event: QueueEvent) => {
    if (!APNS_RELEVANT_EVENTS.has(event.__typename)) return;
    // Skip the queue-state read entirely when APNs is disabled —
    // sendLiveActivityUpdate would be a no-op, so the getQueueState round-trip
    // (Postgres read on miss, Redis on hit) is pure waste on every queue
    // mutation when env vars aren't configured.
    if (!isApnsConfigured()) return;

    // Errors are intentionally swallowed: a failed Live Activity dispatch must
    // not crash the queue-event consumer or surface to the originating GraphQL
    // request. Stack + sessionId go to the structured logger so a search on
    // "dispatchLiveActivityForSession failed" surfaces the failure mode.
    dispatchLiveActivityForSession(sessionId).catch((error: unknown) => {
      logger.error(
        `[APNs Hook] dispatchLiveActivityForSession failed for session ${sessionId}:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
    });
  });

  // Wire PubSub queue events to the redacted board-queue preview producer
  // (gym-kiosk "Up next"). Coexists with the APNs hook above on the same
  // multi-hook registry; publisher-side semantics are correct because the
  // board-queue channel itself Redis-fans-out the published preview. The
  // unregister is called in shutdownServices so pending debounce timers can't
  // fire a publish against closing Redis/DB connections during teardown.
  const unregisterBoardQueuePreviewHook = registerBoardQueuePreviewHook();

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

      // Database health — 503 when Postgres does not answer. Point monitors
      // here, not at /health (see handlers/health.ts for why).
      if (pathname === '/health/db' && req.method === 'GET') {
        await handleDatabaseHealthCheck(req, res);
        return;
      }

      // Climb Open Graph share-card renderer (moved off Vercel; long-running
      // process warms WASM + caches rendered bytes in memory).
      if (pathname === '/og/climb' && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleOgClimb(req, res, url);
        return;
      }

      // Canonical board renderer. HEAD deliberately follows the GET path so it
      // returns the exact content/cache headers without writing image bytes.
      if (isBoardRenderPath(pathname) && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
        await handleBoardRender(req, res, url);
        return;
      }

      // The traced board art, for the browser's own WASM renderer. JSON, not
      // pixels — the shards are too big to bundle, so web fetches the one board
      // config it is drawing.
      if (
        isBoardGeometryPath(pathname) &&
        (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
      ) {
        await handleBoardGeometry(req, res, url);
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

      // Gym logo upload endpoint (handle OPTIONS for CORS preflight)
      if (pathname === '/api/gym-logos' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleGymLogoUpload(req, res);
        return;
      }

      // Gym photo upload / removal endpoint (handle OPTIONS for CORS preflight)
      if (pathname === '/api/gym-photos' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleGymPhotoUpload(req, res);
        return;
      }

      if (pathname === '/api/gym-photos' && req.method === 'DELETE') {
        await handleGymPhotoDelete(req, res);
        return;
      }

      // OCR test data upload endpoint (handle OPTIONS for CORS preflight)
      if (pathname === '/api/ocr-test-data' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleOcrTestDataUpload(req, res);
        return;
      }

      // PostHog analytics reverse proxy — forwards /api/posthog/* to https://us.i.posthog.com/*
      // so ad-blockers that target *.posthog.com don't drop our events.
      if (pathname.startsWith('/api/posthog/') && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handlePosthogProxy(req, res, url);
        return;
      }

      // User data export endpoints (request/status + authenticated download)
      if (
        pathname === '/api/user-data-export' &&
        (req.method === 'GET' || req.method === 'POST' || req.method === 'OPTIONS')
      ) {
        await handleUserDataExport(req, res, url);
        return;
      }

      if (pathname === '/api/user-data-export/download' && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleUserDataExportDownload(req, res, url);
        return;
      }

      // Stripe webhook for CNC build packs. Deliberately no CORS and no bearer
      // token: the only caller is Stripe, and the `stripe-signature` header
      // over the raw body is the authentication. 404s when Stripe is not
      // configured rather than accepting unverifiable bodies. The method check
      // is the handler's — it answers 405, which is the honest code for a GET
      // to a route that exists, and it is covered by a test.
      if (pathname === '/api/cnc/stripe/webhook') {
        await handleCncStripeWebhook(req, res);
        return;
      }

      // Buyer artwork upload. CORS-enabled and Bearer-authenticated: the
      // configurator posts a multipart body to it from the browser, the same
      // shape the gym image uploads use. Registered BEFORE the worker prefix
      // only for readability — the paths do not overlap.
      if (pathname === '/api/cnc/art' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleCncArtUpload(req, res);
        return;
      }

      // The pack generator's job API: claim, heartbeat, complete, fail and the
      // art-asset stream. One prefix rather than five exact matches because the
      // paths are parameterised (`:orderId`, `:assetId`); `handleCncWorkerApi`
      // owns the dispatch. Bearer CNC_WORKER_SECRET on every route, and 404s
      // wholesale when that secret is unset. Deliberately no CORS: no browser
      // calls any of it.
      if (pathname.startsWith('/api/cnc/worker/')) {
        await handleCncWorkerApi(req, res, url);
        return;
      }

      // Authenticated build-pack download. CORS-enabled for the Bearer path —
      // the app calls it cross-origin — and it also accepts a short-lived
      // `?token=` grant for a plain browser navigation.
      if (/^\/api\/cnc\/packs\/[^/]+\/download$/.test(pathname) && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleCncPackDownload(req, res, url);
        return;
      }

      if (
        pathname === '/api/aurora-credentials' &&
        (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE' || req.method === 'OPTIONS')
      ) {
        await handleAuroraCredentials(req, res);
        return;
      }

      if (pathname === '/api/aurora-credentials/unsynced' && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleAuroraCredentialsUnsynced(req, res);
        return;
      }

      if (pathname === '/api/aurora-import' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleAuroraImport(req, res);
        return;
      }

      if (pathname === '/api/moonboard-import' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleMoonBoardImport(req, res);
        return;
      }

      if (pathname === '/api/board-credentials/kilter/handoff' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleKilterCredentialsHandoff(req, res);
        return;
      }

      if (
        pathname === '/api/board-credentials/kilter/finalize' &&
        (req.method === 'POST' || req.method === 'OPTIONS')
      ) {
        await handleKilterCredentialsFinalize(req, res);
        return;
      }

      if (
        pathname === '/api/board-credentials/kilter/password' &&
        (req.method === 'POST' || req.method === 'OPTIONS')
      ) {
        await handleKilterCredentialsPassword(req, res);
        return;
      }

      if (pathname === '/board-credentials/kilter/start' && req.method === 'GET') {
        await handleKilterCredentialsStart(req, res, url);
        return;
      }

      if (pathname === '/board-credentials/kilter/callback' && req.method === 'GET') {
        await handleKilterCredentialsCallback(req, res, url);
        return;
      }

      // Once the media bucket has a public base URL, /static/* stops streaming
      // bytes through this process and hands the client the CDN object instead.
      //
      // A redirect rather than only rewriting the stored URLs, because the
      // persisted values are backend-relative `/static/…?v=` paths and released
      // mobile builds string-match `/static/avatars/` before appending `?size=`
      // (packages/mobile/src/components/Avatar.tsx). Rewriting the columns
      // would make every shipped client fetch the full-res original for a 40px
      // circle; this keeps them correct while taking the bytes off the backend.
      //
      // 302 with a bounded TTL, not a permanent redirect: unsetting
      // MEDIA_PUBLIC_BASE_URL has to be a complete rollback, and browsers cache
      // a 301 far too aggressively (Safari has historically kept them forever)
      // for that promise to hold. An hour of edge caching absorbs effectively
      // all of the traffic anyway.
      if (pathname.startsWith('/static/')) {
        const mediaBaseUrl = getMediaPublicBaseUrl();
        if (mediaBaseUrl) {
          const target = staticPathToMediaRedirect(pathname, url.searchParams, mediaBaseUrl);
          // A path this does not recognise falls through to the proxy below,
          // which applies the same validation — so a null here is never a hole.
          if (target) {
            if (!applyCorsHeaders(req, res)) return;
            res.writeHead(302, { Location: target, 'Cache-Control': 'public, max-age=3600' });
            res.end();
            return;
          }
        }
      }

      // Static avatar files (optional ?size= for a resized variant)
      if (pathname.startsWith('/static/avatars/')) {
        const fileName = pathname.slice('/static/avatars/'.length);
        if (fileName) {
          await handleStaticAvatar(req, res, fileName, parseSizeParam(url.searchParams.get('size')));
          return;
        }
      }

      // Static gym-logo files (optional ?size= for a resized variant)
      if (pathname.startsWith('/static/gym-logos/')) {
        const fileName = pathname.slice('/static/gym-logos/'.length);
        if (fileName) {
          await handleStaticGymLogo(req, res, fileName, parseSizeParam(url.searchParams.get('size')));
          return;
        }
      }

      // Static gym-photo files (optional ?size= for a resized variant)
      if (pathname.startsWith('/static/gym-photos/')) {
        const fileName = pathname.slice('/static/gym-photos/'.length);
        if (fileName) {
          await handleStaticGymPhoto(req, res, fileName, parseSizeParam(url.searchParams.get('size')));
          return;
        }
      }

      // Static beta-link thumbnails (Instagram / TikTok), proxied from S3
      if (pathname.startsWith('/static/beta-link-thumbnails/')) {
        const remainder = pathname.slice('/static/beta-link-thumbnails/'.length);
        const slashIndex = remainder.indexOf('/');
        if (slashIndex > 0) {
          const platform = remainder.slice(0, slashIndex);
          const fileName = remainder.slice(slashIndex + 1);
          if (fileName) {
            await handleStaticBetaThumbnail(req, res, platform, fileName, parseSizeParam(url.searchParams.get('size')));
            return;
          }
        }
        res.writeHead(400);
        res.end();
        return;
      }

      // Gym claim domain-verification link (browser click from the claim email).
      if (pathname === '/api/gym-claims/verify' && req.method === 'GET') {
        await handleGymClaimVerify(req, res, url);
        return;
      }

      // Widget queue navigation endpoint (called by iOS lock-screen widget)
      if (pathname === '/api/widget/navigate' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleWidgetNavigate(req, res);
        return;
      }
      if (pathname === '/api/widget/take-control' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleWidgetTakeControl(req, res);
        return;
      }

      // JWT-authed session control for non-WebSocket clients (the Garmin watch).
      // Same server-authoritative navigation as the iOS widget, authed by a
      // mobile JWT instead of an APNs push token.
      if (pathname === '/api/session/navigate' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleSessionNavigate(req, res);
        return;
      }
      if (pathname === '/api/session/take-control' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleSessionTakeControl(req, res);
        return;
      }
      if (pathname === '/api/session/state' && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleSessionState(req, res, url);
        return;
      }

      // APNs metrics (debugging aid, gated on APNS_STATS_SECRET)
      if (pathname === '/api/internal/apns-stats' && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleApnsStats(req, res);
        return;
      }

      // Native auth endpoints for React Native mobile app
      if (pathname === '/auth/native/exchange' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleNativeAuthExchange(req, res);
        return;
      }

      if (pathname === '/auth/native/credentials' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleNativeAuthCredentials(req, res);
        return;
      }

      if (pathname === '/auth/native/register' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleNativeAuthRegister(req, res);
        return;
      }

      if (pathname === '/auth/native/oauth' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleNativeAuthOAuth(req, res);
        return;
      }

      if (pathname === '/auth/native/refresh' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleNativeAuthRefresh(req, res);
        return;
      }

      if (pathname === '/auth/native/revoke' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleNativeAuthRevoke(req, res);
        return;
      }

      // Garmin watch pairing: the phone/web app mints a short code
      // (/api/watch/pair-code), the watch exchanges it for a mobile token pair
      // (/api/watch/pair).
      if (pathname === '/api/watch/pair-code' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleWatchPairCode(req, res);
        return;
      }
      if (pathname === '/api/watch/pair' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleWatchPair(req, res);
        return;
      }

      // External-platform integration OAuth (browser navigations from the
      // mobile in-app browser). Path: /integrations/<provider>/{start,callback}.
      if (pathname.startsWith('/integrations/') && req.method === 'GET') {
        const segments = pathname.slice('/integrations/'.length).split('/');
        const provider = segments[0];
        const action = segments[1];
        if (provider && action === 'start') {
          await handleIntegrationOAuthStart(req, res, provider, url);
          return;
        }
        if (provider && action === 'callback') {
          await handleIntegrationOAuthCallback(req, res, provider, url);
          return;
        }
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
      if (
        isClientAbortError(error, {
          requestDestroyed: req.destroyed,
          responseDestroyed: res.destroyed,
          socketDestroyed: res.socket?.destroyed,
        })
      ) {
        logger.info('Request aborted by client', { method: req.method, url: req.url });
        return;
      }
      logger.error('Request handler error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  }

  // Create HTTP or HTTPS server with custom request handler.
  // DEV_HTTPS_CERT_FILE / DEV_HTTPS_KEY_FILE are injected by the dev
  // orchestrator when it provisions a Tailscale cert so phones can reach the
  // dev backend over a secure context (required for DeviceMotion, Bluetooth,
  // etc. in mobile browsers). In any other environment both are unset and
  // we fall through to plain HTTP.
  const certFile = process.env.DEV_HTTPS_CERT_FILE;
  const keyFile = process.env.DEV_HTTPS_KEY_FILE;
  const tlsEnabled = !!(certFile && keyFile);
  const httpServer = tlsEnabled
    ? createHttpsServer({ cert: readFileSync(certFile!), key: readFileSync(keyFile!) }, handleRequest)
    : createServer(handleRequest);

  // Setup WebSocket server for GraphQL subscriptions (includes ping/pong heartbeat)
  const { wss, pingInterval } = setupWebSocketServer(httpServer);

  // Track intervals for cleanup
  const intervals: NodeJS.Timeout[] = [pingInterval];

  logger.info(`Boardsesh Backend starting on port ${PORT}...`);
  // Whether this process reports to the production Sentry/PostHog projects is
  // inferred, not configured (see @boardsesh/db/client/config), so say the answer
  // out loud at boot: a developer chasing a missing event shouldn't have to guess
  // whether the SDK is off or the event never fired.
  const sentryEnvironment = resolveSentryEnvironment();
  logger.info(
    isProductionSentryEnvironment()
      ? `Sentry environment: ${sentryEnvironment}`
      : `Sentry environment: ${sentryEnvironment} (reporting disabled — not the production runtime)`,
  );

  // Start HTTP server (WebSocket server is attached to it)
  const httpScheme = tlsEnabled ? 'https' : 'http';
  const wsScheme = tlsEnabled ? 'wss' : 'ws';
  httpServer.listen(PORT, () => {
    logger.info(`Boardsesh Backend is running on port ${PORT}${tlsEnabled ? ' (TLS)' : ''}`);
    logger.info(`  GraphQL HTTP: ${httpScheme}://0.0.0.0:${PORT}/graphql`);
    logger.info(`  GraphQL WS: ${wsScheme}://0.0.0.0:${PORT}/graphql`);
    logger.info(`  Health check: ${httpScheme}://0.0.0.0:${PORT}/health`);
    logger.info(`  Database health: ${httpScheme}://0.0.0.0:${PORT}/health/db`);
    logger.info(`  Join session: ${httpScheme}://0.0.0.0:${PORT}/join/:sessionId`);
    logger.info(`  Avatar upload: ${httpScheme}://0.0.0.0:${PORT}/api/avatars`);
    logger.info(`  Avatar files: ${httpScheme}://0.0.0.0:${PORT}/static/avatars/`);
    logger.info(`  Gym logo upload: ${httpScheme}://0.0.0.0:${PORT}/api/gym-logos`);
    logger.info(`  Gym logo files: ${httpScheme}://0.0.0.0:${PORT}/static/gym-logos/`);
    logger.info(`  Gym photo upload: ${httpScheme}://0.0.0.0:${PORT}/api/gym-photos`);
    logger.info(`  Gym photo files: ${httpScheme}://0.0.0.0:${PORT}/static/gym-photos/`);
    logger.info(`  OCR test data: ${httpScheme}://0.0.0.0:${PORT}/api/ocr-test-data`);
    logger.info(`  PostHog proxy: ${httpScheme}://0.0.0.0:${PORT}/api/posthog/*`);
    logger.info(`  User data export: ${httpScheme}://0.0.0.0:${PORT}/api/user-data-export`);
    logger.info(`  CNC worker API: ${httpScheme}://0.0.0.0:${PORT}/api/cnc/worker/claim`);
    logger.info(`  CNC pack download: ${httpScheme}://0.0.0.0:${PORT}/api/cnc/packs/:licenceId/download`);
    logger.info(`  CNC artwork upload: ${httpScheme}://0.0.0.0:${PORT}/api/cnc/art`);
    logger.info(`  Aurora credentials: ${httpScheme}://0.0.0.0:${PORT}/api/aurora-credentials`);
    logger.info(`  Aurora import: ${httpScheme}://0.0.0.0:${PORT}/api/aurora-import`);
    logger.info(`  MoonBoard import: ${httpScheme}://0.0.0.0:${PORT}/api/moonboard-import`);
    logger.info(`  Kilter credential OAuth: ${httpScheme}://0.0.0.0:${PORT}/board-credentials/kilter/start`);
    logger.info(`  Kilter credential password: ${httpScheme}://0.0.0.0:${PORT}/api/board-credentials/kilter/password`);
    logger.info(`  Widget navigate: ${httpScheme}://0.0.0.0:${PORT}/api/widget/navigate`);
    logger.info(`  Widget take-control: ${httpScheme}://0.0.0.0:${PORT}/api/widget/take-control`);
    logger.info(`  Native auth exchange: ${httpScheme}://0.0.0.0:${PORT}/auth/native/exchange`);
    logger.info(`  Native auth credentials: ${httpScheme}://0.0.0.0:${PORT}/auth/native/credentials`);
    logger.info(`  Native auth register: ${httpScheme}://0.0.0.0:${PORT}/auth/native/register`);
    logger.info(`  Native auth oauth: ${httpScheme}://0.0.0.0:${PORT}/auth/native/oauth`);
    logger.info(`  Native auth refresh: ${httpScheme}://0.0.0.0:${PORT}/auth/native/refresh`);
    logger.info(`  Native auth revoke: ${httpScheme}://0.0.0.0:${PORT}/auth/native/revoke`);
    logger.info(`  Integration OAuth start: ${httpScheme}://0.0.0.0:${PORT}/integrations/:provider/start`);
    logger.info(`  Integration OAuth callback: ${httpScheme}://0.0.0.0:${PORT}/integrations/:provider/callback`);

    // Warm up popular board configs cache in the background.
    // Uses a Redis lock so only one node across the cluster runs the query.
    warmPopularConfigsCache().catch((err) => {
      logger.error('[Server] Popular configs cache warm-up failed:', err);
    });

    // Warm the recent-beta-links cache the same way. The underlying CTE was
    // slow enough in production to starve the DB pool — caching it in Redis
    // moves the cost off the request path.
    warmRecentBetaLinksCache().catch((err) => {
      logger.error('[Server] Recent beta links cache warm-up failed:', err);
    });
  });

  httpServer.on('error', (error) => {
    logger.error('HTTP server error:', error);
  });

  /**
   * Clean up intervals and timers on shutdown
   */
  function cleanupIntervals(): void {
    logger.info(`[Server] Cleaning up ${intervals.length} intervals`);
    intervals.forEach((interval) => clearInterval(interval));
    intervals.length = 0;
  }

  /**
   * Shutdown services (EventBroker + RoomManager).
   * Called by the centralized shutdown handler in index.ts.
   */
  async function shutdownServices(): Promise<void> {
    eventBroker.shutdown();

    // Detach the board-queue-preview producer first: it clears any pending
    // debounce timers, so no preview publish can race the Redis/DB teardown
    // below (the timers are unref'd, but unref only stops them holding the
    // process open — they'd still fire during a graceful shutdown).
    try {
      unregisterBoardQueuePreviewHook();
    } catch (error) {
      logger.error('[Server] Error unregistering board-queue-preview hook:', error);
    }

    if (apnsInstanceConfigInterval !== null) {
      clearInterval(apnsInstanceConfigInterval);
      apnsInstanceConfigInterval = null;
    }

    try {
      stopRefreshTokenCleanup();
    } catch (error) {
      logger.error('[Server] Error stopping refresh token cleanup:', error);
    }

    try {
      stopApnsHeartbeat();
    } catch (error) {
      logger.error('[Server] Error stopping APNs heartbeat:', error);
    }

    try {
      stopApnsStaleTokenCleanup();
    } catch (error) {
      logger.error('[Server] Error stopping APNs cleanup:', error);
    }

    try {
      await shutdownApns();
      logger.info('[Server] APNs shutdown complete');
    } catch (error) {
      logger.error('[Server] Error during APNs shutdown:', error);
    }

    try {
      await roomManager.shutdown();
      logger.info('[Server] RoomManager shutdown complete');
    } catch (error) {
      logger.error('[Server] Error during RoomManager shutdown:', error);
    }
  }

  // Periodic flush as backup (every 60 seconds)
  const flushInterval = setInterval(async () => {
    try {
      await roomManager.flushPendingWrites();
    } catch (error) {
      logger.error('[Server] Error in periodic flush:', error);
    }
  }, 60000);
  intervals.push(flushInterval);

  // Periodic TTL refresh for active sessions (every 2 minutes)
  const ttlRefreshInterval = setInterval(async () => {
    try {
      if (redisClientManager.isRedisConnected()) {
        await roomManager.refreshActiveSessionTTLs();
      }
    } catch (error) {
      logger.error('[Server] Error in periodic TTL refresh:', error);
    }
  }, 120000); // 2 minutes
  intervals.push(ttlRefreshInterval);

  // Prune sync-deletion tombstones past their retention window (see
  // sync-deletions-prune.ts). Every delete of a tick/favorite/playlist writes a
  // tombstone via DB trigger, so without this the table grows forever. Daily
  // cadence, plus one run shortly after boot so frequently-redeployed instances
  // still prune; the job is idempotent and safe to run from every instance.
  const runSyncDeletionsPrune = async () => {
    try {
      const prunedCount = await pruneSyncDeletions();
      if (prunedCount > 0) logger.info(`[Sync] Pruned ${prunedCount} expired sync_deletions tombstones`);
    } catch (error) {
      logger.error('[Sync] sync_deletions prune failed:', error);
    }
  };
  const initialPruneDelay = setTimeout(() => void runSyncDeletionsPrune(), 5 * 60 * 1000);
  if (typeof initialPruneDelay.unref === 'function') initialPruneDelay.unref();
  // Node Timeouts clear with clearInterval too, so the one-shot delay joins the
  // same cleanup list — a shutdown inside the 5-minute window must not fire the
  // prune against a closing DB pool.
  intervals.push(initialPruneDelay);
  const syncDeletionsPruneInterval = setInterval(() => void runSyncDeletionsPrune(), 24 * 60 * 60 * 1000);
  intervals.push(syncDeletionsPruneInterval);

  return { wss, httpServer, cleanupIntervals, shutdownServices };
}
