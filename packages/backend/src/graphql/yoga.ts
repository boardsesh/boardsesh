import { createYoga } from 'graphql-yoga';
import { v4 as uuidv4 } from 'uuid';
import { GraphQLError } from 'graphql';
import * as Sentry from '@sentry/node';
import { schema } from './index';
import { validateNextAuthToken } from '../middleware/auth';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { maxDepthPlugin } from '@escape.tech/graphql-armor-max-depth';
import { costLimitPlugin } from '@escape.tech/graphql-armor-cost-limit';
import { readDistinctIdHeader } from '../analytics/server-analytics';

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

      const distinctId = readDistinctIdHeader(request.headers);

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const authResult = await validateNextAuthToken(token);

        if (authResult) {
          return {
            connectionId: `http-${uuidv4()}`,
            sessionId: undefined,
            userId: authResult.userId,
            isAuthenticated: true,
            clientIp,
            distinctId,
          };
        }
      }

      return {
        connectionId: `http-${uuidv4()}`,
        sessionId: undefined,
        userId: undefined,
        isAuthenticated: false,
        clientIp,
        distinctId,
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
      info: (...args: unknown[]) => console.info('[Yoga]', ...args),
      warn: (...args: unknown[]) => console.warn('[Yoga]', ...args),
      error: (...args: unknown[]) => {
        console.error('[Yoga]', ...args);
        // Skip GraphQLErrors triggered purely by client input (no originalError):
        // validation, parse, depth/cost limit, auth — high volume, low signal.
        for (const arg of args) {
          if (!(arg instanceof Error)) continue;
          if (arg instanceof GraphQLError && !arg.originalError) continue;
          Sentry.captureException(arg, { tags: { source: 'graphql-yoga' } });
        }
      },
    },
    // In development/test, show all errors
    // In production, errors will be masked by default
    maskedErrors: process.env.NODE_ENV === 'production',
  });

  return yoga;
}
