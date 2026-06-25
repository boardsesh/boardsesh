// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FeatureFlagsProvider, useFeatureFlag, useFeatureFlags } from '../feature-flags-provider';
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
