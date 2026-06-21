// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SharedValue } from 'react-native-reanimated';
import type { GestureType } from 'react-native-gesture-handler';

// Chainable no-op gesture builder; Race tags its result so we can assert which
// branch the hook returned without driving real gestures.
const raceCalls: unknown[][] = [];
vi.mock('react-native-gesture-handler', () => {
  const builder: Record<string, unknown> = new Proxy({}, { get: () => () => builder });
  return {
    Gesture: {
      Tap: () => builder,
      LongPress: () => builder,
      Race: (...members: unknown[]) => {
        raceCalls.push(members);
        return { composed: 'race', members };
      },
    },
  };
});

vi.mock('react-native-reanimated', () => ({ runOnJS: (fn: unknown) => fn }));

import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from '../use-zoomed-hold-tap-gesture';

const sv = (value: number): SharedValue<number> => ({ value }) as SharedValue<number>;
const barePan = { id: 'bare-pan' } as unknown as GestureType;

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    zoomPanGesture: barePan,
    scaleSV: sv(1),
    translateXSV: sv(0),
    translateYSV: sv(0),
    containerWidthSV: sv(300),
    containerHeightSV: sv(600),
    hitTargets: [{ holdId: 1, x: 150, y: 300, radius: 24 }],
    ...overrides,
  };
}

describe('useZoomedHoldTapGesture', () => {
  it('exports the default pan activation offset', () => {
    expect(PAN_ACTIVATION_OFFSET).toBe(8);
  });

  it('returns the bare pan unchanged when no onTap (zone mode)', () => {
    const { result } = renderHook(() => useZoomedHoldTapGesture(baseOptions()));
    expect(result.current).toBe(barePan);
  });

  it('composes the pan with tap + long-press (Race, pan first) when onTap is provided', () => {
    raceCalls.length = 0;
    const onTap = vi.fn();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useZoomedHoldTapGesture(baseOptions({ onTap, onLongPress })));

    expect(result.current).not.toBe(barePan);
    expect((result.current as { composed?: string }).composed).toBe('race');
    // Pan must be the first member so it gets first refusal on movement.
    expect(raceCalls.at(-1)?.[0]).toBe(barePan);
    expect(raceCalls.at(-1)).toHaveLength(3);
  });

  it('keeps the composed gesture stable across re-renders with the same inputs', () => {
    const options = baseOptions({ onTap: vi.fn() });
    const { result, rerender } = renderHook(() => useZoomedHoldTapGesture(options));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
