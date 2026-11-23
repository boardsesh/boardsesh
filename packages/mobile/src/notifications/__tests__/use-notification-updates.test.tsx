// @vitest-environment jsdom
// Existing flow fixtures begin after the privacy choice has settled.
vi.mock('../../lib/consent-hooks', () => ({ useConsentSettled: () => true }));
import { act, cleanup, renderHook } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  onConnected: vi.fn(),
  removeConnected: vi.fn(),
  locale: { language: 'en-US' },
}));
const queryClient = { invalidateQueries: mocks.invalidate, getQueryCache: () => ({ findAll: () => [] }) };
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => queryClient,
}));
vi.mock('react-native', () => ({ AppState: { addEventListener: mocks.listenAppState } }));
vi.mock('expo-notifications', () => ({ addPushTokenListener: mocks.listenToken }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: mocks.locale }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../../lib/graphql/ws-client', () => ({
  getWsClient: () => ({ subscribe: mocks.subscribe, on: mocks.onConnected }),
}));
vi.mock('../device-registration', () => ({ registerNotificationDevice: mocks.register }));
vi.mock('../handlers', () => ({ setupNotificationHandlers: mocks.setupHandlers }));
vi.mock('../../providers/feature-flags-provider', () => ({
  useFeatureFlagsResolved: () => true,
  useDirectoryReportsEnabled: () => true,
}));

import { useNotificationUpdates } from '../use-notification-updates';

async function advance() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('native notification update bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    focusManager.setFocused(true);
    mocks.locale.language = 'en-US';
    mocks.register.mockResolvedValue(undefined);
    mocks.setupHandlers.mockReturnValue(mocks.removeHandlers);
    mocks.listenAppState.mockReturnValue({ remove: mocks.removeAppState });
    mocks.listenToken.mockReturnValue({ remove: mocks.removeToken });
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
    mocks.onConnected.mockReturnValue(mocks.removeConnected);
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
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it('refreshes exact board, detection, and bell cache prefixes on foreground without prompting', async () => {
    renderHook(() => useNotificationUpdates(true, 'account'));
    const changeAppState = mocks.listenAppState.mock.calls[0][1] as (state: string) => void;
    act(() => changeAppState('background'));
    expect(mocks.register).toHaveBeenCalledOnce();
    act(() => changeAppState('active'));
    await advance();
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.register.mock.calls.every((args) => args.length === 0)).toBe(true);
    expect(mocks.invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: ['myBoards'] },
      { queryKey: ['mySprayWalls'] },
      { queryKey: ['sprayImportProgress'] },
      { queryKey: ['spray-wall-detection'] },
      { queryKey: ['notifications'] },
      { queryKey: ['bug-reports', 'account'] },
      { queryKey: ['notifications'] },
    ]);
  });

  it('forces refreshed Expo registration on native token rotation without a permission prompt', () => {
    renderHook(() => useNotificationUpdates(true, 'account'));
    const devicePushToken = { type: 'ios', data: 'rotated-native-token' };
    const rotateToken = mocks.listenToken.mock.calls[0][0] as (token: typeof devicePushToken) => void;
    act(() => rotateToken(devicePushToken));
    expect(mocks.register).toHaveBeenLastCalledWith(false, true, devicePushToken);
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

  it('coalesces native push and websocket staff replies without refreshing spray caches', async () => {
    renderHook(() => useNotificationUpdates(true, 'account'));
    const sink = mocks.subscribe.mock.calls[0][1] as {
      next: (payload: { data: { notificationReceived: { notification: { type: string; entityId: string } } } }) => void;
    };
    const handlers = mocks.setupHandlers.mock.calls[0][1] as { onBugReportReply: (reportId: string) => void };
    act(() => {
      sink.next({ data: { notificationReceived: { notification: { type: 'app_feedback_reply', entityId: '42' } } } });
      handlers.onBugReportReply('42');
    });
    await advance();
    expect(mocks.invalidate.mock.calls.map(([options]) => options)).toEqual([
      { queryKey: ['bug-reports', 'account', 'list'], exact: true },
      { queryKey: ['bug-reports', 'account', 'report', '42'], exact: true },
      { queryKey: ['bug-reports', 'account', 'messages', '42'], exact: true },
      { queryKey: ['notifications'] },
    ]);
  });

  it('replaces account-scoped subscriptions on account change and cleans up every listener', () => {
    const { rerender, unmount } = renderHook(({ accountId }) => useNotificationUpdates(true, accountId), {
      initialProps: { accountId: 'first' },
    });
    rerender({ accountId: 'second' });
    expect(mocks.removeHandlers).toHaveBeenCalledOnce();
    expect(mocks.removeAppState).toHaveBeenCalledOnce();
    expect(mocks.removeToken).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
    expect(mocks.removeConnected).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledTimes(2);
    unmount();
    expect(mocks.removeHandlers).toHaveBeenCalledTimes(2);
    expect(mocks.removeAppState).toHaveBeenCalledTimes(2);
    expect(mocks.removeToken).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(4);
    expect(mocks.removeConnected).toHaveBeenCalledTimes(2);
  });

  it('updates device locale without replacing the websocket subscription', () => {
    const { rerender } = renderHook(() => useNotificationUpdates(true, 'account'));
    mocks.locale.language = 'de';
    rerender();
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });
});

import { grantAnalyticsForTest } from '../../../test/consent-fixture';
beforeEach(() => grantAnalyticsForTest());
