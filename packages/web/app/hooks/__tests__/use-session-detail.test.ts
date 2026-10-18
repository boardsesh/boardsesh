import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSessionDetail } from '../use-session-detail';

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations/activity-feed', () => ({
  GET_SESSION_DETAIL: 'GET_SESSION_DETAIL_QUERY',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

// The page renders on the server signed out, so its copy names nobody a
// signed-out reader may not see.
const serverCopy = { sessionId: 'session-1', participants: [] } as unknown as SessionDetail;
const memberCopy = {
  sessionId: 'session-1',
  participants: [{ userId: 'private-friend', displayName: 'Private Friend' }],
} as unknown as SessionDetail;

describe('useSessionDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ sessionDetail: memberCopy });
  });

  it('refetches the signed-out server copy once a signed-in viewer’s token is in', async () => {
    mockUseWsAuthToken.mockReturnValue({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null });

    const { result } = renderHook(() => useSessionDetail({ sessionId: 'session-1', initialData: serverCopy }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.session).toBe(serverCopy);
    await waitFor(() => expect(result.current.session).toEqual(memberCopy));
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('refetches when the token arrives after the first render', async () => {
    mockUseWsAuthToken.mockReturnValue({ token: null, isAuthenticated: false, isLoading: true, error: null });
    const { result, rerender } = renderHook(
      () => useSessionDetail({ sessionId: 'session-1', initialData: serverCopy }),
      { wrapper: createQueryWrapper() },
    );
    expect(mockRequest).not.toHaveBeenCalled();

    mockUseWsAuthToken.mockReturnValue({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null });
    rerender();
    await waitFor(() => expect(result.current.session).toEqual(memberCopy));
  });

  it('keeps the server copy for a signed-out reader', () => {
    mockUseWsAuthToken.mockReturnValue({ token: null, isAuthenticated: false, isLoading: false, error: null });

    const { result } = renderHook(() => useSessionDetail({ sessionId: 'session-1', initialData: serverCopy }), {
      wrapper: createQueryWrapper(),
    });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.session).toBe(serverCopy);
  });
});
