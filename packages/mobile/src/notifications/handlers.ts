import * as Notifications from 'expo-notifications';
import { sprayImportRoute } from '../lib/spray/spray-import-progress';

type RouterLike = { push: (href: never) => void };
export type NotificationRoute = { path: string; params?: Record<string, string> };
export type NotificationHandlerOptions = {
  canNavigate?: boolean;
  onSprayCompletion?: () => void;
};
// Keep process-lifetime tap IDs across auth/provider remounts so the OS response cannot navigate twice.
const consumedResponses = new Set<string>();

export function resolveNotificationRoute(notification: Notifications.Notification): NotificationRoute | null {
  const payload = notification.request.content.data;
  switch (payload?.type) {
    case 'spray_wall_detection_completed': {
      if (
        typeof payload.wallUuid !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.wallUuid) ||
        typeof payload.versionId !== 'string' ||
        !/^\d+$/.test(payload.versionId) ||
        typeof payload.isReset !== 'boolean'
      )
        return null;
      const route = sprayImportRoute({
        wallUuid: payload.wallUuid,
        versionId: payload.versionId,
        isReset: payload.isReset,
      });
      return { path: route.pathname, params: route.params };
    }
    case 'session_invite':
      return typeof payload.sessionId === 'string'
        ? { path: '/(tabs)/queue', params: { sessionId: payload.sessionId } }
        : null;
    case 'climb_comment':
      return typeof payload.climbUuid === 'string'
        ? { path: '/(tabs)/climbs', params: { climbUuid: payload.climbUuid } }
        : null;
    case 'follow':
      return typeof payload.userId === 'string'
        ? { path: '/(tabs)/profile', params: { userId: payload.userId } }
        : null;
    default:
      return null;
  }
}

export function setupNotificationHandlers(router: RouterLike, options: NotificationHandlerOptions = {}): () => void {
  const consume = (response: Notifications.NotificationResponse) => {
    if (options.canNavigate === false) return;
    const identifier = response.notification.request.identifier;
    if (consumedResponses.has(identifier)) return;
    const route = resolveNotificationRoute(response.notification);
    if (!route) return;
    consumedResponses.add(identifier);
    if (response.notification.request.content.data?.type === 'spray_wall_detection_completed')
      options.onSprayCompletion?.();
    router.push((route.params ? { pathname: route.path, params: route.params } : route.path) as never);
  };
  const responseSubscription = Notifications.addNotificationResponseReceivedListener(consume);
  const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
    if (options.canNavigate !== false && notification.request.content.data?.type === 'spray_wall_detection_completed')
      options.onSprayCompletion?.();
  });
  // Preserve the OS response for the existing launch gate; consume once after auth resolves.
  const lastResponse = Notifications.getLastNotificationResponse();
  if (lastResponse) consume(lastResponse);
  return () => {
    responseSubscription.remove();
    receivedSubscription.remove();
  };
}
