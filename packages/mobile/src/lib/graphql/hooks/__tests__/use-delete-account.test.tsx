// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_DELETE_ACCOUNT_INFO, DELETE_ACCOUNT } from '@boardsesh/graphql/operations/account';

// These hooks back the App Store-required account-deletion flow. Pin: the info
// query surfaces the published-climb count (those climbs survive deletion, so
// the screen offers to strip the setter name), and the mutation forwards the
// removeSetterName choice and returns the server's boolean. Import the hook file
// directly (not the barrel) so we only mock the GraphQL client — the barrel
// transitively pulls react-native / expo via its other re-exports.
const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { useDeleteAccountInfo, useDeleteAccount } from '../use-delete-account';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useDeleteAccountInfo', () => {
  it('selects the published-climb count from the response', async () => {
    requestMock.mockResolvedValue({ deleteAccountInfo: { publishedClimbCount: 7 } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccountInfo(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(7);
    expect(requestMock).toHaveBeenCalledWith(GET_DELETE_ACCOUNT_INFO);
  });

  it('does not fetch when disabled', async () => {
    requestMock.mockResolvedValue({ deleteAccountInfo: { publishedClimbCount: 0 } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccountInfo({ enabled: false }), { wrapper: Wrapper });

    // A disabled query reports fetchStatus 'idle' and never fires its queryFn —
    // assert on that state rather than racing a real timer.
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('useDeleteAccount', () => {
  it('forwards removeSetterName and returns the server boolean', async () => {
    requestMock.mockResolvedValue({ deleteAccount: true });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    const deleted = await result.current.mutateAsync({ input: { removeSetterName: true } });

    expect(deleted).toBe(true);
    expect(requestMock).toHaveBeenCalledWith(DELETE_ACCOUNT, { input: { removeSetterName: true } });
  });

  it('surfaces a rejected mutation to the caller', async () => {
    requestMock.mockRejectedValue(new Error('boom'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ input: { removeSetterName: false } })).rejects.toThrow('boom');
  });
});
