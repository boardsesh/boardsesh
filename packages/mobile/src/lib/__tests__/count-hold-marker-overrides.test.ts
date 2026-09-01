import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_MARKER_SHAPE,
  DEFAULT_HOLD_SHAPE_SIZE,
  countHoldMarkerOverrides,
  type HoldMarkerOverrides,
} from '../hold-color-overrides';

const NONE: HoldMarkerOverrides = {
  colors: {},
  shapes: {},
  brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
  shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
};

describe('countHoldMarkerOverrides', () => {
  it('counts nothing when everything is default', () => {
    expect(countHoldMarkerOverrides(NONE)).toBe(0);
  });

  it('counts a shape left on the default as unchanged', () => {
    expect(countHoldMarkerOverrides({ ...NONE, shapes: { HAND: DEFAULT_HOLD_MARKER_SHAPE } })).toBe(0);
  });

  it('counts a role once even when both its colour and its shape moved', () => {
    expect(countHoldMarkerOverrides({ ...NONE, colors: { HAND: '#ff0000' }, shapes: { HAND: 'square' } })).toBe(1);
  });

  it('counts each customised role separately', () => {
    expect(countHoldMarkerOverrides({ ...NONE, colors: { HAND: '#ff0000', FOOT: '#00ff00' } })).toBe(2);
  });

  it('counts brush thickness and marker size alongside the roles', () => {
    expect(countHoldMarkerOverrides({ ...NONE, brushThickness: 1.5, shapeSize: 1.2 })).toBe(2);
    expect(countHoldMarkerOverrides({ ...NONE, colors: { STARTING: '#fff' }, brushThickness: 1.5 })).toBe(2);
  });
});
