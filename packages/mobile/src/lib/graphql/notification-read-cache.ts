import type { QueryClient } from '@tanstack/react-query';
import type { GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';

export const GROUPED_NOTIFICATIONS_QUERY_KEY = ['notifications', 'grouped'] as const;
export const NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY = ['notifications', 'unreadCount'] as const;

type NotificationGroup = Pick<GroupedNotification, 'type' | 'entityType' | 'entityId'>;
type GroupedNotificationPages = { pages: GroupedNotificationConnection[]; pageParams: unknown[] };

/** Patch a read group without reloading notification history. */
export function applyNotificationGroupRead(client: QueryClient, notification: NotificationGroup, markedCount: number) {
  client.setQueriesData<GroupedNotificationPages>({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY }, (previous) =>
    previous
      ? {
          ...previous,
          pages: previous.pages.map((page) => ({
            ...page,
            unreadCount: Math.max(0, page.unreadCount - markedCount),
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
  client.setQueryData<number>(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, (previous) =>
    previous === undefined ? previous : Math.max(0, previous - markedCount),
  );
}
