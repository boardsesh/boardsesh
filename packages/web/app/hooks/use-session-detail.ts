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
    // The server-rendered copy is the signed-out projection, so it is stale
    // from the start: a signed-in viewer refetches as soon as their token is in,
    // and a fellow member of the session then sees everyone in it by name. The
    // query stays disabled for a signed-out viewer, who keeps the copy.
    ...(initialData
      ? {
          initialData,
          initialDataUpdatedAt: 0,
        }
      : {}),
  });

  return {
    session: enabled ? (query.data ?? null) : (initialData ?? null),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
