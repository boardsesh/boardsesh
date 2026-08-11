// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getAuthToken } = vi.hoisted(() => ({ getAuthToken: vi.fn<() => Promise<string | null>>() }));

vi.mock('../../lib/auth-store', () => ({ getAuthToken }));

import { useStoredUserId } from '../use-current-user-id';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tokenForUser(userId: string): string {
  return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify({ sub: userId }))}.signature`;
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useStoredUserId', () => {
  beforeEach(() => {
    getAuthToken.mockReset();
  });

  it('resolves the id from the stored JWT', async () => {
    getAuthToken.mockResolvedValue(tokenForUser('user-42'));
    const { result } = renderHook(() => useStoredUserId(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe('user-42'));
  });

  it('stays undefined when the keychain has no token', async () => {
    getAuthToken.mockResolvedValue(null);
    const { result } = renderHook(() => useStoredUserId(true), { wrapper: wrapper() });
    await waitFor(() => expect(getAuthToken).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('stays undefined when the stored token is malformed', async () => {
    getAuthToken.mockResolvedValue('not-a-jwt');
    const { result } = renderHook(() => useStoredUserId(true), { wrapper: wrapper() });
    await waitFor(() => expect(getAuthToken).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('never touches the keychain while disabled (signed out, or the profile already answered)', async () => {
    getAuthToken.mockResolvedValue(tokenForUser('user-42'));
    const { result } = renderHook(() => useStoredUserId(false), { wrapper: wrapper() });
    await Promise.resolve();
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
  });
});
