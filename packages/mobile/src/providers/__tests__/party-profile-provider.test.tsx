// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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
// PostHog identity. Stub the profile read so this suite runs in the node/jsdom
// env without a QueryClient.
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

// The cohort-person-properties effect also reads the home board and connected
// integrations — both pull in real GraphQL hooks / AsyncStorage transitively.
// Stub them the same way as useProfile so this suite stays isolated.
const { useHomeBoardMock, useIntegrationStatusesMock } = vi.hoisted(() => ({
  useHomeBoardMock: vi.fn(() => ({ board: null, boards: [], isResolving: false })),
  useIntegrationStatusesMock: vi.fn<() => { data: unknown }>(() => ({ data: undefined })),
}));
vi.mock('../../lib/graphql/hooks/use-home-board', () => ({ useHomeBoard: useHomeBoardMock }));
vi.mock('../../lib/graphql/hooks/use-integrations', () => ({ useIntegrationStatuses: useIntegrationStatusesMock }));

// setPersonProperties is mocked so the cohort-person-properties effect's call is
// directly assertable. identify, reset and setPersonProperties also record into
// one ordered list, `wireCalls`, with the distinct id each went out under, so
// the tests can assert the exact sequence PostHog would receive. They move a
// small model of the SDK's two ids the way @posthog/core does, because the
// provider decides what to send by reading those ids back. The mock exposes no
// merge call besides identify: the provider must not import one (see the header
// of packages/shared/analytics/src/reconcile-identity.ts).
const { setPersonPropertiesMock, identityCalls, wireCalls, sdk } = vi.hoisted(() => ({
  setPersonPropertiesMock: vi.fn(),
  identityCalls: [] as Array<[method: string, ...args: unknown[]]>,
  // Every call that puts something on the wire, in order: [method, distinct id
  // the event is sent under].
  wireCalls: [] as Array<[method: string, sentAs: string]>,
  sdk: {
    // False models dev / no PostHog key: there is no client at all.
    enabled: true,
    // False models the first moments of a launch, before the SDK has read its
    // storage: it cannot say who it is and onAnalyticsReady defers.
    loaded: true,
    anonymousId: 'sdk-anon-1' as string,
    distinctId: null as string | null,
    resets: 0,
    pendingReady: [] as Array<() => void>,
  },
}));
vi.mock('../../lib/analytics', () => ({
  identify: (distinctId: string, properties?: unknown) => {
    identityCalls.push(['identify', distinctId, properties]);
    const previousDistinctId = sdk.distinctId ?? sdk.anonymousId;
    if (distinctId === previousDistinctId) return;
    sdk.anonymousId = previousDistinctId;
    sdk.distinctId = distinctId;
    wireCalls.push(['$identify', distinctId]);
  },
  reset: () => {
    identityCalls.push(['reset']);
    sdk.resets += 1;
    sdk.anonymousId = `sdk-anon-after-reset-${sdk.resets}`;
    sdk.distinctId = null;
  },
  setPersonProperties: (...args: unknown[]) => {
    wireCalls.push(['$set', sdk.distinctId ?? sdk.anonymousId]);
    setPersonPropertiesMock(...args);
  },
  getAnalyticsIdentity: () =>
    sdk.enabled && sdk.loaded ? { distinctId: sdk.distinctId ?? sdk.anonymousId, anonymousId: sdk.anonymousId } : null,
  // Like the real one: runs the callback before returning once the SDK is
  // loaded, and waits for the load otherwise (`finishSdkLoad` below).
  onAnalyticsReady: (callback: () => void) => {
    if (!sdk.enabled) return () => {};
    if (sdk.loaded) {
      callback();
      return () => {};
    }
    let cancelled = false;
    sdk.pendingReady.push(() => {
      if (!cancelled) callback();
    });
    return () => {
      cancelled = true;
    };
  },
}));

import { PartyProfileProvider, usePartyProfile } from '../party-profile-provider';
import { useAuth } from '../auth-provider';

const useAuthMock = vi.mocked(useAuth);

