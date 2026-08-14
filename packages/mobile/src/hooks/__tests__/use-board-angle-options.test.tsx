// @vitest-environment jsdom
// Flag-gated MoonBoard angle widening: only MoonBoard is affected, and only when the flag resolves true.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ANGLES, MOONBOARD_WIDE_ANGLES } from '@boardsesh/board-config';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';
import { resetFeatureFlagOverridesForTests } from '../../lib/feature-flag-overrides';
import { useBoardAngleOptions } from '../use-board-angle-options';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

function wrapper(flagValue: boolean | undefined) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={{ 'moonboard-wide-angles': flagValue }}>{children}</FeatureFlagsProvider>
  );
}

describe('useBoardAngleOptions', () => {
  afterEach(() => {
    resetFeatureFlagOverridesForTests();
    (AsyncStorage as unknown as { __reset: () => void }).__reset();
  });

  it('returns an empty list when boardName is undefined', () => {
    const { result } = renderHook(() => useBoardAngleOptions(undefined), { wrapper: wrapper(undefined) });
    expect(result.current).toEqual([]);
  });

  it('returns the narrow MoonBoard angle list when the flag is undefined (default OFF)', () => {
    const { result } = renderHook(() => useBoardAngleOptions('moonboard'), { wrapper: wrapper(undefined) });
    expect(result.current).toEqual([25, 40]);
  });

  it('returns the narrow MoonBoard angle list when the flag is explicitly off', () => {
    const { result } = renderHook(() => useBoardAngleOptions('moonboard'), { wrapper: wrapper(false) });
    expect(result.current).toEqual([25, 40]);
  });

  it('returns the full Kilter/Tension-style range for MoonBoard when the flag is on', () => {
    const { result } = renderHook(() => useBoardAngleOptions('moonboard'), { wrapper: wrapper(true) });
    expect(result.current).toEqual([...MOONBOARD_WIDE_ANGLES]);
  });

  it('never widens Kilter, flag on or off', () => {
    const { result: offResult } = renderHook(() => useBoardAngleOptions('kilter'), { wrapper: wrapper(false) });
    const { result: onResult } = renderHook(() => useBoardAngleOptions('kilter'), { wrapper: wrapper(true) });
    expect(offResult.current).toEqual(ANGLES.kilter);
    expect(onResult.current).toEqual(ANGLES.kilter);
  });

  it('never widens Tension, flag on or off', () => {
    const { result: offResult } = renderHook(() => useBoardAngleOptions('tension'), { wrapper: wrapper(false) });
    const { result: onResult } = renderHook(() => useBoardAngleOptions('tension'), { wrapper: wrapper(true) });
    expect(offResult.current).toEqual(ANGLES.tension);
    expect(onResult.current).toEqual(ANGLES.tension);
  });
});
