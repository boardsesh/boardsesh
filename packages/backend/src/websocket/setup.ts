import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { useServer, type Extra as WsExtra } from 'graphql-ws/use/ws';
import type { Context as GqlWsContext } from 'graphql-ws';
import { GraphQLError, parse } from 'graphql';
import * as Sentry from '@sentry/node';
import { schema } from '../graphql/index';
import { createContext, removeContext, getContext } from '../graphql/context';
import { validateQueryDepth } from '../graphql/query-depth';
import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';
import { validateToken, extractAuthToken, extractControllerApiKey, validateControllerApiKey } from '../middleware/auth';
import { isOriginAllowed, isSameOriginUpgrade } from '../handlers/cors';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';

const DEBUG = process.env.NODE_ENV === 'development';

/** Ping interval in milliseconds for detecting dead WebSocket connections. */
const WS_PING_INTERVAL_MS = 30_000;

/** WebSocket extended with liveness tracking for ping/pong. */
type AliveWebSocket = {
  isAlive: boolean;
} & WebSocket;

// Extend Extra type with our custom context
type CustomExtra = {
  context?: ConnectionContext;
  [key: PropertyKey]: unknown;
} & WsExtra;

// Type alias for convenience
type ServerContext = GqlWsContext<Record<string, unknown>, CustomExtra>;

/**
 * Setup WebSocket server with graphql-ws for GraphQL subscriptions
 *
 * @param httpServer The HTTP server to attach the WebSocket server to
 * @returns The WebSocket server instance
 */
