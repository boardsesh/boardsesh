import { getBoardAngleOptions } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useFeatureFlag } from '../providers/feature-flags-provider';

// Angle options for `boardName`: ANGLES[boardName] (from @boardsesh/board-config), except
// MoonBoard swaps in the full Kilter/Tension-style range when the `moonboard-wide-angles`
// flag is on. `boardName` is optional so call sites reading it off an async record (e.g. a
// logbook ascent) don't need to gate the hook call itself.
export function useBoardAngleOptions(boardName: BoardName | undefined): number[] {
  const wideAnglesEnabled = useFeatureFlag('moonboard-wide-angles') === true;
  if (!boardName) return [];
  return getBoardAngleOptions(boardName, wideAnglesEnabled);
}
