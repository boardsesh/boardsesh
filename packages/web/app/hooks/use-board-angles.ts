import { ANGLES } from '@/app/lib/board-data';
import { MOONBOARD_WIDE_ANGLES } from '@/app/lib/moonboard-config';
import { MOONBOARD_WIDE_ANGLES_FLAG } from '@/app/flags';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import type { BoardName } from '@/app/lib/types';
import type { Angle } from '@boardsesh/board-config';

/**
 * The angle options an angle picker should offer for `boardName`. Identical
 * to `ANGLES[boardName]` for every board except MoonBoard, which stays
 * limited to `ANGLES.moonboard` (25°/40°) unless MOONBOARD_WIDE_ANGLES_FLAG
 * is on, in which case it offers the full Kilter/Tension-style range.
 */
export function useBoardAngleOptions(boardName: BoardName): Angle[] {
  const wideAnglesEnabled = useFeatureFlag(MOONBOARD_WIDE_ANGLES_FLAG);
  if (boardName === 'moonboard' && wideAnglesEnabled) {
    return [...MOONBOARD_WIDE_ANGLES];
  }
  return ANGLES[boardName];
}
