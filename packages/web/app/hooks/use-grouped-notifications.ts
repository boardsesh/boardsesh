'use client';

import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useWsAuthToken } from './use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_GROUPED_NOTIFICATIONS,
  type GetGroupedNotificationsQueryResponse,
  type GetGroupedNotificationsQueryVariables,
} from '@/app/lib/graphql/operations';
import type { GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';
import { UNREAD_COUNT_QUERY_KEY } from './use-unread-notification-count';
import { persistUser } from '@/app/lib/react-query-persist-meta';

const PAGE_SIZE = 20;

export const GROUPED_NOTIFICATIONS_QUERY_KEY = ['notifications', 'grouped'] as const;

/**
 * Hook to fetch paginated grouped notifications using useInfiniteQuery.
 * Accepts optional `initialData` from SSR to avoid a loading flash.
 */
export function useGroupedNotifications(initialData?: GroupedNotificationConnection) {
  const { token, isAuthenticated } = useWsAuthToken();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery<
    GroupedNotificationConnection,
    Error,
    InfiniteData<GroupedNotificationConnection>,
    typeof GROUPED_NOTIFICATIONS_QUERY_KEY,
    number
  >({
    queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetGroupedNotificationsQueryResponse, GetGroupedNotificationsQueryVariables>(
        GET_GROUPED_NOTIFICATIONS,
        { limit: PAGE_SIZE, offset: pageParam },
      );

      // Sync unread count from the grouped response
      queryClient.setQueryData(UNREAD_COUNT_QUERY_KEY, data.groupedNotifications.unreadCount);

      return data.groupedNotifications;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.groups.length;
    },
    enabled: isAuthenticated && !!token,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    meta: persistUser,
    ...(initialData
      ? {
          initialData: { pages: [initialData], pageParams: [0] },
          initialDataUpdatedAt: Date.now(),
        }
      : {}),
  });

  const groupedNotifications: GroupedNotification[] = useMemo(
    () => query.data?.pages.flatMap((page) => page.groups) ?? [],
    [query.data],
  );

  return {
    groupedNotifications,
    isLoading: query.isLoading,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore: query.fetchNextPage,
  };
}
