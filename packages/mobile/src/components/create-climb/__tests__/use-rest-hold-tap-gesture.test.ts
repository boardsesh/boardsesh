// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SharedValue } from 'react-native-reanimated';
import type { GestureType } from 'react-native-gesture-handler';
import type { HoldHitTarget } from '../holdLayout';

// Chainable gesture builder per Gesture.Tap()/LongPress() call, mirroring
// use-zoomed-hold-tap-gesture.test.ts. Each builder records the config calls we
// care about (maxDistance / minDuration), the pinch relation, and the onStart
// worklet so a test can invoke it without driving real gestures.
type TapEvent = { x: number; y: number };
type GestureRecord = {
  kind: 'tap' | 'longPress';
  maxDistance?: number;
  maxDuration?: number;
  minDuration?: number;
};
const raceCalls: unknown[][] = [];
const exclusiveCalls: unknown[][] = [];
const simultaneousCalls: unknown[] = [];
const built: GestureRecord[] = [];
const tapStartCallbacks: ((event: TapEvent) => void)[] = [];
const longPressStartCallbacks: ((event: TapEvent) => void)[] = [];

vi.mock('react-native-gesture-handler', () => {
  const makeGesture = (kind: 'tap' | 'longPress', recordStart: (cb: (event: TapEvent) => void) => void) => {
    const record: GestureRecord = { kind };
    built.push(record);
    const gesture: Record<string, unknown> = {
      record,
      maxDuration: (ms: number) => {
        record.maxDuration = ms;
        return gesture;
      },
      maxDistance: (px: number) => {
        record.maxDistance = px;
        return gesture;
      },
      minDuration: (ms: number) => {
        record.minDuration = ms;
        return gesture;
      },
      onStart: (cb: (event: TapEvent) => void) => {
        recordStart(cb);
        return gesture;
      },
      simultaneousWithExternalGesture: (ref: unknown) => {
        simultaneousCalls.push(ref);
        return gesture;
      },
    };
    return gesture;
  };
  return {
    Gesture: {
      Tap: () => makeGesture('tap', (cb) => tapStartCallbacks.push(cb)),
      LongPress: () => makeGesture('longPress', (cb) => longPressStartCallbacks.push(cb)),
      Race: (...members: unknown[]) => {
        raceCalls.push(members);
        return { composed: 'race', members };
      },
      Exclusive: (...members: unknown[]) => {
        exclusiveCalls.push(members);
        return { composed: 'exclusive', members };
      },
    },
  };
});

vi.mock('react-native-reanimated', () => ({ runOnJS: (fn: unknown) => fn }));

import {
  useRestHoldTapGesture,
  REST_TAP_MAX_DURATION_MS,
  REST_TAP_MAX_DISTANCE_PX,
  REST_LONG_PRESS_MIN_DURATION_MS,
  REST_LONG_PRESS_MAX_DISTANCE_PX,
} from '../use-rest-hold-tap-gesture';

// The real #4496 geometry, to scale: on Kilter layout 1 at a 340 dp board every
// hold's hit circle is 44 dp across (MIN_TAP_DIAMETER wins over the 18.9 dp ring)
// and neighbours sit 13.4 dp apart, so each hold's circle swallows several
// neighbouring CENTRES. Radii are equal because `r` is a per-board constant
// (`xSpacing * 4` on Aurora boards) — there is no big-hold/small-hold asymmetry.
// Hold 2 is the later entry, i.e. the one z-order used to hand every shared
// touch to.
const HIT_RADIUS = 22;
const overlappingTargets: HoldHitTarget[] = [
  { holdId: 1, x: 100, y: 100, radius: HIT_RADIUS },
  { holdId: 2, x: 113.4, y: 100, radius: HIT_RADIUS },
];

function reset() {
  raceCalls.length = 0;
  exclusiveCalls.length = 0;
  simultaneousCalls.length = 0;
  built.length = 0;
  tapStartCallbacks.length = 0;
  longPressStartCallbacks.length = 0;
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return { hitTargets: overlappingTargets, ...overrides };
}

