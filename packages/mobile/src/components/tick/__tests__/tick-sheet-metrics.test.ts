import { describe, expect, it, vi } from 'vitest';

// `theme/tokens` reaches `theme/colors` / `theme/ios-colors`, which import from
// react-native — Flow source Rolldown can't parse under the node env. Only
// `Platform.OS` and `PlatformColor` are read at module scope; the metrics under
// test are pure numbers, so a stub that names the colour is enough.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
}));

import { glassSize } from '../../../theme/layout';
import {
  CREATE_TICK_SNAP_POINTS,
  EDIT_TICK_SNAP_POINTS,
  TICK_ACTION_HEIGHT,
  TICK_ACTION_LABEL_HEIGHT,
  TICK_ACTION_MAX_FONT_SCALE,
  TICK_ANGLE_ROW_HEIGHT,
  TICK_CONTROL_ORIGIN,
  TICK_GUTTER,
  TICK_HEADER_HEIGHT,
  TICK_LABEL_GAP,
  TICK_LABEL_MIN_WIDTH,
  TICK_RAIL_ROW_HEIGHT,
  TICK_ROW_HEIGHT,
  tickActionHeight,
} from '../tick-sheet-metrics';

function percentToNumber(snapPoint: string): number {
  return Number(snapPoint.replace('%', ''));
}

describe('tick sheet metrics', () => {
  it('derives the control seam from the gutter, label column and label gap', () => {
    expect(TICK_CONTROL_ORIGIN).toBe(TICK_GUTTER + TICK_LABEL_MIN_WIDTH + TICK_LABEL_GAP);
  });

  it('keeps every row at or above the 44pt touch floor', () => {
    for (const height of [
      TICK_ROW_HEIGHT,
      TICK_RAIL_ROW_HEIGHT,
      TICK_ANGLE_ROW_HEIGHT,
      TICK_HEADER_HEIGHT,
      TICK_ACTION_HEIGHT,
    ]) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });

  it('sizes the action bar at the standard 48pt control, not the 56pt hero', () => {
    expect(TICK_ACTION_HEIGHT).toBe(glassSize.standard);
    expect(TICK_ACTION_HEIGHT).toBe(48);
  });

  it('gives both sheets a rest detent below a shared keyboard detent', () => {
    for (const snapPoints of [CREATE_TICK_SNAP_POINTS, EDIT_TICK_SNAP_POINTS]) {
      expect(snapPoints).toHaveLength(2);
      expect(snapPoints.every((snapPoint) => snapPoint.endsWith('%'))).toBe(true);
      expect(percentToNumber(snapPoints[0])).toBeLessThan(percentToNumber(snapPoints[1]));
      expect(snapPoints[1]).toBe('92%');
    }
  });
});

// The action row pins ONE height across two different native controls, so this
// value is the whole reason the tonal Attempt and the filled Send line up. It has
// to hold at every text scale: a button that only sometimes carries a height
// would flip `Host`'s `matchContents` mid-life, and nothing else sizes that axis.
describe('tickActionHeight', () => {
  it('is the standard height at the default text size', () => {
    expect(tickActionHeight(1)).toBe(TICK_ACTION_HEIGHT);
  });

  it('never goes below the floor, however small the text', () => {
    expect(tickActionHeight(0.85)).toBe(TICK_ACTION_HEIGHT);
  });

  it('grows by the label line alone, not by the whole button', () => {
    // A native button's padding does not scale, so 1.2x text adds a fifth of a
    // line, not a fifth of the button.
    expect(tickActionHeight(1.2)).toBe(Math.round(TICK_ACTION_HEIGHT + TICK_ACTION_LABEL_HEIGHT * 0.2));
  });

  it('stops growing at the Dynamic Type cap the buttons are held to', () => {
    expect(TICK_ACTION_MAX_FONT_SCALE).toBe(1.3);
    const capped = Math.round(TICK_ACTION_HEIGHT + TICK_ACTION_LABEL_HEIGHT * (TICK_ACTION_MAX_FONT_SCALE - 1));
    expect(tickActionHeight(1.3)).toBe(capped);
    expect(tickActionHeight(2)).toBe(capped);
    expect(tickActionHeight(3)).toBe(capped);
  });

  it('is a whole number of points at an awkward scale', () => {
    expect(Number.isInteger(tickActionHeight(1.35))).toBe(true);
  });
});
