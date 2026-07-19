import { createYoga } from 'graphql-yoga';
import { v4 as uuidv4 } from 'uuid';
import { GraphQLError } from 'graphql';
import * as Sentry from '@sentry/node';
import { schema } from './index';
import { validateToken } from '../middleware/auth';
import type { AuthResult } from '../middleware/auth';
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
 * Create and configure the GraphQL Yoga instance
 *
 * Note: This Yoga instance is primarily used for HTTP GraphQL requests.
 * WebSocket subscriptions use graphql-ws directly with the same schema
 * to maintain protocol compatibility with the frontend.
 */
export function createYogaInstance() {
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    // Depth/cost limiting for HTTP GraphQL requests.
    // WebSocket subscriptions are protected separately via onSubscribe in websocket/setup.ts
    plugins: [maxDepthPlugin({ n: 10 }), costLimitPlugin({ maxCost: 5000 })],
    // Context function - extract auth from HTTP requests
    // HTTP requests are stateless and don't need to be tracked in the connections Map.
    // Only WebSocket connections are stored there (they have onDisconnect cleanup).
    context: async ({ request }): Promise<ConnectionContext> => {
      // Extract Authorization header
      const authHeader = request.headers.get('authorization');

      // Extract client IP for rate limiting anonymous HTTP requests
      const clientIp =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || undefined;

      const authResult = await authenticateHttpBearer(authHeader);
      if (authResult) {
        return {
          connectionId: `http-${uuidv4()}`,
          transport: 'http' as const,
          sessionId: undefined,
          userId: authResult.userId,
          isAuthenticated: true,
          clientIp,
        };
      }

      return {
        connectionId: `http-${uuidv4()}`,
        transport: 'http' as const,
        sessionId: undefined,
        userId: undefined,
        isAuthenticated: false,
        clientIp,
      };
    },
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
