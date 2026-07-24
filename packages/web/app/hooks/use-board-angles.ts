import { ANGLES } from '@/app/lib/board-data';
import { MOONBOARD_WIDE_ANGLES } from '@/app/lib/moonboard-config';
import { MOONBOARD_WIDE_ANGLES_FLAG } from '@/app/flags';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import type { BoardName } from '@/app/lib/types';
import type { Angle } from '@boardsesh/board-config';

// Module scope so every call returns the same array reference (a stable dep/memo key).
const MOONBOARD_WIDE_ANGLE_OPTIONS: Angle[] = [...MOONBOARD_WIDE_ANGLES];

// Angle options for `boardName`: ANGLES[boardName], except MoonBoard swaps in the full range when MOONBOARD_WIDE_ANGLES_FLAG is on.
export function useBoardAngleOptions(boardName: BoardName): Angle[] {
  const wideAnglesEnabled = useFeatureFlag(MOONBOARD_WIDE_ANGLES_FLAG);
  if (boardName === 'moonboard' && wideAnglesEnabled) {
    return MOONBOARD_WIDE_ANGLE_OPTIONS;
  }
  return ANGLES[boardName];
}
