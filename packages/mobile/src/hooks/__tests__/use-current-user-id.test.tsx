// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { readLocalUserId } = vi.hoisted(() => ({
  readLocalUserId: vi.fn<() => Promise<string | undefined>>(),
}));

// The platform fork under this hook is covered by `local-user-id.test.ts` and
// `local-user-id.web.test.ts`; here only the React Query wrapper is under test.
vi.mock('../../lib/local-user-id', () => ({ readLocalUserId }));

import { useStoredUserId } from '../use-current-user-id';

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useStoredUserId', () => {
  beforeEach(() => {
    readLocalUserId.mockReset();
  });

  it('resolves the id the device can answer locally', async () => {
    readLocalUserId.mockResolvedValue('user-42');
    const { result } = renderHook(() => useStoredUserId(true).userId, { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe('user-42'));
  });

  it('stays undefined when the device has no id to answer with', async () => {
    readLocalUserId.mockResolvedValue(undefined);
    const { result } = renderHook(() => useStoredUserId(true).userId, { wrapper: wrapper() });
    await waitFor(() => expect(readLocalUserId).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('caches "no id" as a real answer instead of failing the query', async () => {
    readLocalUserId.mockResolvedValue(undefined);
    const { result } = renderHook(() => useStoredUserId(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.userId).toBeUndefined();
  });

  it('never reads while disabled (signed out, or the profile already answered)', async () => {
    readLocalUserId.mockResolvedValue('user-42');
    const { result } = renderHook(() => useStoredUserId(false), { wrapper: wrapper() });
    await Promise.resolve();
    expect(readLocalUserId).not.toHaveBeenCalled();
    expect(result.current.userId).toBeUndefined();
    // A disabled query is "pending" in React Query terms; callers gate their
    // loading state on this, so it must read as settled.
    expect(result.current.isLoading).toBe(false);
  });

  it('reports the in-flight read so callers can hold their loading state', async () => {
    let releaseUserId!: (userId: string) => void;
    readLocalUserId.mockReturnValue(
      new Promise<string>((resolve) => {
        releaseUserId = resolve;
      }),
    );
    const { result } = renderHook(() => useStoredUserId(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    releaseUserId('user-7');
    await waitFor(() => expect(result.current.userId).toBe('user-7'));
    expect(result.current.isLoading).toBe(false);
  });
});
