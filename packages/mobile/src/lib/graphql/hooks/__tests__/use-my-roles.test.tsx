// @vitest-environment jsdom
//
// What the moderator gate is handed. The hook only fetches and normalises the
// role rows — each card answers "may I moderate THIS board?" itself with
// `rolesGrantAdminOrLeader` (tested in @boardsesh/community-roles), because the
// feed mixes boards. Two failure modes here are silent and would ship buttons
// the server then rejects:
//   - a failed or signed-out roles query must read as "no roles", never as
//     "unknown, assume yes";
//   - the empty answer must keep ONE identity, or every card re-renders.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommunityRoleAssignment } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({ token: 'token' as string | null }));

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => ({ data: authState.token }) }));

import { useMyRoles } from '../use-my-roles';

function makeRole(overrides: Partial<CommunityRoleAssignment>): CommunityRoleAssignment {
  return {
    id: 1,
    userId: 'u1',
    role: 'community_leader',
    boardType: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  } as CommunityRoleAssignment;
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

beforeEach(() => {
  requestMock.mockReset();
  authState.token = 'token';
});

describe('useMyRoles', () => {
  it('does not query while signed out', async () => {
    authState.token = null;
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMyRoles(), { wrapper: Wrapper });

    await Promise.resolve();
    expect(requestMock).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it('normalises the optional board scope to null', async () => {
    requestMock.mockResolvedValue({ myRoles: [makeRole({ role: 'admin', boardType: undefined })] });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMyRoles(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toEqual({ role: 'admin', boardType: null });
  });

  it('keeps one identity for the empty answer so the card list does not churn', () => {
    authState.token = null;
    const { Wrapper } = makeWrapper();
    const { result, rerender } = renderHook(() => useMyRoles(), { wrapper: Wrapper });

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('reads as no roles when the query fails, never as "unknown"', async () => {
    // An older backend without `myRoles` answers with a schema error that will
    // never succeed. Failing to an empty list hides the moderator buttons; the
    // other direction would offer verdicts the server rejects.
    requestMock.mockRejectedValue(new Error('no such field: myRoles'));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMyRoles(), { wrapper: Wrapper });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('carries the board scope through so a card can answer per board', async () => {
    requestMock.mockResolvedValue({ myRoles: [makeRole({ role: 'community_leader', boardType: 'kilter' })] });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMyRoles(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toEqual({ role: 'community_leader', boardType: 'kilter' });
  });
});
