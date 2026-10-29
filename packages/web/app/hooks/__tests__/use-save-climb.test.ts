import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createBoardAdapterWrapper } from '@/app/test-utils/test-providers';
import type { ExecuteWs } from '@boardsesh/board-react';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useSaveClimb } from '@boardsesh/board-react';

vi.mock('../use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  // The hook returns the key unchanged so tests can assert against the
  // catalog identifier directly — keeps the test independent of locale
  // file contents.
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const { mockExecute, mockDispose, FakeGraphQLOperationError } = vi.hoisted(() => {
  // Mirrors the real GraphQLOperationError: pick the first error that
  // carries a `code`, fall back to the first error's extensions. Keeping
  // the fake in sync prevents tests from quietly passing while the real
  // class's multi-error pickup logic regresses.
  class FakeGraphQLOperationError extends Error {
    readonly extensions: Record<string, unknown> | null;
    constructor(errors: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>) {
      super(errors.map((err) => err.message).join(', '));
      this.name = 'GraphQLOperationError';
      const coded = errors.find((err) => err.extensions && typeof err.extensions.code === 'string');
      this.extensions = coded?.extensions ?? errors[0]?.extensions ?? null;
    }
  }
  return { mockExecute: vi.fn(), mockDispose: vi.fn(), FakeGraphQLOperationError };
});
vi.mock('@/app/lib/realtime/graphql-client', () => ({
  createGraphQLClient: () => ({ dispose: mockDispose }),
  execute: (...args: unknown[]) => mockExecute(...args),
  GraphQLOperationError: FakeGraphQLOperationError,
}));

vi.mock('@boardsesh/graphql/operations/new-climb-feed', () => ({
  SAVE_CLIMB_MUTATION: 'SAVE_CLIMB_MUTATION',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

// The web adapter's executeWs creates+disposes a WS client per call.
// Tests provide an adapter that follows the same pattern so the create /
// execute / dispose lifecycle is exercised end-to-end against the same
// mock surface (`mockExecute`, `mockDispose`) the tests assert on.
// `showError` mirrors the real web adapter: translate the typed reason to
// the same i18n key the snackbar renders and forward to `mockShowMessage`,
// so the fallback-toast path is exercised end-to-end.
function mkWrapper() {
  return createBoardAdapterWrapper(() => ({
    isAuthenticated: mockUseSession().status === 'authenticated',
    isAuthLoading: mockUseSession().status === 'loading',
    executeWs: (async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
      const client = { dispose: mockDispose };
      try {
        return await mockExecute(client, { query, variables });
      } finally {
        void client.dispose();
      }
    }) as unknown as ExecuteWs,
    showError: () => {
      mockShowMessage('createClimbForm.alerts.saveFailedFallback', 'error');
    },
  }));
}

function createClimbOptions() {
  return {
    layout_id: 1,
    name: 'Test Climb',
    description: 'A test climb',
    is_draft: false,
    frames: 'p1r12',
    frames_count: 1,
    frames_pace: 0,
    angle: 40,
  };
}

describe('useSaveClimb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockReset();
    mockDispose.mockReset();
    mockShowMessage.mockReset();
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-1' }, expires: '' },
      update: vi.fn(),
    });
  });

  it('throws when not authenticated', async () => {
    mockUseSession.mockReturnValue({
      status: 'unauthenticated',
      data: null,
      update: vi.fn(),
    });

    const { result } = renderHook(() => useSaveClimb('kilter'), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Authentication required to create climbs');
  });

  it('throws when no board is selected', async () => {
    const { result } = renderHook(() => useSaveClimb(null), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('No board selected');
  });

  it('creates GraphQL client and executes mutation', async () => {
    mockExecute.mockResolvedValue({
      saveClimb: { uuid: 'new-climb-uuid' },
    });

    const { result } = renderHook(() => useSaveClimb('kilter'), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockExecute).toHaveBeenCalled();
    const callArgs = mockExecute.mock.calls[0];
    // First arg is the client, second is { query, variables }
    expect(callArgs[1]).toEqual({
      query: 'SAVE_CLIMB_MUTATION',
      variables: {
        input: {
          boardType: 'kilter',
          layoutId: 1,
          name: 'Test Climb',
          description: 'A test climb',
          isDraft: false,
          frames: 'p1r12',
          framesCount: 1,
          framesPace: 0,
          angle: 40,
          characteristics: null,
        },
      },
    });
  });

  it('returns SaveClimbResponse with uuid', async () => {
    mockExecute.mockResolvedValue({
      saveClimb: { uuid: 'result-uuid-123' },
    });

    const { result } = renderHook(() => useSaveClimb('kilter'), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ uuid: 'result-uuid-123' });
  });

  it('disposes client after success', async () => {
    mockExecute.mockResolvedValue({
      saveClimb: { uuid: 'uuid-1' },
    });

    const { result } = renderHook(() => useSaveClimb('kilter'), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockDispose).toHaveBeenCalled();
  });

  it('shows error snackbar on failure', async () => {
    mockExecute.mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useSaveClimb('kilter'), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Shared hook signals fallback via `showError('saveClimbFailed')`; the
    // wrapper's adapter (mirroring the real web adapter) translates to the
    // catalog key and forwards to `mockShowMessage`.
    expect(mockShowMessage).toHaveBeenCalledWith('createClimbForm.alerts.saveFailedFallback', 'error');
    // The error itself still propagates so per-call onError handlers can
    // observe non-duplicate failures.
    expect(result.current.error?.message).toBe('Network failure');
  });

  it('disposes client even on error (finally block)', async () => {
    mockExecute.mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useSaveClimb('kilter'), {
      wrapper: mkWrapper(),
    });

    await act(async () => {
      result.current.mutate(createClimbOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockDispose).toHaveBeenCalled();
  });
});
