'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLClient, subscribe } from '@/app/lib/realtime/graphql-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_UNREAD_NOTIFICATION_COUNT,
  NOTIFICATION_RECEIVED_SUBSCRIPTION,
  type GetUnreadNotificationCountQueryResponse,
  type NotificationReceivedSubscriptionResponse,
} from '@boardsesh/graphql/operations';
import type { Notification, GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';
import { UNREAD_COUNT_QUERY_KEY } from './use-unread-notification-count';
import { GROUPED_NOTIFICATIONS_QUERY_KEY } from './use-grouped-notifications';

function formatNotificationMessage(notification: Notification): string {
  const actor = notification.actorDisplayName || 'Someone';
  switch (notification.type) {
    case 'new_follower':
      return `${actor} started following you`;
    case 'comment_reply':
      return `${actor} replied to your comment`;
    case 'comment_on_tick':
      return `${actor} commented on your ascent`;
    case 'comment_on_climb':
      return `${actor} commented on a climb`;
    case 'vote_on_tick':
      return `${actor} liked your ascent`;
    case 'vote_on_comment':
      return `${actor} liked your comment`;
    case 'gym_claim_approved':
      return notification.gymName ? `You now manage ${notification.gymName}` : 'Your gym claim was approved';
    default:
      return 'You have a new notification';
  }
}

/**
 * Hook that sets up a WebSocket subscription for real-time notifications
 * and feeds incoming notifications into the TanStack Query cache.
 */
export function useNotificationSubscription() {
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();
  const showMessageRef = useRef(showMessage);
  showMessageRef.current = showMessage;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    if (!isAuthenticated || !token) return;

    const wsUrl = getBackendWsUrl();
    if (!wsUrl) return;

    const refreshUnreadCount = async () => {
      try {
        const currentToken = tokenRef.current;
        if (!currentToken) return;
        const client = createGraphQLHttpClient(currentToken);
        const data = await client.request<GetUnreadNotificationCountQueryResponse>(GET_UNREAD_NOTIFICATION_COUNT);
        queryClient.setQueryData(UNREAD_COUNT_QUERY_KEY, data.unreadNotificationCount);
      } catch (err) {
        console.error('[Notifications] Failed to refresh unread count:', err);
      }
    };

    const wsClient = createGraphQLClient({
      url: wsUrl,
      authToken: token,
      onReconnect: () => {
        void refreshUnreadCount();
      },
    });

    const unsub = subscribe<NotificationReceivedSubscriptionResponse>(
      wsClient,
      { query: NOTIFICATION_RECEIVED_SUBSCRIPTION },
      {
        next: (data) => {
          if (data?.notificationReceived?.notification) {
            const notification = data.notificationReceived.notification;

            // Increment unread count
            queryClient.setQueryData<number>(UNREAD_COUNT_QUERY_KEY, (prev) => (prev ?? 0) + 1);

            // Show toast
            showMessageRef.current(formatNotificationMessage(notification), 'info');

            // Merge into grouped notifications cache
            queryClient.setQueriesData<{
              pages: GroupedNotificationConnection[];
              pageParams: unknown[];
            }>({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY }, (old) => {
              if (!old) return old;
              const allGroups = old.pages.flatMap((p) => p.groups);
              const matchIdx = allGroups.findIndex(
                (g) =>
                  g.type === notification.type &&
                  g.entityType === notification.entityType &&
                  g.entityId === notification.entityId,
              );

              let newGroup: GroupedNotification;

              if (matchIdx >= 0) {
                const existing = allGroups[matchIdx];
                const actorAlreadyPresent = existing.actors.some((a) => a.id === notification.actorId);
                newGroup = {
                  ...existing,
                  uuid: notification.uuid,
                  actorCount: actorAlreadyPresent ? existing.actorCount : existing.actorCount + 1,
                  actors: actorAlreadyPresent
                    ? existing.actors
                    : [
                        {
                          id: notification.actorId || '',
                          displayName: notification.actorDisplayName,
                          avatarUrl: notification.actorAvatarUrl,
                        },
                        ...existing.actors,
                      ].slice(0, 3),
                  isRead: false,
                  createdAt: notification.createdAt,
                  commentBody: notification.commentBody || existing.commentBody,
                };
              } else {
                newGroup = {
                  uuid: notification.uuid,
                  type: notification.type,
                  entityType: notification.entityType,
                  entityId: notification.entityId,
                  actorCount: 1,
                  actors: notification.actorId
                    ? [
                        {
                          id: notification.actorId,
                          displayName: notification.actorDisplayName,
                          avatarUrl: notification.actorAvatarUrl,
                        },
                      ]
                    : [],
                  commentBody: notification.commentBody,
                  climbName: notification.climbName,
                  climbUuid: notification.climbUuid,
                  boardType: notification.boardType,
                  gymName: notification.gymName,
                  isRead: false,
                  createdAt: notification.createdAt,
                };
              }

              // Rebuild pages: prepend new group to first page, remove duplicate from any page
              const existingUuid = matchIdx >= 0 ? allGroups[matchIdx].uuid : null;
              const withoutExisting = (groups: GroupedNotification[]) =>
                existingUuid ? groups.filter((g) => g.uuid !== existingUuid) : groups;

              const updatedPages = old.pages.map((page, pageIdx) => ({
                ...page,
                groups: pageIdx === 0 ? [newGroup, ...withoutExisting(page.groups)] : withoutExisting(page.groups),
              }));

              return { ...old, pages: updatedPages };
            });
          }
        },
        error: (err) => {
          console.error('[Notifications] Subscription error:', err);
        },
        complete: () => {
          // Subscription ended
        },
      },
    );

    return () => {
      unsub();
      void wsClient.dispose();
    };
  }, [isAuthenticated, token, queryClient]);
}
