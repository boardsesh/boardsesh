import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useEntityMutation } from '../use-entity-mutation';

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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'auth.mustBeSignedIn' ? 'You must be signed in' : key),
  }),
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

describe('useEntityMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    mockShowMessage.mockReset();
  });

  it('returns null and shows auth error when no token', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Failed',
      }),
    );

    let returnValue: unknown;
    await act(async () => {
      returnValue = await result.current.execute({ input: 'test' });
    });

    expect(returnValue).toBeNull();
    expect(mockShowMessage).toHaveBeenCalledWith('You must be signed in', 'error');
  });

  it('executes mutation and returns data on success', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const mockData = { result: 'success' };
    mockRequest.mockResolvedValue(mockData);

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Failed',
      }),
    );

    let returnValue: unknown;
    await act(async () => {
      returnValue = await result.current.execute({ input: 'test' });
    });

    expect(returnValue).toEqual(mockData);
  });

  it('shows success message when provided', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    mockRequest.mockResolvedValue({ ok: true });

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        successMessage: 'Done!',
        errorMessage: 'Failed',
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Done!', 'success');
  });

  it('shows error message on failure', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    mockRequest.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Operation failed',
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Operation failed', 'error');
  });

  it('logs error on failure', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const error = new Error('Network error');
    mockRequest.mockRejectedValue(error);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Operation failed',
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(consoleSpy).toHaveBeenCalledWith('Operation failed', error);
    consoleSpy.mockRestore();
  });

  it('does not show success message when not provided', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    mockRequest.mockResolvedValue({ ok: true });

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Failed',
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('surfaces the server error message over the generic one', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const clientError = Object.assign(new Error('GraphQL Error'), {
      response: { errors: [{ message: 'You already have a board with this configuration' }] },
    });
    mockRequest.mockRejectedValue(clientError);

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Generic failure',
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(mockShowMessage).toHaveBeenCalledWith('You already have a board with this configuration', 'error');
  });

  it('delegates to onError instead of showing a toast when provided', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const clientError = Object.assign(new Error('GraphQL Error'), {
      response: { errors: [{ message: 'You already have a board with this configuration' }] },
    });
    mockRequest.mockRejectedValue(clientError);

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Generic failure',
        onError,
      }),
    );

    let returnValue: unknown;
    await act(async () => {
      returnValue = await result.current.execute({ input: 'test' });
    });

    expect(returnValue).toBeNull();
    expect(onError).toHaveBeenCalledWith(clientError, 'You already have a board with this configuration');
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('passes a null server message to onError for non-GraphQL failures', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const error = new Error('Network down');
    mockRequest.mockRejectedValue(error);

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Generic failure',
        onError,
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(onError).toHaveBeenCalledWith(error, null);
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('awaits an async onError so its side-effects are visible before execute resolves', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    mockRequest.mockRejectedValue(new Error('Network error'));

    const sideEffect = vi.fn();
    const onError = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      sideEffect();
    });

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Failed',
        onError,
      }),
    );

    await act(async () => {
      await result.current.execute({ input: 'test' });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it('returns token from useWsAuthToken', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: 'my-token-abc',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() =>
      useEntityMutation('SOME_MUTATION', {
        errorMessage: 'Failed',
      }),
    );

    expect(result.current.token).toBe('my-token-abc');
  });
});
