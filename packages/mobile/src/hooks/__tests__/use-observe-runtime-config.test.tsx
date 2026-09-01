// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FeatureFlagsProvider, type FeatureFlags } from '../../providers/feature-flags-provider';
import { resetObserveRuntimeForTests, setObserveRuntime } from '../../lib/observe-runtime';
import { useObserveRuntimeConfig } from '../use-observe-runtime-config';

// Proves the flag → SDK wiring. The parsing rules themselves are
// observe-config.test.ts's contract; this file is about what actually reaches
// the SDK, including the case that matters most — flags that have not resolved.

afterEach(() => {
  resetObserveRuntimeForTests();
});

function wrapperFor(flags: FeatureFlags) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
  );
}

function renderWithFlags(flags: FeatureFlags) {
  const configure = vi.fn();
  setObserveRuntime({ configure, reportError: vi.fn() });
  const view = renderHook(() => useObserveRuntimeConfig(), { wrapper: wrapperFor(flags) });
  return { configure, ...view };
}

describe('useObserveRuntimeConfig', () => {
  it('keeps dispatching at full rate while the flags are unresolved', () => {
    // The cold-start case, and the one that must not go quiet: a device that
    // never reaches PostHog has to keep reporting.
    const { configure } = renderWithFlags({});

    expect(configure).toHaveBeenCalledWith({ dispatchingEnabled: true, sampleRate: 1 });
  });

  it('applies the kill switch', () => {
    const { configure } = renderWithFlags({ 'observe-dispatch-enabled': false });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ dispatchingEnabled: false }));
  });

  it('applies a sample rate from the multivariate flag', () => {
    const { configure } = renderWithFlags({ 'observe-sample-rate': '0.25' });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 0.25 }));
  });

  it('falls back to full sampling when the variant is unparseable', () => {
    // A typo in the dashboard must not reach the SDK as NaN and disable
    // collection for everyone who read the flag.
    const { configure } = renderWithFlags({ 'observe-sample-rate': 'half' });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 1 }));
  });

  it('does not re-apply on a re-render with unchanged flags', () => {
    // The effect deps are the two flag values, not the flags object, so an
    // unrelated re-render must not churn the SDK's config.
    const { configure, rerender } = renderWithFlags({ 'observe-sample-rate': '0.5' });
    expect(configure).toHaveBeenCalledTimes(1);

    rerender();
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no SDK is registered', () => {
    // Expo web and the node test runner never register one.
    expect(() => renderHook(() => useObserveRuntimeConfig(), { wrapper: wrapperFor({}) })).not.toThrow();
  });
});
