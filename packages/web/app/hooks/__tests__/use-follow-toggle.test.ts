import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useFollowToggle } from '../use-follow-toggle';

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

type FollowToggleConfig = Parameters<typeof useFollowToggle>[0];

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

function createDefaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'entity-1',
    initialIsFollowing: false,
    followMutation: 'FOLLOW_MUTATION',
    unfollowMutation: 'UNFOLLOW_MUTATION',
    entityLabel: 'user',
    getFollowVariables: (id: string) => ({ id }),
    ...overrides,
  };
}

describe('useFollowToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    mockShowMessage.mockReset();
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
  });

  it('initial state matches initialIsFollowing', () => {
    const { result } = renderHook(() =>
      useFollowToggle(createDefaultConfig({ initialIsFollowing: true }) as FollowToggleConfig),
    );

    expect(result.current.isFollowing).toBe(true);
  });

  it('shows sign-in message when not authenticated', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useFollowToggle(createDefaultConfig() as FollowToggleConfig));

    await act(async () => {
      await result.current.handleToggle();
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Sign in to follow users', 'info');
  });

  it('optimistically toggles state on click', async () => {
    mockRequest.mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(() =>
      useFollowToggle(createDefaultConfig({ initialIsFollowing: false }) as FollowToggleConfig),
    );

    expect(result.current.isFollowing).toBe(false);

    act(() => {
      void result.current.handleToggle();
    });

    expect(result.current.isFollowing).toBe(true);
  });

  it('calls follow mutation when previously not following', async () => {
    mockRequest.mockResolvedValue({ ok: true });

    const { result } = renderHook(() =>
      useFollowToggle(createDefaultConfig({ initialIsFollowing: false }) as FollowToggleConfig),
    );

    await act(async () => {
      await result.current.handleToggle();
    });

    // Should call follow mutation (the first positional arg)
    expect(mockRequest).toHaveBeenCalledWith('FOLLOW_MUTATION', { id: 'entity-1' });
  });

  it('calls unfollow mutation when previously following', async () => {
    mockRequest.mockResolvedValue({ ok: true });

    const { result } = renderHook(() =>
      useFollowToggle(createDefaultConfig({ initialIsFollowing: true }) as FollowToggleConfig),
    );

    await act(async () => {
      await result.current.handleToggle();
    });

    expect(mockRequest).toHaveBeenCalledWith('UNFOLLOW_MUTATION', { id: 'entity-1' });
  });

  it('reverts state on mutation error', async () => {
    mockRequest.mockRejectedValue(new Error('Network error'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() =>
      useFollowToggle(createDefaultConfig({ initialIsFollowing: false }) as FollowToggleConfig),
    );

    await act(async () => {
      await result.current.handleToggle();
    });

    // Should revert back to false
    expect(result.current.isFollowing).toBe(false);
    vi.mocked(console.error).mockRestore();
  });

  it('shows error snackbar on failure', async () => {
    mockRequest.mockRejectedValue(new Error('Oops'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useFollowToggle(createDefaultConfig() as FollowToggleConfig));

    await act(async () => {
      await result.current.handleToggle();
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Failed to update follow status', 'error');
    vi.mocked(console.error).mockRestore();
  });

  it('calls onFollowChange callback', async () => {
    mockRequest.mockResolvedValue({ ok: true });
    const onFollowChange = vi.fn();

    const { result } = renderHook(() =>
      useFollowToggle(createDefaultConfig({ onFollowChange, initialIsFollowing: false }) as FollowToggleConfig),
    );

    await act(async () => {
      await result.current.handleToggle();
    });

    // Called optimistically with new state
    expect(onFollowChange).toHaveBeenCalledWith(true);
  });

  it('sets isLoading during mutation', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { result } = renderHook(() => useFollowToggle(createDefaultConfig() as FollowToggleConfig));

    expect(result.current.isLoading).toBe(false);

    act(() => {
      void result.current.handleToggle();
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveRequest!({ ok: true });
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('provides setIsHovered for hover state', () => {
    const { result } = renderHook(() => useFollowToggle(createDefaultConfig() as FollowToggleConfig));

    expect(result.current.isHovered).toBe(false);

    act(() => {
      result.current.setIsHovered(true);
    });

    expect(result.current.isHovered).toBe(true);
  });
});
