import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_GROUPED_NOTIFICATIONS,
  GET_NOTIFICATION_ACTORS,
  GET_UNREAD_NOTIFICATION_COUNT,
  MARK_GROUP_NOTIFICATIONS_READ,
  MARK_ALL_NOTIFICATIONS_READ,
  type GetGroupedNotificationsQueryResponse,
  type GetGroupedNotificationsQueryVariables,
  type GetNotificationActorsQueryResponse,
  type GetNotificationActorsQueryVariables,
  type GetUnreadNotificationCountQueryResponse,
  type MarkGroupNotificationsReadMutationResponse,
  type MarkGroupNotificationsReadMutationVariables,
} from '@boardsesh/graphql/operations';
import type {
  GroupedNotification,
  GroupedNotificationConnection,
  NotificationType,
  SocialEntityType,
} from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
// The stored-token read, NOT `useAuth`: this module is re-exported from the
// hooks barrel, and `auth-provider` drags react-native's Flow source into the
// barrel's static graph, which Rolldown's scan refuses (it breaks every suite
// that imports the barrel while mocking only the client). `useAuthToken` is a
// leaf over react-query + the auth store and exists for exactly this gate.
import { useAuthToken } from '../use-auth-token';
// Shared with `use-social`, which invalidates this key after a follow-back.
// Neither file can import the other (see that module's note), so the constant
// lives on its own rather than as a literal in both.
import { NOTIFICATION_ACTORS_QUERY_KEY } from '../notification-actors-key';

/** Groups per page — matches web's `use-grouped-notifications.ts`. */
const PAGE_SIZE = 20;

const NOTIFICATIONS_STALE_TIME_MS = 60 * 1000;

/**
 * Keys stay next to their hooks rather than in `query-keys.ts`: nothing reads
 * either cache imperatively (`queryClient.getQueryData`), which is that file's
 * stated admission rule. The mutations below write through `queryClient`, but
 * they import the keys from this module, so the compiler links them.
 */
export const GROUPED_NOTIFICATIONS_QUERY_KEY = ['notifications', 'grouped'] as const;
export const NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY = ['notifications', 'unreadCount'] as const;

/** The shape React Query stores for the infinite grouped-notifications query. */
type GroupedNotificationPages = { pages: GroupedNotificationConnection[]; pageParams: unknown[] };

/**
 * Paginated grouped notifications — the mobile twin of web's
 * `useGroupedNotifications`. Grouping itself is server-side SQL
 * (`GROUP BY type, entity_type, entity_id` in the backend resolver), so the
 * only client-side assembly is flattening pages at the call site.
 *
 * The queryFn writes the response's `unreadCount` straight into the unread
 * key, so the Home bell's badge settles the moment the list loads instead of
 * waiting for its own request to come back.
 */
export function useGroupedNotifications() {
  const { data: authToken } = useAuthToken();
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const variables: GetGroupedNotificationsQueryVariables = { limit: PAGE_SIZE, offset: Number(pageParam) };
      const response = await getHttpClient().request<
        GetGroupedNotificationsQueryResponse,
        GetGroupedNotificationsQueryVariables
      >(GET_GROUPED_NOTIFICATIONS, variables);

      queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, response.groupedNotifications.unreadCount);

      return response.groupedNotifications;
    },
    // Offset = how many groups we already hold. Equivalent to web's
    // `lastPageParam + lastPage.groups.length` because the resolver derives
    // `hasMore` from `offset + groups.length < totalCount`.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((total, page) => total + page.groups.length, 0) : undefined,
    enabled: !!authToken,
    staleTime: NOTIFICATIONS_STALE_TIME_MS,
  });
}

/** Actors per page. Matches `SOCIAL_PAGE_SIZE` so the follow list scrolls like the others. */
const ACTORS_PAGE_SIZE = 30;

/** The page shape `getNextPageParam` reads — a `FollowConnection` minus the fields it ignores. */
type ActorPage = { users: unknown[]; hasMore: boolean };

