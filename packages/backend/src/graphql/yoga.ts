import { createYoga } from 'graphql-yoga';
import { v4 as uuidv4 } from 'uuid';
import { GraphQLError } from 'graphql';
import * as Sentry from '@sentry/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { schema } from './index';
import { validateToken } from '../middleware/auth';
import { authenticateCronBearer } from '../middleware/cron-auth';
import type { AuthResult } from '../middleware/auth';
import { resolveWebSocketClientIp } from '../websocket/client-ip';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { maxDepthPlugin } from '@escape.tech/graphql-armor-max-depth';
import { costLimitPlugin } from '@escape.tech/graphql-armor-cost-limit';
import { isLocalDevelopment, isTestEnvironment } from '@boardsesh/db/client/config';
import { logger } from '../utils/logger';
import { wasErrorReported } from '../utils/sentry-dedupe';
import { maskDatabaseError } from './mask-error';

async function authenticateHttpBearer(authHeader: string | null): Promise<AuthResult | null> {
  if (!authHeader) return null;

  const bearerMatch = /^Bearer(?:\s+(.*))?$/i.exec(authHeader.trim());
  if (!bearerMatch) return null;

  const token = bearerMatch[1]?.trim() ?? '';
  // Preserve the deployed transport contract: an invalid or expired optional
  // credential degrades to anonymous so public operations remain available.
  return token ? validateToken(token) : null;
}

/**
 * Node server context Yoga hands to the context factory.
 *
 * `server.ts` serves `/graphql` with `yoga.handle(req, res)`, so the Node
 * request (and its TCP socket) is available on every real HTTP request. The
 * `yoga.fetch` path — used by tests and by any non-Node adapter — supplies
 * neither, hence both are optional.
 */
type NodeServerContext = { req?: IncomingMessage; res?: ServerResponse };

/**
 * Build the connection context for an HTTP GraphQL request.
 *
 * Exported so tests can drive the exact shape Yoga passes in. HTTP requests are
 * stateless and are not tracked in the connections Map; only WebSocket
 * connections are stored there (they have onDisconnect cleanup).
 *
 * The anonymous rate-limit identity comes from `resolveWebSocketClientIp`, the
 * same trusted-hop resolver the WebSocket transport uses (issue #4034):
 * `cf-connecting-ip` -> LAST `x-forwarded-for` hop -> `req.socket.remoteAddress`
 * -> undefined. Two bypasses this closes, both live before it:
 *
 *  - the FIRST forwarded hop is client-authored (Cloudflare appends rather than
 *    strips), so a scripted client could send `x-forwarded-for: <random>` per
 *    request and mint a fresh `applyRateLimit` bucket every time — or pin a
 *    victim's IP to exhaust theirs.
 *  - a direct-to-origin client sending no proxy headers at all resolved to
 *    `undefined` and fell through to the per-request `http-<uuid>` bucket, which
 *    is no limit at all. The socket fallback keys it on the real peer.
 *
 * `x-real-ip` is deliberately no longer consulted: nothing in our chain sets it,
 * so it was pure spoof surface.
 *
 * When no IP resolves (the `yoga.fetch` path) `clientIp` stays undefined and
 * `applyRateLimit` falls back to the connectionId branch, exactly as before.
 */
export async function buildHttpConnectionContext({
  request,
  req,
}: { request: Request } & NodeServerContext): Promise<ConnectionContext> {
  const authHeader = request.headers.get('authorization');
  const clientIp = resolveWebSocketClientIp(req);

  const isCronAuthenticated = authenticateCronBearer(authHeader);
  const authResult = isCronAuthenticated ? null : await authenticateHttpBearer(authHeader);

  return {
    connectionId: `http-${uuidv4()}`,
    transport: 'http' as const,
    sessionId: undefined,
    userId: authResult?.userId,
    isAuthenticated: authResult !== null,
    isCronAuthenticated,
    clientIp,
  };
}

/**
 * Create and configure the GraphQL Yoga instance
 *
 * Note: This Yoga instance is primarily used for HTTP GraphQL requests.
 * WebSocket subscriptions use graphql-ws directly with the same schema
 * to maintain protocol compatibility with the frontend.
 */
export function createYogaInstance() {
  const yoga = createYoga<NodeServerContext>({
    schema,
    graphqlEndpoint: '/graphql',
    // Depth/cost limiting for HTTP GraphQL requests.
    // WebSocket subscriptions are protected separately via onSubscribe in websocket/setup.ts
    plugins: [maxDepthPlugin({ n: 10 }), costLimitPlugin({ maxCost: 5000 })],
    // Context function - extract auth and the trusted client IP from HTTP requests.
    // `req` is the Node request `server.ts` hands to `yoga.handle`; it carries the
    // TCP socket the client cannot forge.
    context: ({ request, req }): Promise<ConnectionContext> => buildHttpConnectionContext({ request, req }),
    // Disable GraphiQL in production
    graphiql:
      process.env.NODE_ENV !== 'production'
        ? {
            subscriptionsProtocol: 'WS',
          }
        : false,
    // Disable CORS - we handle it manually in the request router
    cors: false,
    // Logging - suppress debug entirely (Yoga internals like "Parsing request" are noisy)
    logging: {
      debug: () => {},
      info: (...args: unknown[]) => logger.info('[Yoga]', ...args),
      warn: (...args: unknown[]) => logger.warn('[Yoga]', ...args),
      error: (...args: unknown[]) => {
        // Stringify any Error in the splat before handing to logger.error so
        // the SentryWinstonTransport doesn't fire — this handler runs its own
        // noise-filtered capture loop below for client-input GraphQLErrors,
        // and we don't want the transport to bypass that filter.
        const stringifiedArgs = args.map((arg) =>
          arg instanceof Error ? (arg.stack ?? `${arg.name}: ${arg.message}`) : arg,
        );
        logger.error('[Yoga]', ...stringifiedArgs);
        // Skip GraphQLErrors triggered purely by client input (no originalError):
        // validation, parse, depth/cost limit, auth — high volume, low signal.
        for (const arg of args) {
          if (!(arg instanceof Error)) continue;
          if (arg instanceof GraphQLError && !arg.originalError) continue;
          // A resolver already reported this with finer-grained tags/context
          // (e.g. createSession); don't emit a duplicate event.
          if (wasErrorReported(arg)) continue;
          Sentry.captureException(arg, { tags: { source: 'graphql-yoga' } });
        }
      },
    },
    // In local dev / tests, show all errors raw for debugging. In any prod-like
    // deploy (Railway leaves NODE_ENV unset, so a `=== 'production'` gate was
    // silently off — issue #3183), enable a TARGETED mask: it sanitizes only
    // raw database errors so internal SQL never leaks to clients, and lets
    // every other error through unchanged (see mask-error.ts).
    maskedErrors: !isLocalDevelopment() && !isTestEnvironment() ? { maskError: maskDatabaseError } : false,
  });

  return yoga;
}
