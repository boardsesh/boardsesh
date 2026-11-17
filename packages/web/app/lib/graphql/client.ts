import { CLIENT_PLATFORM_HEADER } from '@boardsesh/shared-schema';
import { type RequestDocument, type Variables, GraphQLClient } from 'graphql-request';
import { getGraphQLHttpUrl as _getGraphQLHttpUrl } from '@/app/lib/backend-url';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';
import { guardedFetch } from '@/app/lib/auth/session-guard';

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
    ...webClientIdentityHeaders(),
    [CLIENT_PLATFORM_HEADER]: 'web',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  if (DEBUG) {
    console.info(`[GraphQL HTTP] Creating client for ${url} (authenticated: ${!!authToken})`);
  }

  // Server renders already forward their own admitted lease. Browser clients
  // go through the session guard: a response that lands after the account
  // changed rejects with SessionSupersededError instead of reaching the caller.
  if (typeof window === 'undefined') return new GraphQLClient(url, { headers });
  return new GraphQLClient(url, { headers, fetch: guardedFetch });
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