export function setupWebSocketServer(httpServer: HttpServer): {
  wss: WebSocketServer;
  pingInterval: NodeJS.Timeout;
} {
  // Create WebSocket server on /graphql path with origin validation
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
    verifyClient: (
      info: { origin: string; req: IncomingMessage },
      callback: (res: boolean, code?: number, message?: string) => void,
    ) => {
      const origin = info.origin;

      // Allow connections without origin header (e.g., from native apps or direct WebSocket clients)
      if (!origin) {
        callback(true);
        return;
      }

      // Allow if the origin is on the website allow-list / a preview pattern, OR
      // if it's a genuine same-origin upgrade (Origin host === the host being
      // connected to). The latter unblocks the React Native Android app, whose
      // WebSocket sets Origin from the wss:// URL (https://ws.boardsesh.com),
      // and preview WS hosts — without weakening CSWSH protection. See
      // isSameOriginUpgrade for the security rationale.
      if (isOriginAllowed(origin) || isSameOriginUpgrade(origin, info.req.headers.host)) {
        callback(true);
        return;
      }

      // Remaining rejections are genuinely unauthorized origins. Log attribution
      // (User-Agent + IP) so they can be traced. forwardedFor is forensic only —
      // it is user-controlled and never used for an allow/deny decision.
      logger.warn('[WebSocket] Rejected connection from unauthorized origin', {
        origin,
        host: info.req.headers.host,
        userAgent: info.req.headers['user-agent'],
        forwardedFor: info.req.headers['x-forwarded-for'],
        remoteAddress: info.req.socket.remoteAddress,
      });
      callback(false, 403, 'Origin not allowed');
    },
  });

  // Use graphql-ws server
  useServer<Record<string, unknown>, CustomExtra>(
    {
      schema,
      // onConnect is called ONCE when client connects and sends ConnectionInit
      onConnect: async (ctx: ServerContext) => {
        // Extract and validate auth token
        const token = extractAuthToken(
          ctx.connectionParams as Record<string, unknown> | undefined,
          ctx.extra.request?.url,
        );

        let isAuthenticated = false;
        let authenticatedUserId: string | undefined;

        if (token) {
          const authResult = await validateToken(token);
          if (authResult) {
            isAuthenticated = true;
            authenticatedUserId = authResult.userId;
            logger.info(`[Auth] Authenticated user: ${authenticatedUserId}`);
          }
        }

        // Check for controller API key authentication
        let controllerId: string | undefined;
        let controllerApiKey: string | undefined;
        let controllerMac: string | undefined;
        const connectionParams = ctx.connectionParams as Record<string, unknown> | undefined;
        const extractedControllerApiKey = extractControllerApiKey(connectionParams);

        if (extractedControllerApiKey) {
          const controllerResult = await validateControllerApiKey(extractedControllerApiKey);
          if (controllerResult) {
            controllerId = controllerResult.controllerId;
            controllerApiKey = controllerResult.controllerApiKey;
            logger.info(`[Auth] Authenticated controller: ${controllerId}`);
          }
        }

        // Extract controller MAC address from connection params (used as clientId for BLE disconnect logic)
        if (connectionParams?.controllerMac && typeof connectionParams.controllerMac === 'string') {
          controllerMac = connectionParams.controllerMac;
          logger.info(`[Auth] Controller MAC: ${controllerMac}`);
        }

        // Create context on initial connection with auth info
        const context = createContext(
          undefined,
          isAuthenticated,
          authenticatedUserId,
          controllerId,
          controllerApiKey,
          controllerMac,
        );
        await roomManager.registerClient(context.connectionId, undefined, authenticatedUserId);
        logger.info(`Client connected: ${context.connectionId} (authenticated: ${isAuthenticated})`);

        // Store context in ctx.extra for access in other hooks
        ctx.extra.context = context;

        return true; // Allow connection (both authenticated and unauthenticated)
      },
      // context is called for EACH operation - return the stored context
      context: async (ctx: ServerContext): Promise<ConnectionContext> => {
        const extra = ctx.extra;

        if (!extra.context) {
          // This should never happen - onConnect should always set context
          logger.error('[Context] CRITICAL: No context in extra - onConnect may have failed');
          throw new Error('Connection context not initialized - onConnect may have failed');
        }

        // Get the latest context (it may have been updated by mutations like joinSession)
        const latestContext = getContext(extra.context.connectionId);

        if (!latestContext) {
          logger.error(`[Context] Context lost for connection ${extra.context.connectionId}`);
          throw new Error(`Connection context lost for ${extra.context.connectionId}`);
        }

        if (DEBUG) {
          logger.info(
            `[Context] Retrieved context: ${latestContext.connectionId}, sessionId: ${latestContext.sessionId}`,
          );
        }
        return latestContext;
      },
      onDisconnect: async (ctx: ServerContext, code?: number) => {
        const context = ctx.extra?.context;
        if (context) {
          logger.info(`Client disconnected: ${context.connectionId} (code: ${code})`);

          // Get the latest context state (sessionId may have been updated)
          const latestContext = getContext(context.connectionId);

          // Board-presence crash backstop: if this connection held a board's
          // writer slot, free it (compare-and-delete, no-op once someone else
          // took over). Runs for solo (no-session) holders too, which take the
          // removeClient branch below — so it must be here, the single WS-close
          // chokepoint, and before disconnectClient/removeClient delete the
          // client record it reads. The clean path is the client's BLE-drop
          // reportBoardDisconnect; this only covers crashes.
          await roomManager.clearBoardWriterForConnection(context.connectionId);

          // Handle session cleanup
          if (latestContext?.sessionId) {
            const result = await roomManager.disconnectClient(context.connectionId);

            if (result?.presenceUser) {
              pubsub.publishSessionEvent(result.sessionId, {
                __typename: 'UserPresenceChanged',
                user: result.presenceUser,
              });
            }
            if (result?.newLeaderId) {
              pubsub.publishSessionEvent(result.sessionId, {
                __typename: 'LeaderChanged',
                leaderId: result.newLeaderParticipantId || result.newLeaderId,
                leaderConnectionId: result.newLeaderId,
              });
            }
          } else {
            await roomManager.removeClient(context.connectionId);
          }
          removeContext(context.connectionId);
        }
      },
      onSubscribe: (_ctx: ServerContext, _id: string, payload) => {
        if (DEBUG) {
          logger.info(`Subscription started: ${payload.operationName || 'anonymous'}`);
        }

        // Validate query depth to prevent DoS via deeply nested subscriptions
        if (payload.query) {
          const document = typeof payload.query === 'string' ? parse(payload.query) : payload.query;
          const depthError = validateQueryDepth(document);
          if (depthError) {
            return [new GraphQLError(depthError)];
          }
        }
      },
      onError: (_ctx: ServerContext, _id: string, _payload, errors) => {
        logger.error('GraphQL error:', errors);
        // Only report errors that wrap an internal exception. GraphQLError
        // instances without `originalError` are validation/parse/auth/depth
        // errors triggered by malformed client input — noisy, not actionable.
        for (const err of errors) {
          if (err instanceof GraphQLError && !err.originalError) continue;
          Sentry.captureException(err, { tags: { source: 'graphql-ws' } });
        }
      },
      onComplete: (_ctx: ServerContext, _id: string, payload) => {
        if (DEBUG) {
          logger.info(`Subscription completed: ${payload.operationName || 'anonymous'}`);
        }
      },
    },
    wss,
  );

  // Ping/pong heartbeat to detect dead connections.
  // When a client's network drops silently (phone sleep, WiFi switch, tab killed),
  // the TCP connection becomes half-open and onDisconnect never fires.
  // This interval pings every client; if it doesn't respond before the next ping,
  // the socket is terminated, which triggers onDisconnect and cleans up Redis state.
  wss.on('connection', (ws: WebSocket) => {
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.on('pong', () => {
      aliveWs.isAlive = true;
    });
  });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const aliveWs = ws as AliveWebSocket;
      if (!aliveWs.isAlive) {
        if (DEBUG) logger.info('[WebSocket] Terminating unresponsive connection');
        aliveWs.terminate();
        return;
      }
      aliveWs.isAlive = false;
      aliveWs.ping();
    });
  }, WS_PING_INTERVAL_MS);

  return { wss, pingInterval };
}
