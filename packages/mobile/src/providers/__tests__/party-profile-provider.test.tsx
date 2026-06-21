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

// The provider injects expo-crypto's randomUUID into ensureProfile (Hermes has
// no global crypto.randomUUID). Mock the native module so the suite stays in the
// node/jsdom env, and so a created profile's id is deterministic — see the mount
// test below, which asserts the id comes from this injected generator.
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

// AuthProvider transitively imports expo-router; stub the consumed surface
// so we can test PartyProfileProvider in isolation.
vi.mock('../auth-provider', () => ({
  useAuth: vi.fn(),
}));

// The provider now reads the authenticated profile (useProfile) and reconciles
// PostHog identity, which pulls in the AsyncStorage-backed alias-dedupe store.
// Stub both so this suite stays focused on party-profile loading and runs in the
// node/jsdom env without a QueryClient or native AsyncStorage.
const { useProfileMock } = vi.hoisted(() => ({
  useProfileMock: vi.fn<
    () => { data: { displayName?: string; avatarUrl?: string; id?: string; email?: string } | undefined }
  >(() => ({ data: undefined })),
}));
vi.mock('../../lib/graphql/hooks', () => ({ useProfile: useProfileMock }));
vi.mock('../../lib/analytics-alias-store', () => ({
  aliasDedupeStore: { hasRecordedAlias: () => false, recordAlias: () => {} },
}));

import { PartyProfileProvider, usePartyProfile } from '../party-profile-provider';
import { useAuth } from '../auth-provider';

const useAuthMock = vi.mocked(useAuth);

describe('PartyProfileProvider', () => {
  beforeEach(async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as { __reset: () => void };
    secureStore.__reset();
    useProfileMock.mockReturnValue({ data: undefined });
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      signInWithApple: vi.fn(),
      signInWithGoogle: vi.fn(),
      signInWithGoogleWeb: vi.fn(),
      signInWithAppleWeb: vi.fn(),
      signInWithCredentials: vi.fn(),
      register: vi.fn(),
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
    // The id must come from the injected expo-crypto generator, not the shared
    // default. If the `randomUUID` arg is dropped, the provider falls back to
    // jsdom's real crypto.randomUUID (a genuine UUID, not 'test-uuid') and this
    // fails — guarding against the Hermes "crypto.randomUUID unavailable" bug.
    expect(result.current.profile?.id).toBe('test-uuid');
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
      signInWithApple: vi.fn(),
      signInWithGoogle: vi.fn(),
      signInWithGoogleWeb: vi.fn(),
      signInWithAppleWeb: vi.fn(),
      signInWithCredentials: vi.fn(),
      register: vi.fn(),
      signOut: vi.fn(),
      refreshAuthState: vi.fn(),
    });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAuthenticated).toBe(true);
  });

  it('username and avatarUrl are undefined while the authenticated profile is unloaded', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.username).toBeUndefined();
    expect(result.current.avatarUrl).toBeUndefined();
  });

  it('surfaces displayName and avatarUrl from the authenticated profile once it loads', async () => {
    useAuthMock.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      signInWithApple: vi.fn(),
      signInWithGoogle: vi.fn(),
      signInWithGoogleWeb: vi.fn(),
      signInWithAppleWeb: vi.fn(),
      signInWithCredentials: vi.fn(),
      register: vi.fn(),
      signOut: vi.fn(),
      refreshAuthState: vi.fn(),
    });
    useProfileMock.mockReturnValue({
      data: { id: 'user-1', email: 'climber@example.com', displayName: 'Crux Crusher', avatarUrl: 'https://img/a.png' },
    });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.username).toBe('Crux Crusher');
    expect(result.current.avatarUrl).toBe('https://img/a.png');
  });

  it('usePartyProfile throws when called outside a provider', () => {
    expect(() => renderHook(() => usePartyProfile())).toThrow(/must be used within a PartyProfileProvider/);
  });
});
