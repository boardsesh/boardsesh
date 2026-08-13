import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useNotificationSubscription } from '../use-notification-subscription';

// --- Mocks ---

vi.mock('../use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: vi.fn(() => ({ showMessage: mockShowMessage })),
}));

const mockUnsub = vi.fn();
const mockDispose = vi.fn();
const mockCreateGraphQLClient = vi.fn(() => ({
  dispose: mockDispose,
}));
const mockSubscribe = vi.fn(() => mockUnsub);

vi.mock('@/app/lib/realtime/graphql-client', () => ({
  createGraphQLClient: (...args: Parameters<typeof mockCreateGraphQLClient>) => mockCreateGraphQLClient(...args),
  subscribe: (...args: Parameters<typeof mockSubscribe>) => mockSubscribe(...args),
}));

const mockHttpRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockHttpRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  GET_UNREAD_NOTIFICATION_COUNT: 'GET_UNREAD_COUNT',
  NOTIFICATION_RECEIVED_SUBSCRIPTION: 'NOTIFICATION_SUB',
}));

vi.mock('../use-unread-notification-count', () => ({
  UNREAD_COUNT_QUERY_KEY: ['notifications', 'unreadCount'],
}));

vi.mock('../use-grouped-notifications', () => ({
  GROUPED_NOTIFICATIONS_QUERY_KEY: ['notifications', 'grouped'],
}));

// Mock QueryClient
const mockSetQueryData = vi.fn();
const mockSetQueriesData = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    setQueriesData: mockSetQueriesData,
  }),
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

describe('useNotificationSubscription', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NEXT_PUBLIC_WS_URL: 'wss://test.example.com' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does not subscribe when not authenticated', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    expect(mockCreateGraphQLClient).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('does not subscribe when no token', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    expect(mockCreateGraphQLClient).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('does not subscribe when no WS URL', () => {
    delete process.env.NEXT_PUBLIC_WS_URL;
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('creates client and subscribes when authenticated', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    expect(mockCreateGraphQLClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'wss://test.example.com',
        authToken: 'test-token',
      }),
    );
    expect(mockSubscribe).toHaveBeenCalled();
  });

  it('cleans up (unsub + dispose) on unmount', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const { unmount } = renderHook(() => useNotificationSubscription());

    unmount();

    expect(mockUnsub).toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalled();
  });

  it('cleans up on auth change', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'token-1',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const { rerender } = renderHook(() => useNotificationSubscription());

    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    // Change token
    mockUseWsAuthToken.mockReturnValue({
      token: 'token-2',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    rerender();

    // Old subscription should be cleaned up
    expect(mockUnsub).toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalled();

    // New subscription should be created
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });

  it('increments unread count on notification', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    // Get the subscription callbacks
    const subscribeCall = mockSubscribe.mock.calls[0] as unknown[];
    const callbacks = subscribeCall[2] as {
      next: (data: unknown) => void;
      error: (err: unknown) => void;
    };

    // Simulate receiving a notification
    callbacks.next({
      notificationReceived: {
        notification: {
          uuid: 'notif-1',
          type: 'new_follower',
          entityType: 'user',
          entityId: 'user-1',
          actorId: 'actor-1',
          actorDisplayName: 'Alice',
          actorAvatarUrl: null,
          commentBody: null,
          climbName: null,
          climbUuid: null,
          boardType: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      },
    });

    // Should increment unread count
    expect(mockSetQueryData).toHaveBeenCalledWith(['notifications', 'unreadCount'], expect.any(Function));

    // Call the updater function to verify it increments
    const updaterFn = mockSetQueryData.mock.calls.find(
      (call: unknown[]) => (call[0] as string[])[0] === 'notifications' && (call[0] as string[])[1] === 'unreadCount',
    )?.[1];

    if (typeof updaterFn === 'function') {
      expect(updaterFn(5)).toBe(6);
      expect(updaterFn(undefined)).toBe(1);
    }
  });

  it('shows toast message on notification', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    const subscribeCall = mockSubscribe.mock.calls[0] as unknown[];
    const callbacks = subscribeCall[2] as {
      next: (data: unknown) => void;
      error: (err: unknown) => void;
    };

    callbacks.next({
      notificationReceived: {
        notification: {
          uuid: 'notif-1',
          type: 'new_follower',
          entityType: 'user',
          entityId: 'user-1',
          actorId: 'actor-1',
          actorDisplayName: 'Alice',
          actorAvatarUrl: null,
          commentBody: null,
          climbName: null,
          climbUuid: null,
          boardType: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      },
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Alice started following you', 'info');
  });

  it('handles subscription error without throwing', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderHook(() => useNotificationSubscription());

    const subscribeCall = mockSubscribe.mock.calls[0] as unknown[];
    const callbacks = subscribeCall[2] as {
      next: (data: unknown) => void;
      error: (err: unknown) => void;
    };

    // Should not throw
    expect(() => {
      callbacks.error(new Error('Subscription error'));
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith('[Notifications] Subscription error:', expect.any(Error));

    errorSpy.mockRestore();
  });

  it('merges new notification into grouped cache (new group)', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useNotificationSubscription());

    const subscribeCall = mockSubscribe.mock.calls[0] as unknown[];
    const callbacks = subscribeCall[2] as {
      next: (data: unknown) => void;
      error: (err: unknown) => void;
    };

    callbacks.next({
      notificationReceived: {
        notification: {
          uuid: 'notif-2',
          type: 'comment_reply',
          entityType: 'comment',
          entityId: 'comment-1',
          actorId: 'actor-2',
          actorDisplayName: 'Bob',
          actorAvatarUrl: 'https://example.com/bob.png',
          commentBody: 'Nice climb!',
          climbName: 'Boulder Problem',
          climbUuid: 'climb-1',
          boardType: 'kilter',
          createdAt: '2025-01-01T00:00:00Z',
        },
      },
    });

    // Should call setQueriesData for grouped notifications
    expect(mockSetQueriesData).toHaveBeenCalledWith({ queryKey: ['notifications', 'grouped'] }, expect.any(Function));

    // Get the updater function and test it creates a new group
    const updaterFn = mockSetQueriesData.mock.calls[0][1];
    const existingData = {
      pages: [
        {
          groups: [
            {
              uuid: 'existing-group',
              type: 'new_follower',
              entityType: 'user',
              entityId: 'other-entity',
              actorCount: 1,
              actors: [{ id: 'a1', displayName: 'Eve', avatarUrl: null }],
              isRead: true,
              createdAt: '2024-12-01T00:00:00Z',
              commentBody: null,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      ],
      pageParams: [null],
    };

    const updatedData = updaterFn(existingData);

    // New group should be prepended to first page
    expect(updatedData.pages[0].groups[0].uuid).toBe('notif-2');
    expect(updatedData.pages[0].groups[0].type).toBe('comment_reply');
    expect(updatedData.pages[0].groups[0].actorCount).toBe(1);
    expect(updatedData.pages[0].groups[0].isRead).toBe(false);

    // Existing group should still be present
    expect(updatedData.pages[0].groups[1].uuid).toBe('existing-group');
  });
});
