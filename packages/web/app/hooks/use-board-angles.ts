import { getBoardAngleOptions } from '@/app/lib/board-data';
import { MOONBOARD_WIDE_ANGLES_FLAG } from '@/app/flags';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import type { BoardName } from '@/app/lib/types';
import type { Angle } from '@boardsesh/board-config';

// Angle options for `boardName`: ANGLES[boardName], except MoonBoard swaps in the full range when MOONBOARD_WIDE_ANGLES_FLAG is on.
export function useBoardAngleOptions(boardName: BoardName): Angle[] {
  const wideAnglesEnabled = useFeatureFlag(MOONBOARD_WIDE_ANGLES_FLAG) === true;
  return getBoardAngleOptions(boardName, wideAnglesEnabled);
}
