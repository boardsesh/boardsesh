import { createYoga } from 'graphql-yoga';
import type { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { schema } from './index';
import { validateAuthToken } from '../middleware/auth';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { maxDepthPlugin } from '@escape.tech/graphql-armor-max-depth';
import { costLimitPlugin } from '@escape.tech/graphql-armor-cost-limit';
import { cacheHeadersPlugin } from './cache-headers-plugin';

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
    plugins: [
      maxDepthPlugin({ n: 10 }),
      costLimitPlugin({ maxCost: 5000 }),
      cacheHeadersPlugin(),
    ],
    // Context function - extract auth from HTTP requests
    // HTTP requests are stateless and don't need to be tracked in the connections Map.
    // Only WebSocket connections are stored there (they have onDisconnect cleanup).
    context: async ({ request }): Promise<ConnectionContext> => {
      // Extract Authorization header
      const authHeader = request.headers.get('authorization');
      const cookieHeader = request.headers.get('cookie') ?? undefined;

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        // Dual validation: tries Better Auth first, falls back to NextAuth JWE
        const authResult = await validateAuthToken(token, cookieHeader);

        if (authResult) {
          return {
            connectionId: `http-${uuidv4()}`,
            sessionId: undefined,
            userId: authResult.userId,
            isAuthenticated: true,
          };
        }
      }

      // Also check for cookie-based Better Auth sessions (no Bearer token needed)
      if (cookieHeader?.includes('better-auth.session_token')) {
        const authResult = await validateAuthToken('', cookieHeader);
        if (authResult) {
          return {
            connectionId: `http-${uuidv4()}`,
            sessionId: undefined,
            userId: authResult.userId,
            isAuthenticated: true,
          };
        }
      }

      return {
        connectionId: `http-${uuidv4()}`,
        sessionId: undefined,
        userId: undefined,
        isAuthenticated: false,
      };
    },
    // Disable GraphiQL in production
    graphiql: process.env.NODE_ENV !== 'production'
      ? {
          subscriptionsProtocol: 'WS',
        }
      : false,
    // Disable CORS - we handle it manually in the request router
    cors: false,
    // Logging - suppress debug entirely (Yoga internals like "Parsing request" are noisy)
    logging: {
      debug: () => {},
      info: (...args: unknown[]) => console.log('[Yoga]', ...args),
      warn: (...args: unknown[]) => console.warn('[Yoga]', ...args),
      error: (...args: unknown[]) => console.error('[Yoga]', ...args),
    },
    // In development/test, show all errors
    // In production, errors will be masked by default
    maskedErrors: process.env.NODE_ENV === 'production',
  });

  return yoga;
}
