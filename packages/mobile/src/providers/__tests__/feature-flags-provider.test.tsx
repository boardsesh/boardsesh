// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FeatureFlagsProvider, useFeatureFlag, useFeatureFlags } from '../feature-flags-provider';

describe('FeatureFlagsProvider', () => {
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
});
