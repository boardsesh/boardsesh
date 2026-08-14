import { getBoardAngleOptions } from '@/app/lib/board-data';
import { MOONBOARD_WIDE_ANGLES_FLAG } from '@/app/flags';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import type { BoardName } from '@/app/lib/types';
import type { Angle } from '@boardsesh/board-config';

// Angle options for `boardName`: ANGLES[boardName], except MoonBoard swaps in the full range when MOONBOARD_WIDE_ANGLES_FLAG is on.
// `boardName` is optional so call sites reading it off an as-yet-unselected value
// (e.g. a board picker before a board is chosen) don't need a throwaway fallback.
export function useBoardAngleOptions(boardName: BoardName | undefined): Angle[] {
  const wideAnglesEnabled = useFeatureFlag(MOONBOARD_WIDE_ANGLES_FLAG) === true;
  if (!boardName) return [];
  return getBoardAngleOptions(boardName, wideAnglesEnabled);
}
