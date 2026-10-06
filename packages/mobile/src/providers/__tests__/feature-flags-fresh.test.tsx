// @vitest-environment jsdom
//
// "Fresh" is stricter than "resolved": a NEW PostHog response since the app
// opened. The cached bag being re-emitted after a failed request, and the 2 s
// timeout, both resolve the flags and must not count. It is what stops a stale
// `off` from moving an early-updates member off their track.

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({
  requestId: undefined as string | undefined,
  emit: (() => {}) as () => void,
}));
vi.mock('../../lib/analytics', () => ({
  readPosthogFeatureFlags: () => ({}),
  readPosthogFeatureFlagsRequestId: () => posthog.requestId,
  subscribePosthogFeatureFlags: (onChange: () => void) => {
    posthog.emit = onChange;
    return () => {};
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn() },
}));

import {
  FEATURE_FLAG_RESOLUTION_TIMEOUT_MS,
  FeatureFlagsProvider,
  useFeatureFlagsFresh,
  useFeatureFlagsResolved,
} from '../feature-flags-provider';

function renderFlags(flags?: Record<string, boolean>) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
  );
  return renderHook(() => ({ fresh: useFeatureFlagsFresh(), resolved: useFeatureFlagsResolved() }), { wrapper });
}

beforeEach(() => {
  posthog.requestId = undefined;
  vi.useRealTimers();
});

describe('useFeatureFlagsFresh', () => {
  it('is false until PostHog answers', () => {
    posthog.requestId = 'cached-response';
    expect(renderFlags().result.current.fresh).toBe(false);
  });

  it('stays false when PostHog only re-emits the bag it had cached', () => {
    // A failed request: the listener fires, the flags resolve, nothing is new.
    posthog.requestId = 'cached-response';
    const { result } = renderFlags();

    act(() => posthog.emit());

    expect(result.current).toEqual({ fresh: false, resolved: true });
  });

  it('stays false when the flags resolve by timeout', () => {
    vi.useFakeTimers();
    posthog.requestId = 'cached-response';
    const { result } = renderFlags();

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_RESOLUTION_TIMEOUT_MS);
    });

    expect(result.current).toEqual({ fresh: false, resolved: true });
  });

  it('turns true on a response that was not the cached one', () => {
    posthog.requestId = 'cached-response';
    const { result } = renderFlags();

    posthog.requestId = 'new-response';
    act(() => posthog.emit());

    expect(result.current.fresh).toBe(true);
  });

  it('counts the first response an install ever gets', () => {
    const { result } = renderFlags();

    posthog.requestId = 'first-response';
    act(() => posthog.emit());

    expect(result.current.fresh).toBe(true);
  });

  it('treats a complete static bag as fresh, like it treats it as resolved', () => {
    expect(renderFlags({ 'early-updates': true }).result.current).toEqual({ fresh: true, resolved: true });
  });
});
