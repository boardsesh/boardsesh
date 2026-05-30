// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  return {
    getItemAsync: vi.fn(async (key: string) => storage[key] ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      storage[key] = value;
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      delete storage[key];
    }),
    __reset: () => {
      storage = {};
    },
    __setRaw: (key: string, value: string) => {
      storage[key] = value;
    },
  };
});

// AuthProvider transitively imports expo-router; stub the consumed surface
// so we can test PartyProfileProvider in isolation.
vi.mock('../auth-provider', () => ({
  useAuth: vi.fn(),
}));

import { PartyProfileProvider, usePartyProfile } from '../party-profile-provider';
import { useAuth } from '../auth-provider';

const useAuthMock = vi.mocked(useAuth);

describe('PartyProfileProvider', () => {
  beforeEach(async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as { __reset: () => void };
    secureStore.__reset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      signIn: vi.fn(),
      signInWithCredentials: vi.fn(),
      signOut: vi.fn(),
      refreshAuthState: vi.fn(),
    });
  });

  it('loads or creates a party profile on mount', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });

    // Initially loading, no profile.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.profile).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.profile).not.toBeNull();
    expect(typeof result.current.profile?.id).toBe('string');
    expect(result.current.hasProfile).toBe(true);
  });

  it('reuses an existing stored profile rather than creating a new one', async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    secureStore.__setRaw('boardsesh_party_profile', JSON.stringify({ id: 'stored-uuid' }));

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.profile).toEqual({ id: 'stored-uuid' });
  });

  it('mirrors `isAuthenticated` from the AuthProvider', async () => {
    useAuthMock.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      signIn: vi.fn(),
      signInWithCredentials: vi.fn(),
      signOut: vi.fn(),
      refreshAuthState: vi.fn(),
    });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAuthenticated).toBe(true);
  });

  it('username and avatarUrl remain undefined until issue #2392 wires the backend profile fetch', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.username).toBeUndefined();
    expect(result.current.avatarUrl).toBeUndefined();
  });

  it('usePartyProfile throws when called outside a provider', () => {
    expect(() => renderHook(() => usePartyProfile())).toThrow(/must be used within a PartyProfileProvider/);
  });
});
