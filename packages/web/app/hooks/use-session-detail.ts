'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SESSION_DETAIL,
  UPDATE_INFERRED_SESSION,
  ADD_USER_TO_SESSION,
  REMOVE_USER_FROM_SESSION,
  type GetSessionDetailQueryResponse,
} from '@/app/lib/graphql/operations/activity-feed';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { persistUser } from '@/app/lib/react-query-persist-meta';

export const SESSION_DETAIL_QUERY_KEY = (sessionId: string) => ['sessionDetail', sessionId] as const;

type UseSessionDetailOptions = {
  sessionId?: string;
  initialData?: SessionDetail | null;
  enabled?: boolean;
};

export function useSessionDetail({ sessionId, initialData, enabled = true }: UseSessionDetailOptions) {
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

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
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    // Live updates arrive via SessionStatsUpdated cache patches, so a
    // window-focus refetch would only race the WS feed and reintroduce flicker.
    refetchOnWindowFocus: false,
    meta: persistUser,
    ...(initialData
      ? {
          initialData,
          initialDataUpdatedAt: Date.now(),
        }
      : {}),
  });

  const updateSession = useMutation({
    mutationFn: async (input: { name: string | null; description: string | null }) => {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<{ updateInferredSession: SessionDetail }>(UPDATE_INFERRED_SESSION, {
        input: { sessionId, ...input },
      });
      return result.updateInferredSession;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      showMessage('Session updated', 'success');
    },
    onError: (err) => {
      console.error('Failed to update session:', err);
      showMessage('Failed to update session', 'error');
    },
  });

  const addUser = useMutation({
    mutationFn: async (userId: string) => {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<{ addUserToSession: SessionDetail }>(ADD_USER_TO_SESSION, {
        input: { sessionId, userId },
      });
      return result.addUserToSession;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      showMessage('User added to session', 'success');
    },
    onError: (err) => {
      console.error('Failed to add user:', err);
      showMessage('Failed to add user to session', 'error');
    },
  });

  const removeUser = useMutation({
    mutationFn: async (userId: string) => {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<{ removeUserFromSession: SessionDetail }>(REMOVE_USER_FROM_SESSION, {
        input: { sessionId, userId },
      });
      return result.removeUserFromSession;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      showMessage('User removed from session', 'success');
    },
    onError: (err) => {
      console.error('Failed to remove user:', err);
      showMessage('Failed to remove user', 'error');
    },
  });

  return {
    session: enabled ? (query.data ?? null) : (initialData ?? null),
    isLoading: query.isLoading,
    isError: query.isError,
    updateSession,
    addUser,
    removeUser,
  };
}
