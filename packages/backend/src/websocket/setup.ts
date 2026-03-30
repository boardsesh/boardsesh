import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { useServer, type Extra as WsExtra } from 'graphql-ws/use/ws';
import type { Context as GqlWsContext } from 'graphql-ws';
import { GraphQLError, parse } from 'graphql';
import { schema } from '../graphql/index';
import { createContext, removeContext, getContext } from '../graphql/context';
import { validateQueryDepth } from '../graphql/query-depth';
import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';
import { validateNextAuthToken, extractAuthToken, extractBetterAuthSessionToken, extractControllerApiKey, validateControllerApiKey } from '../middleware/auth';
import { validateBetterAuthSession } from '../auth/index';
import { isOriginAllowed } from '../handlers/cors';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const DEBUG = process.env.NODE_ENV === 'development';

// Extend Extra type with our custom context
interface CustomExtra extends WsExtra {
  context?: ConnectionContext;
  [key: PropertyKey]: unknown;
}

// Type alias for convenience
type ServerContext = GqlWsContext<Record<string, unknown>, CustomExtra>;

/**
 * Setup WebSocket server with graphql-ws for GraphQL subscriptions
 *
 * @param httpServer The HTTP server to attach the WebSocket server to
 * @returns The WebSocket server instance
 */
export function setupWebSocketServer(httpServer: HttpServer): WebSocketServer {
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

      // Check if origin is in allowed list or matches Vercel preview pattern
      if (isOriginAllowed(origin)) {
        callback(true);
        return;
      }

      console.warn(`[WebSocket] Rejected connection from unauthorized origin: ${origin}`);
      callback(false, 403, 'Origin not allowed');
    },
  });

  // Use graphql-ws server
  useServer<Record<string, unknown>, CustomExtra>(
    {
      schema,
      // onConnect is called ONCE when client connects and sends ConnectionInit
      onConnect: async (ctx: ServerContext) => {
        const connectionParams = ctx.connectionParams as Record<string, unknown> | undefined;

        let isAuthenticated = false;
        let authenticatedUserId: string | undefined;

        // Strategy 1: Try Better Auth session token from connection params
        const betterAuthToken = extractBetterAuthSessionToken(connectionParams);
        if (betterAuthToken) {
          const result = await validateBetterAuthSession(betterAuthToken);
          if (result) {
            isAuthenticated = true;
            authenticatedUserId = result.userId;
            console.log(`[Auth] Authenticated user via Better Auth: ${authenticatedUserId}`);
          }
        }

        // Strategy 2: Fall back to NextAuth JWE token
        if (!isAuthenticated) {
          const token = extractAuthToken(
            connectionParams,
            ctx.extra.request?.url,
          );

          if (token) {
            const authResult = await validateNextAuthToken(token);
            if (authResult) {
              isAuthenticated = true;
              authenticatedUserId = authResult.userId;
              console.log(`[Auth] Authenticated user via NextAuth: ${authenticatedUserId}`);
            }
          }
        }

        // Check for controller API key authentication
        let controllerId: string | undefined;
        let controllerApiKey: string | undefined;
        let controllerMac: string | undefined;
        const extractedControllerApiKey = extractControllerApiKey(connectionParams);

        if (extractedControllerApiKey) {
          const controllerResult = await validateControllerApiKey(extractedControllerApiKey);
          if (controllerResult) {
            controllerId = controllerResult.controllerId;
            controllerApiKey = controllerResult.controllerApiKey;
            console.log(`[Auth] Authenticated controller: ${controllerId}`);
          }
        }

        // Extract controller MAC address from connection params (used as clientId for BLE disconnect logic)
        if (connectionParams?.controllerMac && typeof connectionParams.controllerMac === 'string') {
          controllerMac = connectionParams.controllerMac;
          console.log(`[Auth] Controller MAC: ${controllerMac}`);
        }

        // Create context on initial connection with auth info
        const context = createContext(undefined, isAuthenticated, authenticatedUserId, controllerId, controllerApiKey, controllerMac);
        await roomManager.registerClient(context.connectionId, undefined, authenticatedUserId);
        console.log(`Client connected: ${context.connectionId} (authenticated: ${isAuthenticated})`);

        // Store context in ctx.extra for access in other hooks
        (ctx.extra as CustomExtra).context = context;

        return true; // Allow connection (both authenticated and unauthenticated)
      },
      // context is called for EACH operation - return the stored context
      context: async (ctx: ServerContext): Promise<ConnectionContext> => {
        const extra = ctx.extra as CustomExtra;

        if (!extra.context) {
          // This should never happen - onConnect should always set context
          console.error('[Context] CRITICAL: No context in extra - onConnect may have failed');
          throw new Error('Connection context not initialized - onConnect may have failed');
        }

        // Get the latest context (it may have been updated by mutations like joinSession)
        const latestContext = getContext(extra.context.connectionId);

        if (!latestContext) {
          console.error(`[Context] Context lost for connection ${extra.context.connectionId}`);
          throw new Error(`Connection context lost for ${extra.context.connectionId}`);
        }

        if (DEBUG) {
          console.log(`[Context] Retrieved context: ${latestContext.connectionId}, sessionId: ${latestContext.sessionId}`);
        }
        return latestContext;
      },
      onDisconnect: async (ctx: ServerContext, code?: number) => {
        const context = (ctx.extra as CustomExtra)?.context;
        if (context) {
          console.log(`Client disconnected: ${context.connectionId} (code: ${code})`);

          // Get the latest context state (sessionId may have been updated)
          const latestContext = getContext(context.connectionId);

          // Handle session cleanup
          if (latestContext?.sessionId) {
            const result = await roomManager.leaveSession(context.connectionId);

            if (result) {
              // Notify session about user leaving
              if (latestContext.userId) {
                pubsub.publishSessionEvent(result.sessionId, {
                  __typename: 'UserLeft',
                  userId: latestContext.userId,
                });
              }

              // Notify about new leader if changed
              if (result.newLeaderId) {
                pubsub.publishSessionEvent(result.sessionId, {
                  __typename: 'LeaderChanged',
                  leaderId: result.newLeaderId,
                });
              }
            }
          }

          await roomManager.removeClient(context.connectionId);
          removeContext(context.connectionId);
        }
      },
      onSubscribe: (_ctx: ServerContext, _id: string, payload) => {
        if (DEBUG) {
          console.log(`Subscription started: ${payload.operationName || 'anonymous'}`);
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
        console.error('GraphQL error:', errors);
      },
      onComplete: (_ctx: ServerContext, _id: string, payload) => {
        if (DEBUG) {
          console.log(`Subscription completed: ${payload.operationName || 'anonymous'}`);
        }
      },
    },
    wss,
  );

  return wss;
}
