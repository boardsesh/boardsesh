// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';

const remote = vi.hoisted(() => ({
  enabled: true,
  disabledFamilies: [] as string[],
}));
vi.mock('../../lib/analytics', () => ({
  readPosthogFeatureFlagSnapshot: () => ({
    flags: { 'aura-gpu-enabled': remote.enabled },
    payloads: {
      'aura-gpu-enabled': { version: 1, enabledFamilies: ['tension'], disabledFamilies: remote.disabledFamilies },
    },
  }),
  readPosthogFeatureFlagsRequestId: () => 'current-response',
  subscribePosthogFeatureFlags: () => () => {},
}));
import { FeatureFlagsProvider, useGpuClimbOverlayEnabled } from '../feature-flags-provider';
import { resetFeatureFlagOverridesForTests, setFeatureFlagOverride } from '../../lib/feature-flag-overrides';

afterEach(() => {
  resetFeatureFlagOverridesForTests();
  remote.enabled = true;
  remote.disabledFamilies = [];
});

describe('Aura emergency authority', () => {
  it('does not let a remembered tester preference bypass a global remote disable', () => {
    remote.enabled = false;
    setFeatureFlagOverride('aura-gpu-enabled', true);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'aura-gpu-enabled': true }}>{children}</FeatureFlagsProvider>
    );
    const { result } = renderHook(() => useGpuClimbOverlayEnabled('kilter', 8), { wrapper });
    expect(result.current).toBe(false);
  });

  it('honors a local disable while the remote path remains available', () => {
    setFeatureFlagOverride('aura-gpu-enabled', false);
    const wrapper = ({ children }: { children: ReactNode }) => <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
    const { result } = renderHook(() => useGpuClimbOverlayEnabled('kilter', 8), { wrapper });
    expect(result.current).toBe(false);
  });

  it('preserves remote family disables when a test supplies an explicit policy', () => {
    remote.disabledFamilies = ['kilter'];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider payloads={{ 'aura-gpu-enabled': { version: 1, enabledFamilies: ['kilter', 'tension'] } }}>
        {children}
      </FeatureFlagsProvider>
    );
    const { result } = renderHook(
      () => ({
        kilter: useGpuClimbOverlayEnabled('kilter', 8),
        tension: useGpuClimbOverlayEnabled('tension', 1),
      }),
      { wrapper },
    );
    expect(result.current).toEqual({ kilter: false, tension: true });
  });
});
