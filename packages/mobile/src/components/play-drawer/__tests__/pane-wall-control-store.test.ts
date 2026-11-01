// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { registerPaneWallControl, usePaneWallControl } from '../pane-wall-control-store';
import { EMPTY_WALL_CONTROL } from '../wall-control';
import { resolvePlayerAngle } from '../player-angle';

describe('pane wall control store (#7000)', () => {
  it("hands the bar the pane's board control (model, tap and hold) until the pane withdraws it", () => {
    const { result } = renderHook(() => usePaneWallControl());
    const pane = Symbol('pane');
    const control = { model: EMPTY_WALL_CONTROL, press: () => undefined, longPress: () => undefined };
    expect(result.current).toBeNull();
    act(() => registerPaneWallControl(pane, control));
    expect(result.current).toBe(control);
    act(() => registerPaneWallControl(pane, null));
    expect(result.current).toBeNull();
  });
});

describe('resolvePlayerAngle', () => {
  it('is the angle on a board that adjusts, and none on a fixed one or without an angle', () => {
    expect(resolvePlayerAngle({ isAngleAdjustable: true, angle: 40 })).toBe(40);
    expect(resolvePlayerAngle({ isAngleAdjustable: false, angle: 40 })).toBeNull();
    expect(resolvePlayerAngle({ isAngleAdjustable: true, angle: null })).toBeNull();
  });
});
