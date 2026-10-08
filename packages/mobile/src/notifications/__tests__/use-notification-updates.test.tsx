// @vitest-environment jsdom
// Existing flow fixtures begin after the privacy choice has settled.
vi.mock('../../lib/consent-hooks', () => ({ useConsentSettled: () => true }));
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  register: vi.fn(),
  setupHandlers: vi.fn(),
  removeHandlers: vi.fn(),
  listenAppState: vi.fn(),
  removeAppState: vi.fn(),
  listenToken: vi.fn(),
  removeToken: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  locale: { language: 'en-US' },
}));
const queryClient = { invalidateQueries: mocks.invalidate };
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('react-native', () => ({ AppState: { addEventListener: mocks.listenAppState } }));
vi.mock('expo-notifications', () => ({ addPushTokenListener: mocks.listenToken }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: mocks.locale }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('../device-registration', () => ({ registerNotificationDevice: mocks.register }));
vi.mock('../handlers', () => ({ setupNotificationHandlers: mocks.setupHandlers }));

import { useNotificationUpdates } from '../use-notification-updates';

describe('native notification update bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locale.language = 'en-US';
    mocks.register.mockResolvedValue(undefined);
    mocks.setupHandlers.mockReturnValue(mocks.removeHandlers);
    mocks.listenAppState.mockReturnValue({ remove: mocks.removeAppState });
    mocks.listenToken.mockReturnValue({ remove: mocks.removeToken });
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  });

  it('keeps push taps gated and defers registration and websocket work until login', () => {
    const { rerender } = renderHook(({ authenticated }) => useNotificationUpdates(authenticated, 'account'), {
      initialProps: { authenticated: false },
    });
    expect(mocks.setupHandlers.mock.calls[0][1]).toMatchObject({ canNavigate: false });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    rerender({ authenticated: true });
    expect(mocks.setupHandlers.mock.calls[1][1]).toMatchObject({ canNavigate: true });
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledWith();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it('refreshes exact board, detection, and bell cache prefixes on foreground without prompting', () => {
    renderHook(() => useNotificationUpdates(true, 'account'));
    const changeAppState = mocks.listenAppState.mock.calls[0][1] as (state: string) => void;
    act(() => changeAppState('background'));
    expect(mocks.register).toHaveBeenCalledOnce();
    act(() => changeAppState('active'));
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.register.mock.calls.every((args) => args.length === 0)).toBe(true);
    expect(mocks.invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: ['myBoards'] },
      { queryKey: ['mySprayWalls'] },
      { queryKey: ['sprayImportProgress'] },
      { queryKey: ['spray-wall-detection'] },
      { queryKey: ['notifications'] },
    ]);
  });

  it('forces refreshed Expo registration on native token rotation without a permission prompt', () => {
    renderHook(() => useNotificationUpdates(true, 'account'));
    const rotateToken = mocks.listenToken.mock.calls[0][0] as () => void;
    act(() => rotateToken());
    expect(mocks.register).toHaveBeenLastCalledWith(false, true);
  });

  it('refreshes on websocket model completion and ignores unrelated notifications', () => {
    renderHook(() => useNotificationUpdates(true, 'account'));
    const sink = mocks.subscribe.mock.calls[0][1] as {
      next: (payload: { data: { notificationReceived: { notification: { type: string } } } }) => void;
    };
    act(() => sink.next({ data: { notificationReceived: { notification: { type: 'new_follower' } } } }));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    act(() =>
      sink.next({ data: { notificationReceived: { notification: { type: 'spray_wall_detection_completed' } } } }),
    );
    expect(mocks.invalidate).toHaveBeenCalledTimes(5);
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] });
  });

  it('replaces account-scoped subscriptions on account change and cleans up every listener', () => {
    const { rerender, unmount } = renderHook(({ accountId }) => useNotificationUpdates(true, accountId), {
      initialProps: { accountId: 'first' },
    });
    rerender({ accountId: 'second' });
    expect(mocks.removeHandlers).toHaveBeenCalledOnce();
    expect(mocks.removeAppState).toHaveBeenCalledOnce();
    expect(mocks.removeToken).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledTimes(2);
    unmount();
    expect(mocks.removeHandlers).toHaveBeenCalledTimes(2);
    expect(mocks.removeAppState).toHaveBeenCalledTimes(2);
    expect(mocks.removeToken).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('updates device locale without replacing the websocket subscription', () => {
    const { rerender } = renderHook(() => useNotificationUpdates(true, 'account'));
    mocks.locale.language = 'de';
    rerender();
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });
});

import { grantAnalyticsForTest } from '../../../test/consent-fixture';
beforeEach(() => grantAnalyticsForTest());
