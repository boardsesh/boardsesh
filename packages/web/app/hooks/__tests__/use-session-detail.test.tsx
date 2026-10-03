import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import { GET_SESSION_DETAIL } from '@boardsesh/graphql/operations/activity-feed';
import { SESSION_DETAIL_QUERY_KEY, useSessionDetail } from '../use-session-detail';

const { request, authToken } = vi.hoisted(() => ({
  request: vi.fn(),
  authToken: vi.fn(),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => authToken(),
}));

describe('useSessionDetail', () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ sessionDetail: null });
    authToken.mockReturnValue({ token: 'token', isAuthenticated: true });
  });

  it('uses a distinct cache key and request variable for a scoped daily target', async () => {
    const sessionId = 'daily:user-1:2026-10-03';
    const highlightTickUuid = 'tick-a';
    const { result } = renderHook(() => useSessionDetail({ sessionId, highlightTickUuid }), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    expect(request).toHaveBeenCalledWith(GET_SESSION_DETAIL, { sessionId, highlightTickUuid });
    expect(SESSION_DETAIL_QUERY_KEY(sessionId, highlightTickUuid)).toEqual([
      'sessionDetail',
      sessionId,
      highlightTickUuid,
    ]);
    expect(SESSION_DETAIL_QUERY_KEY('party-1')).toEqual(['sessionDetail', 'party-1']);
    expect(result.current.session).toBeNull();
  });
});