/**
 * Offset for the next actor page: how many actors are already held.
 *
 * Exported for its own test because it is wrong-by-one if written from memory,
 * and because of the empty-page guard. The server pages over distinct actor
 * ROWS but returns only actors whose account still resolves, so a page could in
 * principle report `hasMore` while contributing nothing to the offset — and the
 * next fetch would ask for the same window forever. Stopping on an empty page
 * makes that unrepresentable; the alternative is a list that spins at the
 * bottom.
 */
export function nextActorsOffset(lastPage: ActorPage, allPages: ActorPage[]): number | undefined {
  if (!lastPage.hasMore || lastPage.users.length === 0) return undefined;
  return allPages.reduce((total, page) => total + page.users.length, 0);
}

/**
 * Everyone behind one grouped notification, newest first — the follow-back list
 * for "Sarah and 4 others started following you". A group carries only its
 * first three actors, so this is the one way to reach the rest.
 *
 * Pages come back as a `FollowConnection`, the same shape `useFollowers` and
 * `useFollowing` return, which is what lets the connections screen treat all
 * three modes as one query.
 */
export function useNotificationActors(
  type: NotificationType,
  entityType?: SocialEntityType | null,
  entityId?: string | null,
  enabled = true,
) {
  const { data: authToken } = useAuthToken();

  return useInfiniteQuery({
    queryKey: [NOTIFICATION_ACTORS_QUERY_KEY, type, entityType ?? null, entityId ?? null],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const variables: GetNotificationActorsQueryVariables = {
        input: { type, entityType, entityId, limit: ACTORS_PAGE_SIZE, offset: Number(pageParam) },
      };
      const response = await getHttpClient().request<
        GetNotificationActorsQueryResponse,
        GetNotificationActorsQueryVariables
      >(GET_NOTIFICATION_ACTORS, variables);
      return response.notificationActors;
    },
    getNextPageParam: nextActorsOffset,
    enabled: enabled && !!authToken,
  });
}

/** Unread notification count for the Home bell badge. */
export function useUnreadNotificationCount(): number {
  const { data: authToken } = useAuthToken();

  const { data: unreadCount = 0 } = useQuery({
    queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
    queryFn: async () => {
      const response =
        await getHttpClient().request<GetUnreadNotificationCountQueryResponse>(GET_UNREAD_NOTIFICATION_COUNT);
      return response.unreadNotificationCount;
    },
    enabled: !!authToken,
    staleTime: NOTIFICATIONS_STALE_TIME_MS,
  });

  return unreadCount;
}

/**
 * Mark one group read. Cache semantics mirror web exactly: flip `isRead` on the
 * matching uuid across every loaded page, then subtract the count the server
 * actually marked from the unread total (a group can hold several rows).
 */
export function useMarkGroupAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notification: GroupedNotification) => {
      const variables: MarkGroupNotificationsReadMutationVariables = {
        type: notification.type,
        entityType: notification.entityType,
        entityId: notification.entityId,
      };
      const response = await getHttpClient().request<
        MarkGroupNotificationsReadMutationResponse,
        MarkGroupNotificationsReadMutationVariables
      >(MARK_GROUP_NOTIFICATIONS_READ, variables);
      return response.markGroupNotificationsRead;
    },
    onSuccess: (markedCount, notification) => {
      queryClient.setQueriesData<GroupedNotificationPages>({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY }, (previous) =>
        previous
          ? {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                groups: page.groups.map((group) =>
                  group.uuid === notification.uuid ? { ...group, isRead: true } : group,
                ),
              })),
            }
          : previous,
      );

      queryClient.setQueryData<number>(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, (previousCount) =>
        Math.max(0, (previousCount ?? 0) - markedCount),
      );
    },
  });
}

/** Mark every notification read — the header action on the notifications screen. */
export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await getHttpClient().request(MARK_ALL_NOTIFICATIONS_READ);
    },
    onSuccess: () => {
      queryClient.setQueriesData<GroupedNotificationPages>({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY }, (previous) =>
        previous
          ? {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                groups: page.groups.map((group) => ({ ...group, isRead: true })),
              })),
            }
          : previous,
      );

      queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 0);
    },
  });
}
