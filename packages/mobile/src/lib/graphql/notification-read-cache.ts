import type { QueryClient } from '@tanstack/react-query';
import type { GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';

export const GROUPED_NOTIFICATIONS_QUERY_KEY = ['notifications', 'grouped'] as const;
export const NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY = ['notifications', 'unreadCount'] as const;

type NotificationGroup = Pick<GroupedNotification, 'type' | 'entityType' | 'entityId'>;
type GroupedNotificationPages = { pages: GroupedNotificationConnection[]; pageParams: unknown[] };

/** Patch a read group without reloading notification history. */
export function applyNotificationGroupRead(client: QueryClient, notification: NotificationGroup) {
  client.setQueriesData<GroupedNotificationPages>({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY }, (previous) =>
    previous
      ? {
          ...previous,
          pages: previous.pages.map((page) => ({
            ...page,
            groups: page.groups.map((group) =>
              group.type === notification.type &&
              (group.entityType ?? null) === (notification.entityType ?? null) &&
              (group.entityId ?? null) === (notification.entityId ?? null)
                ? { ...group, isRead: true }
                : group,
            ),
          })),
        }
      : previous,
  );
}

/**
 * One group as the loaded inbox holds it now, or null when no loaded page has
 * it. For a handler that held a row across an await (a confirm) and must act
 * on the row's state as it is now, not as it was when tapped.
 */
export function findCachedNotification(client: QueryClient, notificationUuid: string): GroupedNotification | null {
  for (const [, data] of client.getQueriesData<GroupedNotificationPages>({
    queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY,
  })) {
    for (const page of data?.pages ?? []) {
      const found = page.groups.find((group) => group.uuid === notificationUuid);
      if (found) return found;
    }
  }
  return null;
}
