// @vitest-environment jsdom
//
// The flag behind "Get updates early". What is pinned here is its DIRECTION and
// its three answers: it ships hidden, so unresolved must hide it, and "off"
// clears a member's branch pin, so off must only ever mean PostHog said off.

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import {
  FEATURE_FLAG_DEFINITIONS,
  FeatureFlagsProvider,
  earlyUpdatesFlagState,
  useEarlyUpdatesFlagState,
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

function renderFlag(flags?: Record<string, boolean | string | undefined>) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
  );
  return renderHook(() => useEarlyUpdatesFlagState(), { wrapper }).result;
}

describe('the early-updates flag', () => {
  const catalogKeys: string[] = FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key);

  it('is in the catalog, so PostHog is asked for it and testers can force it', () => {
    expect(catalogKeys).toContain('early-updates');
  });

  it('is not a kill switch: a kill switch reads unresolved as on, and this ships hidden', () => {
    expect(catalogKeys).not.toContain('early-updates-kill');
  });

  it('is unknown, not off, while unresolved', () => {
    // Off clears a member's pin. An answer that has not arrived must not.
    expect(renderFlag().current).toBe('unknown');
  });

  it('is off only when PostHog says false', () => {
    expect(renderFlag({ 'early-updates': false }).current).toBe('off');
  });

  it('is on only for a true boolean', () => {
    expect(renderFlag({ 'early-updates': true }).current).toBe('on');
  });

  it('reads anything else as unknown', () => {
    expect(earlyUpdatesFlagState('true')).toBe('unknown');
    expect(earlyUpdatesFlagState('')).toBe('unknown');
    expect(earlyUpdatesFlagState(undefined)).toBe('unknown');
  });
});
