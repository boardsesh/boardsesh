// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useReviewSprayWall,
  useSprayModerationAccess,
  useSprayWallReports,
  SPRAY_REPORTS_QUERY_KEY,
} from '../use-spray-moderation';

const state = vi.hoisted(() => ({
  authToken: 'session-a' as string | null,
  resolved: true,
  spray: true,
  moderation: true,
  roles: [{ role: 'admin', boardType: 'spray' }] as { role: string; boardType: string | null }[],
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: state.authToken }) }));
vi.mock('../../graphql/hooks/use-my-roles', () => ({ useMyRoles: () => state.roles }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlagsResolved: () => state.resolved,
  useSprayWallsEnabled: () => state.spray,
  useClimbModerationEnabled: () => state.moderation,
}));
const report = {
  id: '1',
  wallUuid: 'wall-a',
  wallName: 'Crew wall',
  layoutId: 7,
  reason: 'OTHER' as const,
  hidden: false,
  createdAt: '2026-10-01',
  photo: null,
};
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
beforeEach(() => {
  Object.assign(state, {
    authToken: 'session-a',
    resolved: true,
    spray: true,
    moderation: true,
    roles: [{ role: 'admin', boardType: 'spray' }],
  });
  request.mockReset();
});
describe('spray moderation access', () => {
  it.each(['resolved', 'spray', 'moderation'] as const)(
    'blocks reporting and admin review when %s is false',
    (flag) => {
      state[flag] = false;
      const { result } = renderHook(useSprayModerationAccess);
      expect(result.current).toMatchObject({ canReport: false, canReview: false });
    },
  );
  it('lets signed-in non-editors report but rejects leader access to review', () => {
    state.roles = [{ role: 'community_leader', boardType: 'spray' }];
    const { result } = renderHook(useSprayModerationAccess);
    expect(result.current).toMatchObject({ canReport: true, canReview: false });
  });
  it('requires authentication even if roles remain cached and changes opaque scopes on account switch', () => {
    const { result, rerender } = renderHook(useSprayModerationAccess);
    const priorScope = result.current.sessionScope;
    state.authToken = 'session-b';
    rerender();
    expect(result.current.sessionScope).not.toBe(priorScope);
    state.authToken = null;
    rerender();
    expect(result.current).toMatchObject({ canReport: false, canReview: false });
  });
  it('accepts global admins but rejects admins for another board', () => {
    state.roles = [{ role: 'admin', boardType: 'kilter' }];
    const { result, rerender } = renderHook(useSprayModerationAccess);
    expect(result.current.canReview).toBe(false);
    state.roles = [{ role: 'admin', boardType: null }];
    rerender();
    expect(result.current.canReview).toBe(true);
  });
});
describe('private spray report query', () => {
  it('retains all reports when a review mutation fails', async () => {
    const { client, wrapper } = harness();
    client.setQueryData([...SPRAY_REPORTS_QUERY_KEY, 1], [report]);
    request.mockRejectedValue(new Error('Server unavailable'));
    const { result, unmount } = renderHook(useReviewSprayWall, { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ input: { uuid: 'wall-a', hidden: true } })).rejects.toThrow(
        'Server unavailable',
      );
    });
    expect(client.getQueryData([...SPRAY_REPORTS_QUERY_KEY, 1])).toEqual([report]);
    unmount();
    client.clear();
  });

  it('does not fetch without access and removes previews when access disappears', async () => {
    const { client, wrapper } = harness();
    request.mockResolvedValue({ sprayWallReports: [report] });
    const { result, rerender, unmount } = renderHook(({ enabled }) => useSprayWallReports(enabled, 17), {
      initialProps: { enabled: false },
      wrapper,
    });
    expect(request).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(request.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    rerender({ enabled: false });
    await waitFor(() => expect(client.getQueryData([...SPRAY_REPORTS_QUERY_KEY, 17])).toBeUndefined());
    unmount();
    client.clear();
  });
  it.each([true, false])('removes reviewed wall rows and invalidates visibility after hidden=%s', async (hidden) => {
    const { client, wrapper } = harness();
    client.setQueryData([...SPRAY_REPORTS_QUERY_KEY, 1], [report, { ...report, id: '2', wallUuid: 'wall-b' }]);
    client.setQueryData(['nearbyBoards'], []);
    client.setQueryData(['searchBoards'], []);
    request.mockResolvedValue({ setSprayWallHidden: { uuid: 'wall-a', layoutId: 7, hidden, hiddenAt: null } });
    const { result, unmount } = renderHook(useReviewSprayWall, { wrapper });
    await act(() => result.current.mutateAsync({ input: { uuid: 'wall-a', hidden } }));
    expect(client.getQueryData([...SPRAY_REPORTS_QUERY_KEY, 1])).toEqual([{ ...report, id: '2', wallUuid: 'wall-b' }]);
    expect(client.getQueryState(['nearbyBoards'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['searchBoards'])?.isInvalidated).toBe(true);
    unmount();
    client.clear();
  });
});
