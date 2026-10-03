// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { FeatureFlagsProvider, useFeatureFlagsResolved } from '../feature-flags-provider';

vi.mock('@react-native-async-storage/async-storage', () => {
  const storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    },
  };
});

describe('useFeatureFlagsResolved', () => {
  function renderResolved(flags?: Record<string, boolean | string | undefined>) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
    );
    return renderHook(() => useFeatureFlagsResolved(), { wrapper }).result;
  }

  it('is false on the first frame with nothing supplied', () => {
    // Navigation gates must wait until the live kill switches can be read.
    expect(renderResolved().current).toBe(false);
  });

  it('is true immediately for a statically supplied bag', () => {
    // Every test hands over the whole answer: there is nothing on its way that
    // could change it, so waiting would be waiting for nothing.
    expect(renderResolved({ 'strava-integration': false }).current).toBe(true);
  });

  it('still waits for PostHog when the static bag is only partial', () => {
    // The root layout's env override pins a key or two and leaves every other
    // flag, kill switches included, to PostHog. Reading it as final would let a
    // launch gate push before a kill switch flipped in PostHog could stop it.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'strava-integration': true }} staticFlagsAreFinal={false}>
        {children}
      </FeatureFlagsProvider>
    );
    expect(renderHook(() => useFeatureFlagsResolved(), { wrapper }).result.current).toBe(false);
  });
});
