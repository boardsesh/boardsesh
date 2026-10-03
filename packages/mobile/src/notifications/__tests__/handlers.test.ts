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
const completed = { type: 'spray_wall_detection_completed', wallUuid, versionId: '42', isReset: false };

describe('native import notification handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.listenResponse.mockReturnValue({ remove: mocks.removeResponse });
    mocks.listenReceived.mockReturnValue({ remove: mocks.removeReceived });
    mocks.lastResponse.mockReturnValue(null);
  });

  it('resolves new and reset imports to the exact wall and draft version', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification(completed))).toEqual({
      path: '/boards/spray/new',
      params: { wallUuid, versionId: '42' },
    });
    expect(resolveNotificationRoute(notification({ ...completed, isReset: true }))).toEqual({
      path: '/boards/spray/reset',
      params: { wallUuid, versionId: '42' },
    });
  });

  it('rejects malformed import payloads without opening a fresh wizard', async () => {
    const { resolveNotificationRoute } = await import('../handlers');
    expect(resolveNotificationRoute(notification({ ...completed, wallUuid: 'bad-wall' }))).toBeNull();
    expect(resolveNotificationRoute(notification({ ...completed, versionId: undefined }))).toBeNull();
    expect(resolveNotificationRoute(notification({ ...completed, isReset: 'false' }))).toBeNull();
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
});
