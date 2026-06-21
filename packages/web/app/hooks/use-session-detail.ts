'use client';

import { useQuery } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_SESSION_DETAIL, type GetSessionDetailQueryResponse } from '@boardsesh/graphql/operations/activity-feed';
import type { SessionDetail } from '@boardsesh/shared-schema';

export const SESSION_DETAIL_QUERY_KEY = (sessionId: string) => ['sessionDetail', sessionId] as const;

type UseSessionDetailOptions = {
  sessionId?: string;
  initialData?: SessionDetail | null;
  enabled?: boolean;
};

export function useSessionDetail({ sessionId, initialData, enabled = true }: UseSessionDetailOptions) {
  const { token, isAuthenticated } = useWsAuthToken();
  const queryKey = SESSION_DETAIL_QUERY_KEY(sessionId ?? '');

  const query = useQuery<SessionDetail | null>({
    queryKey,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetSessionDetailQueryResponse>(GET_SESSION_DETAIL, {
        sessionId,
      });
      return data.sessionDetail;
    },
    enabled: enabled && !!sessionId && isAuthenticated && !!token,
    staleTime: 30_000,
    // Live updates arrive via SessionStatsUpdated cache patches, so a
    // window-focus refetch would only race the WS feed and reintroduce flicker.
    refetchOnWindowFocus: false,
    ...(initialData
      ? {
          initialData,
          initialDataUpdatedAt: Date.now(),
        }
      : {}),
  });

  return {
    session: enabled ? (query.data ?? null) : (initialData ?? null),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
