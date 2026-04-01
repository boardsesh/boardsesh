import React from 'react';
import 'server-only';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import {
  GET_POPULAR_BOARD_CONFIGS,
  type GetPopularBoardConfigsQueryResponse,
} from '@/app/lib/graphql/operations';
import { GraphQLClient } from 'graphql-request';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

/**
 * Fetches popular board configurations server-side via the GraphQL backend.
 * Uses React.cache() for request deduplication within a single server render.
 * Returns empty array if the backend is unavailable (graceful fallback —
 * the client-side hook will fetch on mount).
 */
export const getPopularBoardConfigs = React.cache(async (): Promise<PopularBoardConfig[]> => {
  let url: string;
  try {
    url = getGraphQLHttpUrl();
  } catch {
    // Backend URL not configured (e.g., local dev without backend running)
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const client = new GraphQLClient(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const result = await client.request<GetPopularBoardConfigsQueryResponse>(
      GET_POPULAR_BOARD_CONFIGS,
      { input: { limit: 7, offset: 0 } },
    );
    return result.popularBoardConfigs.configs;
  } catch {
    // Backend unreachable or timed out — client-side hook will retry
    return [];
  } finally {
    clearTimeout(timer);
  }
});
