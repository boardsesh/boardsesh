import * as Notifications from 'expo-notifications';
import type { router } from 'expo-router';

type Router = typeof router;

export type NotificationRoute = {
  path: string;
  params?: Record<string, string>;
};

function resolveNotificationRoute(notification: Notifications.Notification): NotificationRoute | null {
  const data = notification.request.content.data;
  if (!data) return null;

  const type = data.type as string | undefined;
  switch (type) {
    case 'session_invite':
      return data.sessionId ? { path: '/(tabs)/queue', params: { sessionId: data.sessionId as string } } : null;
    case 'climb_comment':
      return data.climbUuid ? { path: '/(tabs)/climbs', params: { climbUuid: data.climbUuid as string } } : null;
    case 'follow':
      return data.userId ? { path: '/(tabs)/profile', params: { userId: data.userId as string } } : null;
    default:
      return null;
  }
}

export function setupNotificationHandlers(router: Router): () => void {
  const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const route = resolveNotificationRoute(response.notification);
    if (route) {
      router.push(route.path as never);
    }
  });

  return () => {
    responseSubscription.remove();
  };
}
