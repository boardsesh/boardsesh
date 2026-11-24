import * as Notifications from 'expo-notifications';
import { sprayImportRoute } from '../lib/spray/spray-import-progress';
import { isWallDisplayOpen } from '../lib/wall-display-presence';

type RouterLike = { push: (href: never) => void; dismissTo?: (href: never) => void };
export type NotificationRoute = { path: string; params?: Record<string, string> };
export type NotificationHandlerOptions = {
  canNavigate?: boolean;
  onSprayCompletion?: () => void;
  onBugReportReply?: (reportId: string) => void;
  /**
   * The `directory-reports` flag, once the flag bag is final; undefined while
   * it is not. False sends a report push to the board's plain detail sheet.
   */
  directoryReportsEnabled?: boolean;
};
export type NotificationRouteOptions = Pick<NotificationHandlerOptions, 'directoryReportsEnabled'>;
// Keep process-lifetime tap IDs across auth/provider remounts so the OS response cannot navigate twice.
const consumedResponses = new Set<string>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveNotificationRoute(
  notification: Notifications.Notification,
  options: NotificationRouteOptions = {},
): NotificationRoute | null {
  const payload = notification.request.content.data;
  switch (payload?.type) {
    case 'app_feedback_reply':
      return typeof payload.reportId === 'string' && /^\d+$/.test(payload.reportId)
        ? { path: '/bug-reports/[id]', params: { id: payload.reportId } }
        : null;
    case 'spray_wall_detection_completed': {
      const resetOfWallUuid: unknown = payload.resetOfWallUuid ?? null;
      if (
        typeof payload.wallUuid !== 'string' ||
        !UUID_PATTERN.test(payload.wallUuid) ||
        typeof payload.versionId !== 'string' ||
        !/^\d+$/.test(payload.versionId) ||
        (resetOfWallUuid !== null && (typeof resetOfWallUuid !== 'string' || !UUID_PATTERN.test(resetOfWallUuid)))
      )
        return null;
      const route = sprayImportRoute({
        wallUuid: payload.wallUuid,
        versionId: payload.versionId,
        resetOfWallUuid,
      });
      return { path: route.pathname, params: route.params };
    }
    // A report on the climber's board (or at their gym) opened: the review
    // sheet. With the flag known to be off, the board's plain detail sheet. An
    // unresolved flag leaves it to the picker, which waits for the flag before
    // it opens either.
    case 'board_report_opened':
      if (typeof payload.boardUuid !== 'string' || !UUID_PATTERN.test(payload.boardUuid)) return null;
      return options.directoryReportsEnabled === false
        ? { path: '/boards', params: { board: payload.boardUuid, details: '1' } }
        : { path: '/boards', params: { board: payload.boardUuid, review: '1' } };
    // A climber's suggested setup changed a board: its detail sheet, as the
    // inbox row opens it; Undo lives on that row. The push goes to the board's
    // creator and the gym's owner and admins, carrying { type,
    // notificationUuid, boardUuid, setupChangeEventId }; only the board is read.
    case 'board_setup_changed_by_climber':
      if (typeof payload.boardUuid !== 'string' || !UUID_PATTERN.test(payload.boardUuid)) return null;
      return { path: '/boards', params: { board: payload.boardUuid, details: '1' } };
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
    case 'gym_claim_approved': {
      // The in-app row already opens the gym page; a push carrying the gym's
      // uuid opens the same page. Accepts `gymUuid` or, matching the feed row,
      // `entityId`. The backend sends no push for this type yet.
      const gymUuid: unknown = payload.gymUuid ?? payload.entityId;
      return typeof gymUuid === 'string' && UUID_PATTERN.test(gymUuid)
        ? { path: '/gyms/[gym]', params: { gym: gymUuid } }
        : null;
    }
    case 'gym_claim_denied': {
      // The same page on the claimant's denial card, as the in-app row opens it.
      const gymUuid: unknown = payload.gymUuid ?? payload.entityId;
      return typeof gymUuid === 'string' && UUID_PATTERN.test(gymUuid)
        ? { path: '/gyms/[gym]', params: { gym: gymUuid, claim: 'denied' } }
        : null;
    }
    default:
      return null;
  }
}

export function setupNotificationHandlers(router: RouterLike, options: NotificationHandlerOptions = {}): () => void {
  const consume = (response: Notifications.NotificationResponse) => {
    if (options.canNavigate === false) return;
    const identifier = response.notification.request.identifier;
    if (consumedResponses.has(identifier)) return;
    const route = resolveNotificationRoute(response.notification, options);
    if (!route) return;
    consumedResponses.add(identifier);
    if (response.notification.request.content.data?.type === 'spray_wall_detection_completed')
      options.onSprayCompletion?.();
    if (route.path === '/bug-reports/[id]' && route.params?.id) options.onBugReportReply?.(route.params.id);
    const href = (route.params ? { pathname: route.path, params: route.params } : route.path) as never;
    // Over the full-screen Wall display, a push to a tab would stack the tabs on
    // top of the kiosk. Close back down to the tabs instead. Root modals (the
    // spray import) still present over it, and nothing changes elsewhere.
    if (route.path.startsWith('/(tabs)/') && isWallDisplayOpen() && router.dismissTo) router.dismissTo(href);
    else router.push(href);
  };
  const responseSubscription = Notifications.addNotificationResponseReceivedListener(consume);
  const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
    if (options.canNavigate !== false && notification.request.content.data?.type === 'spray_wall_detection_completed')
      options.onSprayCompletion?.();
    if (options.canNavigate !== false && notification.request.content.data?.type === 'app_feedback_reply') {
      const route = resolveNotificationRoute(notification);
      if (route?.params?.id) options.onBugReportReply?.(route.params.id);
    }
  });
  // Preserve the OS response for the existing launch gate; consume once after auth resolves.
  const lastResponse = Notifications.getLastNotificationResponse();
  if (lastResponse) consume(lastResponse);
  return () => {
    responseSubscription.remove();
    receivedSubscription.remove();
  };
}
