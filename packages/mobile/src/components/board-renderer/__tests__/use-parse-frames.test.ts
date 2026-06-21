// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setHoldColorOverridesPreference, setHoldMarkerOverridesPreference } from '../../../lib/hold-color-overrides';
import { useParseFrames } from '../use-parse-frames';
import type { HoldPlacement } from '../types';

// Kilter Product 1 state codes: 12=STARTING, 13=HAND, 14=FINISH, 15=FOOT.
// Frames string format: pIDrSTATE separated by no delimiter inside a frame;
// frames separated by commas. We test with hold id 100 (a STARTING hold).

const HOLD_LEFT: HoldPlacement = { id: 100, mirroredHoldId: 200, cx: 50, cy: 1000, r: 25 };
const HOLD_RIGHT: HoldPlacement = { id: 200, mirroredHoldId: 100, cx: 950, cy: 1000, r: 25 };
const HOLD_NO_MIRROR: HoldPlacement = { id: 300, mirroredHoldId: null, cx: 500, cy: 500, r: 25 };

describe('useParseFrames mirroring', () => {
  afterEach(async () => {
    await setHoldMarkerOverridesPreference({ colors: {}, shapes: {}, brushThickness: 1, shapeSize: 1 });
  });

  it('returns original position when mirrored=false', () => {
    const { result } = renderHook(() => useParseFrames('p100r12', 'kilter', [HOLD_LEFT, HOLD_RIGHT], false));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ id: 100, cx: 50, cy: 1000, radius: 25 });
  });

  it('swaps to mirroredHoldId position when mirrored=true', () => {
    const { result } = renderHook(() => useParseFrames('p100r12', 'kilter', [HOLD_LEFT, HOLD_RIGHT], true));

    expect(result.current).toHaveLength(1);
    // Hold id is still 100 (so the role/color stay correct), but the rendered
    // position comes from hold 200 — its mirror partner.
    expect(result.current[0]).toMatchObject({ id: 100, cx: 950, cy: 1000, radius: 25 });
  });

  it('falls back to original position when mirroredHoldId is null', () => {
    const { result } = renderHook(() => useParseFrames('p300r12', 'kilter', [HOLD_NO_MIRROR], true));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ id: 300, cx: 500, cy: 500, radius: 25 });
  });

  it('falls back to original position when mirroredHoldId points at a missing placement', () => {
    // mirroredHoldId references hold 999 which is not in holdsData
    const orphanedMirror: HoldPlacement = { id: 100, mirroredHoldId: 999, cx: 50, cy: 1000, r: 25 };
    const { result } = renderHook(() => useParseFrames('p100r12', 'kilter', [orphanedMirror], true));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ id: 100, cx: 50, cy: 1000, radius: 25 });
  });

  it('returns empty array for empty frames string', () => {
    const { result } = renderHook(() => useParseFrames('', 'kilter', [HOLD_LEFT], false));
    expect(result.current).toEqual([]);
  });

  it('skips holds whose ID has no placement entry', () => {
    // Frame references hold 999 which is not in holdsData
    const { result } = renderHook(() => useParseFrames('p999r12', 'kilter', [HOLD_LEFT], false));
    expect(result.current).toEqual([]);
  });

  it('applies configured role colour overrides to parsed holds', async () => {
    await setHoldColorOverridesPreference({ STARTING: '#123456' });

    const { result } = renderHook(() => useParseFrames('p100r12', 'kilter', [HOLD_LEFT], false));

    expect(result.current[0]?.color).toBe('#123456');
  });

  it('applies configured marker overrides to parsed holds', async () => {
    await setHoldMarkerOverridesPreference({
      colors: {},
      shapes: { STARTING: 'triangle-up' },
      brushThickness: 1.6,
      shapeSize: 1.7,
    });

    const { result } = renderHook(() => useParseFrames('p100r12', 'kilter', [HOLD_LEFT], false));

    expect(result.current[0]).toMatchObject({
      shape: 'triangle-up',
      brushThickness: 1.6,
      shapeSize: 1.7,
    });
  });
});
