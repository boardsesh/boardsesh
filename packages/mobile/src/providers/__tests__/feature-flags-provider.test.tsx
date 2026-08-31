// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FeatureFlagsProvider,
  useAnonymousClimbViewEnabled,
  useBoardseshGradeEnabled,
  useFeatureFlag,
  useFeatureFlagVariant,
  useFeatureFlags,
  useOfflineDownloadProgressEnabled,
  useOfflineDownloadsEnabled,
  useSnapshotBootstrapEnabled,
} from '../feature-flags-provider';
import {
  setFeatureFlagOverride,
  resetFeatureFlagOverridesForTests,
  useFeatureFlagOverrides,
} from '../../lib/feature-flag-overrides';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

describe('FeatureFlagsProvider', () => {
  afterEach(() => {
    // The override store is a module-level singleton; fully reset it (state +
    // cached load promise) AND the persisted mock storage so a value written by
    // one test can't async-load into the next.
    resetFeatureFlagOverridesForTests();
    (AsyncStorage as unknown as { __reset: () => void }).__reset();
  });

  it('returns the empty default bag when no `flags` prop is supplied', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });
    expect(result.current).toEqual({});
  });

  it('exposes flags passed via the `flags` prop', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ heroImage: true, newQueueBar: false }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });
    expect(result.current).toEqual({ heroImage: true, newQueueBar: false });
  });

  it('useFeatureFlag returns the boolean for a known key', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ heroImage: true }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlag('heroImage'), { wrapper });
    expect(result.current).toBe(true);
  });

  it('useFeatureFlag returns undefined for a missing key', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useFeatureFlag('absent'), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('useFeatureFlags returns the default empty bag when no provider is mounted', () => {
    // No wrapper — useContext sees the createContext default value.
    const { result } = renderHook(() => useFeatureFlags());
    expect(result.current).toEqual({});
  });

  it('a local override wins over the static `flags` prop', () => {
    // Set before render so the first snapshot already carries the override (no
    // act() warning from a post-mount store mutation).
    setFeatureFlagOverride('heroImage', false);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ heroImage: true }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlag('heroImage'), { wrapper });
    expect(result.current).toBe(false);
  });

  it('a local override surfaces a flag absent from PostHog and the `flags` prop', () => {
    setFeatureFlagOverride('strava-integration', true);
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useFeatureFlag('strava-integration'), { wrapper });
    expect(result.current).toBe(true);
  });

  it('keeps shipped offline capabilities on without PostHog values', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(
      () => ({
        engine: useOfflineDownloadsEnabled(),
        snapshot: useSnapshotBootstrapEnabled(),
        progress: useOfflineDownloadProgressEnabled(),
      }),
      { wrapper },
    );
    expect(result.current).toEqual({ engine: true, snapshot: true, progress: true });
  });

  it('ignores stale PostHog false values for permanently shipped offline capabilities', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider
        flags={{
          'offline-board-downloads': false,
          'offline-snapshot-bootstrap-v2': false,
          'offline-download-progress': false,
        }}
      >
        {children}
      </FeatureFlagsProvider>
    );
    const { result } = renderHook(
      () => ({
        engine: useOfflineDownloadsEnabled(),
        snapshot: useSnapshotBootstrapEnabled(),
        progress: useOfflineDownloadProgressEnabled(),
      }),
      { wrapper },
    );
    expect(result.current).toEqual({ engine: true, snapshot: true, progress: true });
  });

  it('ignores a stale tester override for the baked-on offline engine', () => {
    setFeatureFlagOverride('offline-board-downloads', false);
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useOfflineDownloadsEnabled(), { wrapper });
    expect(result.current).toBe(true);
  });

  it('the baked-on snapshot path does not leak to ordinary flags', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(
      () => ({
        snapshotBootstrap: useSnapshotBootstrapEnabled(),
        boardseshGrade: useBoardseshGradeEnabled(),
      }),
      { wrapper },
    );
    expect(result.current.snapshotBootstrap).toBe(true);
    expect(result.current.boardseshGrade).toBe(false);
  });

  // The kill switch's DIRECTION is the whole rollout-safety mechanism, and it is
  // the one thing every other test mocks away (`BoardRouteRedirect.test.tsx`
  // stubs this hook; the gate tests pass `anonymousClimbEnabled` in directly).
  // Inverting the comparison here ships the feature dead for 100% of visitors and
  // turns the emergency switch into an enable switch — so all three states are
  // pinned, and the UNRESOLVED one is the assertion that distinguishes
  // `!== true` from `=== false`.
  it('the anonymous climb view is on while its kill flag is unresolved', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useAnonymousClimbViewEnabled(), { wrapper });
    // PostHog resolves asynchronously, and never at all for a browser that blocks
    // it. An OFF-until-resolved reading is a login-redirect flash as the first
    // frame of the surface this exists to build, and a permanent login wall for
    // the ad-blocker cohort.
    expect(result.current).toBe(true);
  });

  it('stays on when the kill flag resolves false', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'anonymous-climb-view-kill': false }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useAnonymousClimbViewEnabled(), { wrapper });
    expect(result.current).toBe(true);
  });

  it('goes off only when the kill flag is actually flipped on', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'anonymous-climb-view-kill': true }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useAnonymousClimbViewEnabled(), { wrapper });
    expect(result.current).toBe(false);
  });

  const GLOW_FALLOFF_VARIANTS = ['soft', 'plateau'] as const;

  it('useFeatureFlagVariant returns the value when it is a declared member', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'board-glow-falloff': 'plateau' }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlagVariant('board-glow-falloff', GLOW_FALLOFF_VARIANTS), {
      wrapper,
    });
    expect(result.current).toBe('plateau');
  });

  it('useFeatureFlagVariant returns undefined for a value outside the declared set', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'board-glow-falloff': 'not-a-real-variant' }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlagVariant('board-glow-falloff', GLOW_FALLOFF_VARIANTS), {
      wrapper,
    });
    expect(result.current).toBeUndefined();
  });

  it('useFeatureFlagVariant returns undefined for an unresolved (missing) flag', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useFeatureFlagVariant('board-glow-falloff', GLOW_FALLOFF_VARIANTS), {
      wrapper,
    });
    expect(result.current).toBeUndefined();
  });

  it('useFeatureFlagVariant returns undefined for a stale boolean value', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'board-glow-falloff': true }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlagVariant('board-glow-falloff', GLOW_FALLOFF_VARIANTS), {
      wrapper,
    });
    expect(result.current).toBeUndefined();
  });

  it('a local override wins for a variant flag too', () => {
    setFeatureFlagOverride('board-glow-falloff', 'plateau');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'board-glow-falloff': 'soft' }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useFeatureFlagVariant('board-glow-falloff', GLOW_FALLOFF_VARIANTS), {
      wrapper,
    });
    expect(result.current).toBe('plateau');
  });

  it('useFeatureFlagOverrides re-renders consumers when an override changes post-mount', () => {
    const { result } = renderHook(() => useFeatureFlagOverrides());
    expect(result.current.overrides).toEqual({});

    // Mutating the module store outside React must push through the
    // useSyncExternalStore subscription and re-render the hook.
    act(() => {
      result.current.setOverride('strava-integration', false);
    });
    expect(result.current.overrides).toEqual({ 'strava-integration': false });

    act(() => {
      result.current.clearOverride('strava-integration');
    });
    expect(result.current.overrides).toEqual({});
  });
});
