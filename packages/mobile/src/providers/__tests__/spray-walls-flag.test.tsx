// @vitest-environment jsdom
//
// The gate on the whole spray-wall front door (epic #5346, SW-09).
//
// Its own file rather than a case in `feature-flags-provider.test.tsx` because
// The shipped default needs no remote setup, while explicit false still takes
// down the spray-wall front door.

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import {
  FEATURE_FLAG_DEFINITIONS,
  FeatureFlagsProvider,
  useFeatureFlagsResolved,
  useSprayWallsEnabled,
} from '../feature-flags-provider';

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

function renderGate(flags?: Record<string, boolean | string | undefined>) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
  );
  return renderHook(() => useSprayWallsEnabled(), { wrapper }).result;
}

describe('useSprayWallsEnabled', () => {
  it('is in the catalog, so the tester screen and the PostHog read both know it', () => {
    // A mobile flag that is not in FEATURE_FLAG_DEFINITIONS is never READ from
    // PostHog at all — `readPosthogFeatureFlags` is driven by this list — so it
    // would be permanently off with no way to turn it on.
    expect(FEATURE_FLAG_DEFINITIONS.some((definition) => definition.key === 'spray-walls')).toBe(true);
  });

  it('is enabled while unresolved or absent', () => {
    expect(renderGate().current).toBe(true);
    expect(renderGate({}).current).toBe(true);
  });

  it('is off when PostHog explicitly says false', () => {
    expect(renderGate({ 'spray-walls': false }).current).toBe(false);
  });

  it('keeps the shipped default for values that are not booleans', () => {
    expect(renderGate({ 'spray-walls': 'true' }).current).toBe(true);
    expect(renderGate({ 'spray-walls': '' }).current).toBe(true);
  });

  it('is on for a true boolean', () => {
    expect(renderGate({ 'spray-walls': true }).current).toBe(true);
  });
});

describe('useFeatureFlagsResolved', () => {
  function renderResolved(flags?: Record<string, boolean | string | undefined>) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
    );
    return renderHook(() => useFeatureFlagsResolved(), { wrapper }).result;
  }

  it('is false on the first frame with nothing supplied', () => {
    // What the redirect gate needs to know. Reading the empty first bag as final
    // would bounce a climber the feature IS enabled for straight off their own
    // deep link, and a value arriving afterwards cannot bring the route back.
    expect(renderResolved().current).toBe(false);
  });

  it('is true immediately for a statically supplied bag', () => {
    // Every test hands over the whole answer: there is nothing on its way that
    // could change it, so waiting would be waiting for nothing.
    expect(renderResolved({ 'spray-walls': false }).current).toBe(true);
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
