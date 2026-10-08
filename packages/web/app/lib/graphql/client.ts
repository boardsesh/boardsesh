import { CLIENT_PLATFORM_HEADER } from '@boardsesh/shared-schema';
import { type RequestDocument, type Variables, GraphQLClient } from 'graphql-request';
import { getGraphQLHttpUrl as _getGraphQLHttpUrl } from '@/app/lib/backend-url';

const DEBUG = process.env.NODE_ENV === 'development';

/**
 * Get the HTTP GraphQL endpoint URL
 * Converts WebSocket URL to HTTP URL if needed
 */
export function getGraphQLHttpUrl(): string {
  return _getGraphQLHttpUrl();
}

/**
 * Create a GraphQL HTTP client for queries and mutations
 * Uses graphql-request for simple HTTP transport
 */
export function createGraphQLHttpClient(authToken?: string | null): GraphQLClient {
  const url = getGraphQLHttpUrl();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [CLIENT_PLATFORM_HEADER]: 'web',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  if (DEBUG) {
    console.info(`[GraphQL HTTP] Creating client for ${url} (authenticated: ${!!authToken})`);
  }

  return new GraphQLClient(url, { headers });
}

/**
 * Execute a GraphQL query or mutation via HTTP
 * This is a convenience wrapper for one-off requests
 */
export async function executeGraphQL<T = unknown, V extends Variables = Variables>(
  document: RequestDocument,
  variables?: V,
  authToken?: string | null,
): Promise<T> {
  const client = createGraphQLHttpClient(authToken);

  if (DEBUG) {
    console.info('[GraphQL HTTP] Executing request');
  }

  return client.request<T>(document, variables);
}
