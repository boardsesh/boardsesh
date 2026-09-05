// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { resolveAccessCapabilities } from '@boardsesh/party-profile';

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
    () => {
      data:
        | {
            displayName?: string;
            avatarUrl?: string;
            id?: string;
            email?: string;
            isTester?: boolean;
            createdAt?: string;
            favoriteCount?: number;
          }
        | undefined;
    }
  >(() => ({ data: undefined })),
}));
vi.mock('../../lib/graphql/hooks', () => ({ useProfile: useProfileMock }));
vi.mock('../../lib/analytics-alias-store', () => ({
  aliasDedupeStore: { hasRecordedAlias: () => false, recordAlias: () => {} },
}));

// The cohort-person-properties effect also reads the home board and connected
// integrations — both pull in real GraphQL hooks / AsyncStorage transitively.
// Stub them the same way as useProfile so this suite stays isolated.
const { useHomeBoardMock, useIntegrationStatusesMock } = vi.hoisted(() => ({
  useHomeBoardMock: vi.fn(() => ({ board: null, boards: [], isResolving: false })),
  useIntegrationStatusesMock: vi.fn<() => { data: unknown }>(() => ({ data: undefined })),
}));
vi.mock('../../lib/graphql/hooks/use-home-board', () => ({ useHomeBoard: useHomeBoardMock }));
vi.mock('../../lib/graphql/hooks/use-integrations', () => ({ useIntegrationStatuses: useIntegrationStatusesMock }));

// identify/alias/reset are exercised for real elsewhere in this suite (they're
// no-ops with no PostHog key in the test env); setPersonProperties is mocked
// here so the cohort-person-properties effect's call is directly assertable.
const { identifyMock, aliasMock, resetMock, setPersonPropertiesMock } = vi.hoisted(() => ({
  identifyMock: vi.fn(),
  aliasMock: vi.fn(),
  resetMock: vi.fn(),
  setPersonPropertiesMock: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({
  identify: identifyMock,
  alias: aliasMock,
  reset: resetMock,
  setPersonProperties: setPersonPropertiesMock,
}));

import { PartyProfileProvider, usePartyProfile } from '../party-profile-provider';
import { useAuth } from '../auth-provider';

const useAuthMock = vi.mocked(useAuth);

function makeAuthMock(overrides: Partial<ReturnType<typeof useAuth>> = {}): ReturnType<typeof useAuth> {
  const isAuthenticated = overrides.isAuthenticated ?? false;
  const accessMode = overrides.accessMode ?? 'account';
  return {
    isAuthenticated,
    isLoading: false,
    accessMode,
    accessCapabilities: resolveAccessCapabilities({
      accessMode,
      isAuthenticated,
      localCatalogReady: false,
      platform: 'native',
    }),
    setAccessMode: vi.fn(),
    prepareAccountAuthentication: vi.fn(),
    localCatalogReady: false,
    localOwnerReady: false,
    setLocalCatalogReady: vi.fn(),
    setLocalOwnerReady: vi.fn(),
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithGoogleWeb: vi.fn(),
    signInWithAppleWeb: vi.fn(),
    signInWithCredentials: vi.fn(),
    register: vi.fn(),
    signOut: vi.fn(),
    refreshAuthState: vi.fn(),
    ...overrides,
  };
}

describe('PartyProfileProvider', () => {
  beforeEach(async () => {
    const secureStore = (await import('expo-secure-store')) as unknown as { __reset: () => void };
    secureStore.__reset();
    useProfileMock.mockReturnValue({ data: undefined });
    useHomeBoardMock.mockReturnValue({ board: null, boards: [], isResolving: false });
    useIntegrationStatusesMock.mockReturnValue({ data: undefined });
    identifyMock.mockClear();
    aliasMock.mockClear();
    resetMock.mockClear();
    setPersonPropertiesMock.mockClear();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue(makeAuthMock());
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
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));

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
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({
      data: { id: 'user-1', email: 'climber@example.com', displayName: 'Crux Crusher', avatarUrl: 'https://img/a.png' },
    });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.username).toBe('Crux Crusher');
    expect(result.current.avatarUrl).toBe('https://img/a.png');
  });

  it('sets durable cohort person properties once the authenticated profile and home board resolve', async () => {
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({
      data: {
        id: 'user-1',
        email: 'climber@example.com',
        isTester: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        favoriteCount: 5,
      },
    });
    useHomeBoardMock.mockReturnValue({
      board: { boardType: 'kilter' } as never,
      boards: [],
      isResolving: false,
    });
    useIntegrationStatusesMock.mockReturnValue({ data: [{ provider: 'STRAVA', connected: true }] });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await waitFor(() => expect(setPersonPropertiesMock).toHaveBeenCalled());
    expect(setPersonPropertiesMock).toHaveBeenLastCalledWith(
      {
        role: 'tester',
        primary_board: 'kilter',
        favorite_count: 5,
        integrations_connected_count: 1,
      },
      { first_seen_at: '2024-01-01T00:00:00.000Z' },
    );
  });

  it('fires again with the complete payload once integrations resolve after the initial partial fire', async () => {
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({
      data: {
        id: 'user-1',
        email: 'climber@example.com',
        isTester: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        favoriteCount: 2,
      },
    });
    useHomeBoardMock.mockReturnValue({
      board: { boardType: 'kilter' } as never,
      boards: [],
      isResolving: false,
    });
    // Integrations haven't loaded yet on the first render.
    useIntegrationStatusesMock.mockReturnValue({ data: undefined });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result, rerender } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await waitFor(() => expect(setPersonPropertiesMock).toHaveBeenCalledTimes(1));
    expect(setPersonPropertiesMock.mock.calls[0][0]).toEqual({
      role: 'user',
      primary_board: 'kilter',
      favorite_count: 2,
      integrations_connected_count: undefined,
    });

    // Integrations resolve — the effect must fire again with the complete payload.
    useIntegrationStatusesMock.mockReturnValue({ data: [{ provider: 'STRAVA', connected: true }] });
    rerender();

    await waitFor(() => expect(setPersonPropertiesMock).toHaveBeenCalledTimes(2));
    expect(setPersonPropertiesMock.mock.calls[1][0]).toEqual({
      role: 'user',
      primary_board: 'kilter',
      favorite_count: 2,
      integrations_connected_count: 1,
    });
  });

  it('never sets cohort person properties while signed out', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(setPersonPropertiesMock).not.toHaveBeenCalled();
  });

  it('keeps the local UUID but disables account queries and cohort effects in local mode', async () => {
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true, accessMode: 'local' }));
    useProfileMock.mockReturnValue({
      data: { id: 'retained-user', email: 'retained@example.com', displayName: 'Must stay hidden' },
    });

    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    const { result } = renderHook(() => usePartyProfile(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.profile?.id).toBe('test-uuid');
    expect(useProfileMock).toHaveBeenCalledWith({ enabled: false });
    expect(useHomeBoardMock).toHaveBeenCalledWith({ enabled: false });
    expect(useIntegrationStatusesMock).toHaveBeenCalledWith({ enabled: false });
    expect(identifyMock).not.toHaveBeenCalled();
    expect(aliasMock).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
    expect(setPersonPropertiesMock).not.toHaveBeenCalled();
  });

  it('usePartyProfile throws when called outside a provider', () => {
    expect(() => renderHook(() => usePartyProfile())).toThrow(/must be used within a PartyProfileProvider/);
  });
});
