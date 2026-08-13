// Flag-gated MoonBoard angle widening: only MoonBoard is affected, and only when the flag resolves true.
import { describe, it, expect } from 'vite-plus/test';
import React from 'react';
import { renderHook } from '@testing-library/react';
import { FeatureFlagsProvider } from '@/app/components/providers/feature-flags-provider';
import { MOONBOARD_WIDE_ANGLES_FLAG } from '@/app/flags';
import { ANGLES } from '@/app/lib/board-data';
import { MOONBOARD_WIDE_ANGLES } from '@boardsesh/board-config';
import { useBoardAngleOptions } from '../use-board-angles';

function wrapper(flagValue: boolean | undefined) {
  return ({ children }: { children: React.ReactNode }) => (
    <FeatureFlagsProvider flags={{ [MOONBOARD_WIDE_ANGLES_FLAG]: flagValue }}>{children}</FeatureFlagsProvider>
  );
}

describe('useBoardAngleOptions', () => {
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
