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
  TICK_ANGLE_ROW_HEIGHT,
  TICK_CONTROL_ORIGIN,
  TICK_GUTTER,
  TICK_HEADER_HEIGHT,
  TICK_LABEL_GAP,
  TICK_LABEL_MIN_WIDTH,
  TICK_RAIL_ROW_HEIGHT,
  TICK_ROW_HEIGHT,
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

  it('sizes the action bar off the app-wide hero action height', () => {
    expect(TICK_ACTION_HEIGHT).toBe(glassSize.hero);
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