function makeAuthMock(overrides: Partial<ReturnType<typeof useAuth>> = {}): ReturnType<typeof useAuth> {
  return {
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
    setPersonPropertiesMock.mockClear();
    identityCalls.length = 0;
    wireCalls.length = 0;
    sdk.enabled = true;
    sdk.loaded = true;
    sdk.pendingReady.length = 0;
    sdk.anonymousId = 'sdk-anon-1';
    sdk.distinctId = null;
    sdk.resets = 0;
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
        email: 'climber@example.com',
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
      email: 'climber@example.com',
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
      email: 'climber@example.com',
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

  // Lets any effect a re-render queued run.
  async function settleIdentity(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  // The SDK finishes reading its storage: waiting callbacks run in the order
  // they registered, as promise continuations do.
  async function finishSdkLoad(): Promise<void> {
    await act(async () => {
      sdk.loaded = true;
      const waiting = sdk.pendingReady.splice(0);
      for (const run of waiting) run();
    });
  }

  function renderProvider() {
    const wrapper = ({ children }: { children: ReactNode }) => <PartyProfileProvider>{children}</PartyProfileProvider>;
    return renderHook(() => usePartyProfile(), { wrapper });
  }

  it('sends no identity call for a signed-out device, and never uses the party UUID as an analytics id', async () => {
    const { result, rerender } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();
    rerender();
    await settleIdentity();

    expect(result.current.profile?.id).toBe('test-uuid');
    expect(identityCalls).toEqual([]);
    expect(sdk.anonymousId).toBe('sdk-anon-1');
  });

  it('signs a climber in with one identify and nothing else', async () => {
    // Fresh install, then sign-in to an account. The SDK is on its own
    // anonymous id; the sign-in must add exactly identify(user), which is the
    // call that lets PostHog merge the two.
    const { result, rerender } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();
    expect(identityCalls).toEqual([]);

    // The session lands before the profile fetch: hold, send nothing.
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    rerender();
    await settleIdentity();
    expect(identityCalls).toEqual([]);

    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com' } });
    rerender();
    await settleIdentity();

    expect(identityCalls).toEqual([['identify', 'user-1', { email: 'climber@example.com' }]]);
    // The anonymous id that carried the pre-login events is the one merged.
    expect(sdk.anonymousId).toBe('sdk-anon-1');

    // Later renders must not send it again.
    rerender();
    await settleIdentity();
    expect(identityCalls).toHaveLength(1);
  });

  it('sends nothing on a cold start already identified as this user', async () => {
    sdk.distinctId = 'user-1';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com' } });

    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    expect(identityCalls).toEqual([]);
  });

  it('resets once on sign-out and does not identify', async () => {
    sdk.distinctId = 'user-1';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com' } });
    const { result, rerender } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: false }));
    useProfileMock.mockReturnValue({ data: undefined });
    rerender();
    await settleIdentity();
    rerender();
    await settleIdentity();

    expect(identityCalls).toEqual([['reset']]);
  });

  it('does not reset again when AuthProvider already reset during its sign-out cleanup', async () => {
    // Native publishes the signed-out state after its cleanup has reset the SDK.
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: false }));
    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    expect(identityCalls).toEqual([]);
  });

  it('resets before identifying when the SDK is pinned to another account', async () => {
    sdk.distinctId = 'user-other';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com' } });

    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    expect(identityCalls).toEqual([['reset'], ['identify', 'user-1', { email: 'climber@example.com' }]]);
  });

  it('clears an install the old routine left pinned to its party UUID, once', async () => {
    // What an OTA finds on a signed-out device that ran the previous bundle.
    sdk.distinctId = 'test-uuid';
    const { result, rerender } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();
    rerender();
    await settleIdentity();

    expect(identityCalls).toEqual([['reset']]);
  });

  it('waits for auth to resolve before touching identity', async () => {
    sdk.distinctId = 'user-1';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: false, isLoading: true }));
    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    // A still-loading session reads as signed out; resetting here would throw
    // a signed-in climber's identity away on every launch.
    expect(identityCalls).toEqual([]);
  });

  it('drops a reconcile that the next auth state superseded before the SDK was ready', async () => {
    sdk.loaded = false;
    sdk.distinctId = 'user-1';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: false }));
    const { rerender } = renderProvider();
    // Before the SDK has loaded, auth flips to signed in as user-1.
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com' } });
    rerender();
    await finishSdkLoad();

    expect(identityCalls).toEqual([]);
  });

  // The profile that carries the cohort traits is the same one that triggers
  // the identify, so both effects fire in one commit. The traits include the
  // account's email: sent first, they would land on the anonymous person, and
  // reach the account only if PostHog then agreed to merge the two.
  it('identifies before it sets person properties on sign-in, and sets them on the user', async () => {
    const { result, rerender } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com', isTester: false } });
    rerender();
    await settleIdentity();

    expect(wireCalls).toEqual([
      ['$identify', 'user-1'],
      ['$set', 'user-1'],
    ]);
  });

  it('keeps that order when the SDK finishes loading after the profile arrived', async () => {
    sdk.loaded = false;
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com', isTester: false } });
    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(wireCalls).toEqual([]);

    await finishSdkLoad();

    expect(wireCalls).toEqual([
      ['$identify', 'user-1'],
      ['$set', 'user-1'],
    ]);
  });

  it('never sets person properties on the id a previous account or the old routine left behind', async () => {
    // Pinned to another id (an old-bundle install on its party UUID, or the last
    // account) when this user's profile lands.
    sdk.distinctId = 'test-uuid';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com', isTester: false } });
    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    expect(identityCalls.map(([method]) => method)).toEqual(['reset', 'identify']);
    expect(wireCalls).toEqual([
      ['$identify', 'user-1'],
      ['$set', 'user-1'],
    ]);
  });

  it('sets person properties without an identify on a cold start already on this user', async () => {
    sdk.distinctId = 'user-1';
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com', isTester: false } });
    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    expect(wireCalls).toEqual([['$set', 'user-1']]);
  });

  it('does nothing when analytics is disabled', async () => {
    sdk.enabled = false;
    useAuthMock.mockReturnValue(makeAuthMock({ isAuthenticated: true }));
    useProfileMock.mockReturnValue({ data: { id: 'user-1', email: 'climber@example.com' } });
    const { result } = renderProvider();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settleIdentity();

    expect(identityCalls).toEqual([]);
  });

  it('usePartyProfile throws when called outside a provider', () => {
    expect(() => renderHook(() => usePartyProfile())).toThrow(/must be used within a PartyProfileProvider/);
  });
});