describe('useRestHoldTapGesture', () => {
  // Recorded gesture config is module-level, so every test starts from a clean
  // slate rather than relying on each one remembering to call reset().
  beforeEach(reset);

  it('returns null when no tap handler is wired (zone mode mounts no overlay)', () => {
    const { result } = renderHook(() => useRestHoldTapGesture(baseOptions()));
    expect(result.current).toBeNull();
  });

  it('composes long-press + tap with Race, never Exclusive', () => {
    const { result } = renderHook(() => useRestHoldTapGesture(baseOptions({ onTap: vi.fn() })));
    expect((result.current as { composed?: string } | null)?.composed).toBe('race');
    expect(exclusiveCalls).toHaveLength(0);
    // Long-press first: with Race the first leg to ACTIVATE wins, but ordering
    // documents the intent that a held finger beats the tap.
    expect(raceCalls.at(-1)).toHaveLength(2);
  });

  it('fails both legs on movement so a drag reaches the parent scroll', () => {
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap: vi.fn() })));
    const tap = built.find((entry) => entry.kind === 'tap');
    const longPress = built.find((entry) => entry.kind === 'longPress');
    expect(tap?.maxDuration).toBe(REST_TAP_MAX_DURATION_MS);
    expect(tap?.maxDistance).toBe(REST_TAP_MAX_DISTANCE_PX);
    expect(longPress?.minDuration).toBe(REST_LONG_PRESS_MIN_DURATION_MS);
    // Without an explicit budget the long-press would keep tracking a drag and
    // turn a scroll into a whole-board long-press.
    expect(longPress?.maxDistance).toBe(REST_LONG_PRESS_MAX_DISTANCE_PX);
  });

  it('resolves a tap to the nearest hold centre, not to the last-rendered hold', () => {
    const onTap = vi.fn();
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap })));

    // (104,100) is inside BOTH circles — 4px from hold 1, 9.4px from hold 2.
    // Z-order handed it to hold 2 (rendered later); distance gives it to hold 1.
    tapStartCallbacks.at(-1)?.({ x: 104, y: 100 });
    expect(onTap).toHaveBeenCalledWith(1);

    // (110,100) is also inside both, but nearer hold 2 — the arbitration flips
    // at the midpoint, which is what makes the partition a Voronoi one.
    onTap.mockClear();
    tapStartCallbacks.at(-1)?.({ x: 110, y: 100 });
    expect(onTap).toHaveBeenCalledWith(2);
  });

  it('ignores a tap that lands outside every hit circle', () => {
    const onTap = vi.fn();
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap })));
    tapStartCallbacks.at(-1)?.({ x: 400, y: 400 });
    expect(onTap).not.toHaveBeenCalled();
  });

  it('routes a long-press to its own handler and falls back to onTap when omitted', () => {
    const onTap = vi.fn();
    const onLongPress = vi.fn();
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap, onLongPress })));
    longPressStartCallbacks.at(-1)?.({ x: 104, y: 100 });
    expect(onLongPress).toHaveBeenCalledWith(1);
    expect(onTap).not.toHaveBeenCalled();

    reset();
    const tapOnly = vi.fn();
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap: tapOnly })));
    longPressStartCallbacks.at(-1)?.({ x: 104, y: 100 });
    expect(tapOnly).toHaveBeenCalledWith(1);
  });

  it('bails out of tap + long-press while a pinch is active', () => {
    const onTap = vi.fn();
    const onLongPress = vi.fn();
    const isPinchingSV = { value: true } as unknown as SharedValue<boolean>;
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap, onLongPress, isPinchingSV })));
    tapStartCallbacks.at(-1)?.({ x: 104, y: 100 });
    longPressStartCallbacks.at(-1)?.({ x: 104, y: 100 });
    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('declares both legs simultaneous with the pinch when pinchRef is provided', () => {
    const pinchRef = { current: undefined } as unknown as { current: GestureType | undefined };
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap: vi.fn(), pinchRef })));
    expect(simultaneousCalls.filter((ref) => ref === pinchRef)).toHaveLength(2);
  });

  it('wires no pinch relation when pinchRef is omitted', () => {
    renderHook(() => useRestHoldTapGesture(baseOptions({ onTap: vi.fn() })));
    expect(simultaneousCalls).toHaveLength(0);
  });

  it('keeps the composed gesture stable across re-renders and still sees fresh hit targets', () => {
    const onTap = vi.fn();
    let hitTargets = overlappingTargets;
    const { result, rerender } = renderHook(() => useRestHoldTapGesture({ hitTargets, onTap }));
    const first = result.current;

    // A relayout produces a new hit-target array; the gesture object must NOT be
    // rebuilt (that has wedged iOS RNGH before) but must resolve against the new
    // geometry through the ref.
    hitTargets = [{ holdId: 99, x: 104, y: 100, radius: HIT_RADIUS }];
    rerender();
    expect(result.current).toBe(first);

    tapStartCallbacks.at(-1)?.({ x: 104, y: 100 });
    expect(onTap).toHaveBeenCalledWith(99);
  });
});
