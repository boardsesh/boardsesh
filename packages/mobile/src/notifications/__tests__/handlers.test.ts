import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification, NotificationResponse } from 'expo-notifications';

const mocks = vi.hoisted(() => ({
  listenResponse: vi.fn(),
  listenReceived: vi.fn(),
  lastResponse: vi.fn(),
  removeResponse: vi.fn(),
  removeReceived: vi.fn(),
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: mocks.listenResponse,
  addNotificationReceivedListener: mocks.listenReceived,
  getLastNotificationResponse: mocks.lastResponse,
}));

const wallUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function notification(payload: Record<string, unknown>, identifier = 'notification-one'): Notification {
  return { request: { identifier, content: { data: payload } } } as unknown as Notification;
}
function response(payload: Record<string, unknown>, identifier = 'notification-one'): NotificationResponse {
  return { notification: notification(payload, identifier) } as unknown as NotificationResponse;
}
const resetOfWallUuid = '11111111-2222-4333-8444-555555555555';
const completed = { type: 'spray_wall_detection_completed', wallUuid, versionId: '42', resetOfWallUuid: null };

describe('native import notification handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.listenResponse.mockReturnValue({ remove: mocks.removeResponse });
    mocks.listenReceived.mockReturnValue({ remove: mocks.removeReceived });
    mocks.lastResponse.mockReturnValue(null);
  });

  it('opens the review sheet for a board report push and rejects a malformed board uuid', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(
      resolveNotificationRoute(
        notification({ type: 'board_report_opened', boardUuid: wallUuid, reportUuid: resetOfWallUuid }),
      ),
    ).toEqual({ path: '/boards', params: { board: wallUuid, review: '1' } });
    expect(resolveNotificationRoute(notification({ type: 'board_report_opened', boardUuid: '../x' }))).toBeNull();
    expect(resolveNotificationRoute(notification({ type: 'board_report_opened' }))).toBeNull();
  });

  it('opens the plain board for a report push once the flag is known to be off', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    const push = notification({ type: 'board_report_opened', boardUuid: wallUuid });
    expect(resolveNotificationRoute(push, { directoryReportsEnabled: false })).toEqual({
      path: '/boards',
      params: { board: wallUuid, details: '1' },
    });
    expect(resolveNotificationRoute(push, { directoryReportsEnabled: true })).toEqual({
      path: '/boards',
      params: { board: wallUuid, review: '1' },
    });
  });

  it("opens the board's detail sheet for a climber's setup change, and drops a malformed board", async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(
      resolveNotificationRoute(notification({ type: 'board_setup_changed_by_climber', boardUuid: wallUuid })),
    ).toEqual({ path: '/boards', params: { board: wallUuid, details: '1' } });
    // The push as the backend sends it, to the creator and the gym's owner and admins alike.
    expect(
      resolveNotificationRoute(
        notification({
          type: 'board_setup_changed_by_climber',
          notificationUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
          boardUuid: wallUuid,
          setupChangeEventId: '42',
        }),
      ),
    ).toEqual({ path: '/boards', params: { board: wallUuid, details: '1' } });
    expect(
      resolveNotificationRoute(notification({ type: 'board_setup_changed_by_climber', boardUuid: '../x' })),
    ).toBeNull();
  });

  it('opens bug report replies and rejects malformed or missing report ids', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification({ type: 'app_feedback_reply', reportId: '42' }))).toEqual({
      path: '/bug-reports/[id]',
      params: { id: '42' },
    });
    expect(resolveNotificationRoute(notification({ type: 'app_feedback_reply', reportId: '../settings' }))).toBeNull();
    expect(resolveNotificationRoute(notification({ type: 'app_feedback_reply', reportId: 42 }))).toBeNull();
    expect(resolveNotificationRoute(notification({ type: 'app_feedback_reply' }))).toBeNull();
  });

  it('refreshes report history after a push and consumes its tap once', async () => {
    const incoming = response({ type: 'app_feedback_reply', reportId: '42' }, 'report-reply');
    const { setupNotificationHandlers } = await import('../handlers');
    const router = { push: vi.fn() };
    const refresh = vi.fn();
    const cleanup = setupNotificationHandlers(router, { onBugReportReply: refresh });
    const receive = mocks.listenReceived.mock.calls[0][0] as (received: Notification) => void;
    const tap = mocks.listenResponse.mock.calls[0][0] as (tapped: NotificationResponse) => void;
    receive(incoming.notification);
    tap(incoming);
    tap(incoming);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls).toEqual([['42'], ['42']]);
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith({ pathname: '/bug-reports/[id]', params: { id: '42' } });
    cleanup();
  });

  it('ignores malformed bug-reply pushes before refreshing caches', async () => {
    const { setupNotificationHandlers } = await import('../handlers');
    const refresh = vi.fn();
    const cleanup = setupNotificationHandlers({ push: vi.fn() }, { onBugReportReply: refresh });
    const receive = mocks.listenReceived.mock.calls[0][0] as (received: Notification) => void;
    receive(notification({ type: 'app_feedback_reply', reportId: '../settings' }));
    receive(notification({ type: 'app_feedback_reply' }));
    expect(refresh).not.toHaveBeenCalled();
    cleanup();
  });

  it('resolves a new import to its exact draft and a reset import to the wall it replaces', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification(completed))).toEqual({
      path: '/boards/spray/new',
      params: { wallUuid, versionId: '42' },
    });
    const withoutResetField = { type: completed.type, wallUuid, versionId: '42' };
    expect(resolveNotificationRoute(notification(withoutResetField))).toEqual({
      path: '/boards/spray/new',
      params: { wallUuid, versionId: '42' },
    });
    expect(resolveNotificationRoute(notification({ ...completed, resetOfWallUuid }))).toEqual({
      path: '/boards/spray/new',
      params: { resetOf: resetOfWallUuid },
    });
  });

  it('rejects malformed import payloads without opening a fresh wizard', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification({ ...completed, wallUuid: 'bad-wall' }))).toBeNull();
    expect(resolveNotificationRoute(notification({ ...completed, versionId: undefined }))).toBeNull();
    expect(resolveNotificationRoute(notification({ ...completed, resetOfWallUuid: 'bad-wall' }))).toBeNull();
    expect(resolveNotificationRoute(notification({ ...completed, resetOfWallUuid: true }))).toBeNull();
  });

  it('preserves a cold-launch response until authenticated navigation is ready', async () => {
    mocks.lastResponse.mockReturnValue(response(completed));
    const { setupNotificationHandlers } = await import('../handlers');
    const router = { push: vi.fn() };
    const invalidate = vi.fn();
    const unauthenticatedCleanup = setupNotificationHandlers(router, {
      canNavigate: false,
      onSprayCompletion: invalidate,
    });
    expect(router.push).not.toHaveBeenCalled();
    unauthenticatedCleanup();
    setupNotificationHandlers(router, { canNavigate: true, onSprayCompletion: invalidate });
    expect(router.push).toHaveBeenCalledWith({ pathname: '/boards/spray/new', params: { wallUuid, versionId: '42' } });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('consumes one OS response once across listener replay and bridge remount', async () => {
    const incoming = response(completed);
    mocks.lastResponse.mockReturnValue(incoming);
    const { setupNotificationHandlers } = await import('../handlers');
    const router = { push: vi.fn() };
    const cleanup = setupNotificationHandlers(router);
    const consume = mocks.listenResponse.mock.calls[0][0] as (notificationResponse: NotificationResponse) => void;
    consume(incoming);
    cleanup();
    setupNotificationHandlers(router);
    expect(router.push).toHaveBeenCalledOnce();
  });

  // #6289: the start-up tab is for a plain launch. A tapped notification opens
  // where it points, over whichever tab the launch picked.
  it('opens a tapped notification where it points with Home chosen to start', async () => {
    const { setSetting } = await import('../../settings/hooks');
    setSetting('startupScreen', 'home');
    try {
      mocks.lastResponse.mockReturnValue(response({ type: 'session_invite', sessionId: 'session' }));
      const { setupNotificationHandlers } = await import('../handlers');
      const router = { push: vi.fn() };
      setupNotificationHandlers(router, { canNavigate: true });
      expect(router.push).toHaveBeenCalledOnce();
      expect(router.push).toHaveBeenCalledWith({ pathname: '/(tabs)/queue', params: { sessionId: 'session' } });
    } finally {
      setSetting('startupScreen', 'climbs');
    }
  });

  it('closes the Wall display down to the tabs instead of stacking a tab over the kiosk', async () => {
    const { markWallDisplayMounted } = await import('../../lib/wall-display-presence');
    const { setupNotificationHandlers } = await import('../handlers');
    const router = { push: vi.fn(), dismissTo: vi.fn() };
    setupNotificationHandlers(router, { canNavigate: true });
    const consume = mocks.listenResponse.mock.calls[0][0] as (notificationResponse: NotificationResponse) => void;
    const profileHref = { pathname: '/(tabs)/profile', params: { userId: 'friend' } };

    const release = markWallDisplayMounted();
    try {
      consume(response({ type: 'follow', userId: 'friend' }, 'follow-tap'));
      expect(router.dismissTo).toHaveBeenCalledWith(profileHref);
      expect(router.push).not.toHaveBeenCalled();

      // A root modal (the spray import) still presents over the kiosk.
      consume(response(completed, 'import-tap'));
      expect(router.push).toHaveBeenCalledWith({
        pathname: '/boards/spray/new',
        params: { wallUuid, versionId: '42' },
      });
    } finally {
      release();
    }

    // Without the display, a tab tap pushes as before.
    consume(response({ type: 'follow', userId: 'friend' }, 'follow-tap-later'));
    expect(router.push).toHaveBeenLastCalledWith(profileHref);
    expect(router.dismissTo).toHaveBeenCalledOnce();
  });

  it('refreshes import progress for a foreground completion without navigating', async () => {
    const { setupNotificationHandlers } = await import('../handlers');
    const router = { push: vi.fn() };
    const invalidate = vi.fn();
    setupNotificationHandlers(router, { onSprayCompletion: invalidate });
    const receive = mocks.listenReceived.mock.calls[0][0] as (received: Notification) => void;
    receive(notification(completed));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    receive(notification({ type: 'follow', userId: 'friend' }));
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('removes both response and foreground listeners when the bridge unmounts', async () => {
    const { setupNotificationHandlers } = await import('../handlers');
    setupNotificationHandlers({ push: vi.fn() })();
    expect(mocks.removeResponse).toHaveBeenCalledOnce();
    expect(mocks.removeReceived).toHaveBeenCalledOnce();
  });

  it('retains existing notification routes', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification({ type: 'session_invite', sessionId: 'session' }))).toEqual({
      path: '/(tabs)/queue',
      params: { sessionId: 'session' },
    });
    expect(resolveNotificationRoute(notification({ type: 'follow', userId: 'friend' }))).toEqual({
      path: '/(tabs)/profile',
      params: { userId: 'friend' },
    });
  });

  it('opens the gym page for a claim that came through, and only for a real gym uuid', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification({ type: 'gym_claim_approved', gymUuid: wallUuid }))).toEqual({
      path: '/gyms/[gym]',
      params: { gym: wallUuid },
    });
    expect(resolveNotificationRoute(notification({ type: 'gym_claim_approved', entityId: wallUuid }))).toEqual({
      path: '/gyms/[gym]',
      params: { gym: wallUuid },
    });
    expect(resolveNotificationRoute(notification({ type: 'gym_claim_approved', gymUuid: '../settings' }))).toBeNull();
    expect(resolveNotificationRoute(notification({ type: 'gym_claim_approved' }))).toBeNull();
  });

  it("opens the gym's page on the denial card for a denied claim", async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification({ type: 'gym_claim_denied', gymUuid: wallUuid }))).toEqual({
      path: '/gyms/[gym]',
      params: { gym: wallUuid, claim: 'denied' },
    });
    expect(resolveNotificationRoute(notification({ type: 'gym_claim_denied', gymUuid: '../settings' }))).toBeNull();
  });
});
