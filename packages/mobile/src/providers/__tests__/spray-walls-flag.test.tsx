// @vitest-environment jsdom
//
// The gate on the whole spray-wall front door (epic #5346, SW-09).
//
// Its own file rather than a case in `feature-flags-provider.test.tsx` because
// what is being pinned is not "the provider reads flags" — that is already
// covered — but the DIRECTION of one flag. A positive rollout flag that resolves
// asynchronously has to read as OFF while it is unresolved, or a dark feature
// appears for the first frames of every cold open on a fleet it is dark for.

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { FEATURE_FLAG_DEFINITIONS, FeatureFlagsProvider, useSprayWallsEnabled } from '../feature-flags-provider';

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

  it('is off while the flag is unresolved', () => {
    expect(renderGate().current).toBe(false);
  });

  it('is off when PostHog explicitly says false', () => {
    expect(renderGate({ 'spray-walls': false }).current).toBe(false);
  });

  it('is off for a value that is not exactly true', () => {
    // A multivariate answer, or a stringly "true" from a misconfigured flag, is
    // not a rollout of this feature.
    expect(renderGate({ 'spray-walls': 'true' }).current).toBe(false);
    expect(renderGate({ 'spray-walls': '' }).current).toBe(false);
  });

  it('is on only for a true boolean', () => {
    expect(renderGate({ 'spray-walls': true }).current).toBe(true);
  });
});
