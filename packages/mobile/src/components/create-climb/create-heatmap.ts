import type { HoldStat, UserBoard } from '@boardsesh/shared-schema';
import type { HeatMetric } from '../board/heatmap-buckets';
import type { BrushRole } from './brush-roles';

/**
 * Everything the create board's heatmap needs from the screen, bundled so the
 * drawer takes one memoised object instead of eight props.
 */
export type CreateHeatmap = {
  active: boolean;
  busy: boolean;
  statsByHoldId: ReadonlyMap<number, HoldStat>;
  /** What the heat counts for the active brush; null (Erase) hides the heat. */
  metric: HeatMetric | null;
  climbCount: number | null;
  /** `download`: the board is not on this phone. `error`: the read failed. */
  status: 'ready' | 'download' | 'error' | 'unavailable';
  /** The climber's board when it is this one, for the Download button. */
  downloadBoard: UserBoard | null;
  toggle: () => void;
};

/**
 * The create board's heat follows the brush: it shows where climbs put the
 * role the setter is about to paint. A Start brush asks where climbs start; a
 * Hand brush where hands go (starts and finishes are hands too); Erase shows
 * nothing, because there is nothing to choose.
 */
export function heatMetricForBrush(brush: BrushRole): HeatMetric | null {
  switch (brush) {
    case 'STARTING':
      return 'starts';
    case 'HAND':
      return 'hands';
    case 'FOOT':
      return 'feet';
    case 'FINISH':
      return 'finishes';
    case 'OFF':
      return null;
  }
}
