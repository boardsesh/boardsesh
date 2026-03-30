import type { Plugin } from 'graphql-yoga';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Cache control rules for GraphQL operations.
 *
 * Maps operation names to their Cache-Control header values.
 * User-specific queries get private/no-cache, public queries get
 * appropriate max-age values.
 */
const CACHE_RULES: Record<string, string> = {
  // Public queries with long cache durations
  grades: 'public, max-age=86400', // 1 day
  angles: 'public, max-age=86400', // 1 day
  discoverPlaylists: 'public, max-age=300', // 5 minutes
  resolveSlug: 'public, max-age=31536000, immutable', // 1 year (slugs don't change)
  climbStats: 'public, max-age=3600', // 1 hour
  climbBetaLinks: 'public, max-age=3600', // 1 hour
  setters: 'public, max-age=3600', // 1 hour
  climbDetail: 'public, max-age=3600', // 1 hour
  climbRedirect: 'public, max-age=3600', // 1 hour
};

/**
 * Operations that are always user-specific (private, no-cache)
 */
const USER_SPECIFIC_OPS = new Set([
  'profile',
  'auroraCredentials',
  'auroraCredential',
  'favorites',
  'ticks',
  'userPlaylists',
  'allUserPlaylists',
  'userFavoriteClimbs',
  'userFavoritesCounts',
  'userActiveBoards',
  'myControllers',
  'unsyncedAuroraCredentials',
  'userBoardMappings',
  'holdClassifications',
  'notifications',
  'unreadNotificationCount',
  'groupedNotifications',
  'mySessions',
  'myBoards',
  'myGyms',
  'myRoles',
  'myNewClimbSubscriptions',
  'activityFeed',
  'auroraGetLogbook',
]);

/**
 * Determines if a searchClimbs query has filters applied.
 * If no filters are applied, it can be cached longer.
 */
function isFilteredSearchClimbs(variables: Record<string, unknown> | undefined): boolean {
  if (!variables) return false;
  const input = variables.input as Record<string, unknown> | undefined;
  if (!input) return false;

  // Check for any filter parameters that would make this a filtered query
  return !!(
    input.name ||
    input.setter ||
    input.setterId ||
    input.onlyBenchmarks ||
    input.onlyTallClimbs ||
    input.holdsFilter ||
    input.hideAttempted ||
    input.hideCompleted ||
    input.showOnlyAttempted ||
    input.showOnlyCompleted
  );
}

/**
 * Resolves Cache-Control value for a given operation name and variables.
 */
function getCacheControl(
  operationName: string,
  variables: Record<string, unknown> | undefined,
): string | undefined {
  // Check for user-specific operations
  if (USER_SPECIFIC_OPS.has(operationName)) {
    return 'private, no-cache';
  }

  // Special handling for searchClimbs
  if (operationName === 'searchClimbs') {
    const isFiltered = isFilteredSearchClimbs(variables);
    return isFiltered ? 'public, max-age=3600' : 'public, max-age=2592000';
  }

  // Apply static cache rules
  return CACHE_RULES[operationName];
}

/** Shape of the serverContext Yoga passes for Node.js HTTP */
interface NodeServerContext {
  req: IncomingMessage;
  res: ServerResponse;
}

/**
 * GraphQL Yoga plugin that sets Cache-Control response headers
 * based on the operation being executed.
 */
export function cacheHeadersPlugin(): Plugin<ConnectionContext> {
  return {
    onResultProcess({ request, serverContext }) {
      try {
        let operationName: string | undefined;
        let variables: Record<string, unknown> | undefined;

        if (request.method === 'GET') {
          const url = new URL(request.url);
          operationName = url.searchParams.get('operationName') || undefined;
          const varsStr = url.searchParams.get('variables');
          if (varsStr) {
            try {
              variables = JSON.parse(varsStr) as Record<string, unknown>;
            } catch {
              // ignore
            }
          }
        } else if (request.method === 'POST') {
          // For POST requests, try to get operationName from the request URL
          // (some clients include it as a query param even for POST)
          const url = new URL(request.url);
          operationName = url.searchParams.get('operationName') || undefined;
        }

        if (!operationName) return;

        const cacheControl = getCacheControl(operationName, variables);
        if (!cacheControl) return;

        // Set the Cache-Control header on the Node.js response
        const ctx = serverContext as unknown as NodeServerContext | undefined;
        if (ctx?.res && typeof ctx.res.setHeader === 'function') {
          ctx.res.setHeader('Cache-Control', cacheControl);
        }
      } catch {
        // Don't fail the request if cache header logic errors
      }
    },
  };
}
