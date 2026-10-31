// @vitest-environment jsdom
//
// The tester-override escape hatch, closed for flags where an override would be
// a store-policy violation rather than an early look at a feature.
//
// Its own file rather than a case in `feature-flags-provider.test.tsx` because
// what is pinned here is not "overrides win" — that is covered there — but the
// one place they must NOT: a production binary. Testers install the same store
// builds as everyone else, so an on-device override travels to a region where
// the behaviour it unlocks is not allowed, overruling the only layer (PostHog)
// that knows where the device is.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import {
  FEATURE_FLAG_DEFINITIONS,
  FeatureFlagsProvider,
  POLICY_CONTROLLED_FLAG_KEYS,
  applyOverridePolicy,
  useFeatureFlag,
} from '../feature-flags-provider';
import { setFeatureFlagOverride, resetFeatureFlagOverridesForTests } from '../../lib/feature-flag-overrides';
import { useDonationLinksAllowed } from '../../lib/donation-links';

// `__DEV__` is a compile-time define under Metro AND under the mobile vitest
// config, so the production branch is only reachable through this seam. That is
// the entire reason is-dev-build.ts exists as a module.
const build = vi.hoisted(() => ({ dev: false }));
vi.mock('../../lib/is-dev-build', () => ({ isDevBuild: () => build.dev }));

// A US-storefront iPhone: the one install where the predicate can say yes, so
// the flag (and therefore the override) is the last thing deciding it.
const platformMock = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('react-native', () => ({ Platform: platformMock }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({ getCountryCode: async () => 'USA' }),
}));

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

function renderPredicate() {
  const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
  return renderHook(() => useDonationLinksAllowed(), { wrapper }).result;
}

function renderFlagValue() {
  const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
  return renderHook(() => useFeatureFlag('donation-links'), { wrapper }).result;
}

beforeEach(() => {
  build.dev = false;
  platformMock.OS = 'ios';
  resetFeatureFlagOverridesForTests();
});

describe('policy-controlled flag overrides', () => {
  it('marks donation-links policy-controlled in the catalog', () => {
    const definition = FEATURE_FLAG_DEFINITIONS.find((entry) => entry.key === 'donation-links');

    expect(definition).toBeDefined();
    expect(POLICY_CONTROLLED_FLAG_KEYS.has('donation-links')).toBe(true);
  });

  it('ignores a policy-controlled override in a production build', () => {
    setFeatureFlagOverride('donation-links', true);

    expect(applyOverridePolicy({ 'donation-links': true })).toEqual({});
  });

  it('honours a policy-controlled override in a dev build', () => {
    build.dev = true;

    expect(applyOverridePolicy({ 'donation-links': true })).toEqual({ 'donation-links': true });
  });

  it('leaves ordinary overrides alone in a production build', () => {
    const overrides = { 'garmin-watch': true };

    // Same reference back, so the provider's useMemo does not thrash on every
    // render just because the policy filter ran.
    expect(applyOverridePolicy(overrides)).toBe(overrides);
  });

  it('strips only the policy-controlled key, keeping the rest', () => {
    expect(applyOverridePolicy({ 'donation-links': true, 'garmin-watch': true })).toEqual({ 'garmin-watch': true });
  });

  it('does not let a tester override reach the flag bag on a store build', async () => {
    setFeatureFlagOverride('donation-links', true);
    const result = renderFlagValue();

    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it('lets the override through in a dev client, so QA can exercise the CTA', async () => {
    build.dev = true;
    setFeatureFlagOverride('donation-links', true);
    const result = renderFlagValue();

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('keeps the predicate false on a store build even with the override forced on', async () => {
    setFeatureFlagOverride('donation-links', true);
    const result = renderPredicate();

    // Give the provider's override load and PostHog backstop a chance to settle;
    // the answer must still be the compliant one.
    await waitFor(() => expect(result.current).toBe(false));
    expect(result.current).toBe(false);
  });

  it('turns the predicate on in a dev client with the override forced on', async () => {
    build.dev = true;
    setFeatureFlagOverride('donation-links', true);
    const result = renderPredicate();

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('keeps the predicate false on Android even in a dev client with the override forced on', async () => {
    build.dev = true;
    platformMock.OS = 'android';
    setFeatureFlagOverride('donation-links', true);
    const flag = renderFlagValue();
    const result = renderPredicate();

    // The override does reach the flag bag in a dev client, so a false here is
    // the platform guard answering, not an unresolved flag.
    await waitFor(() => expect(flag.current).toBe(true));
    expect(result.current).toBe(false);
  });
});
