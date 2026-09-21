// @vitest-environment jsdom
//
// The kill switches for the launch surfaces #5654 woke up, for the
// first-board picker the onboarding gate now opens for new accounts, and for
// the connect-step test. What is
// pinned here is their DIRECTION: each surface is shipped behaviour the moment
// the OTA lands, so an unresolved flag must read as "not killed", and only an
// explicit `true` in PostHog takes a surface down.

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import {
  FEATURE_FLAG_DEFINITIONS,
  FeatureFlagsProvider,
  useConnectivityBannerEnabled,
  useFirstBoardPickerEnabled,
  useFirstConnectCtaEnabled,
  useQaTesterGateEnabled,
  useSendRecoveryGateEnabled,
} from '../feature-flags-provider';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const KILL_SWITCHES = [
  { key: 'connectivity-banner-kill', useEnabled: useConnectivityBannerEnabled },
  { key: 'qa-tester-gate-kill', useEnabled: useQaTesterGateEnabled },
  { key: 'send-recovery-gate-kill', useEnabled: useSendRecoveryGateEnabled },
  { key: 'first-board-picker-kill', useEnabled: useFirstBoardPickerEnabled },
  { key: 'first-connect-cta-kill', useEnabled: useFirstConnectCtaEnabled },
] as const;

function readEnabled(useEnabled: () => boolean, flags?: Record<string, boolean | string | undefined>): boolean {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
  );
  return renderHook(() => useEnabled(), { wrapper }).result.current;
}

describe.each(KILL_SWITCHES)('$key', ({ key, useEnabled }) => {
  it('is in the catalog, so PostHog is actually read for it', () => {
    // `readPosthogFeatureFlags` is driven by FEATURE_FLAG_DEFINITIONS. A kill
    // switch missing from it could never be flipped.
    expect(FEATURE_FLAG_DEFINITIONS.some((definition) => definition.key === key)).toBe(true);
  });

  it('leaves the surface on while the flag is unresolved', () => {
    expect(readEnabled(useEnabled)).toBe(true);
  });

  it('leaves the surface on when PostHog says false', () => {
    expect(readEnabled(useEnabled, { [key]: false })).toBe(true);
  });

  it('takes the surface down when PostHog says true', () => {
    expect(readEnabled(useEnabled, { [key]: true })).toBe(false);
  });
});
