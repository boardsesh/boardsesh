import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardProvider } from '@boardsesh/board-react';
import { normalizeAscentStatus, pickHighestAscentStatus, type AscentStatusValue } from '../lib/ascent-status-utils';

/**
 * The user's highest recorded ascent status (flash / send / attempt) for a climb
 * at a given angle, read from the denormalised logbook via `BoardProvider`.
 * Returns null when there are no ticks at this angle, or outside a BoardProvider.
 * Drives the climb-row status glyph in `ClimbListItemContent`.
 *
 * Reads the pre-grouped `logbookByClimbAngle` index (built once per logbook
 * change in `BoardProvider`) so each row does an O(1) lookup over its own
 * handful of ticks instead of scanning the whole logbook — the previous
 * `logbook.filter(...)` made the climbs list O(rows × logbook) on every merge.
 */
export function useAscentStatus(climbUuid: string, angle: number, isMirror?: boolean): AscentStatusValue | null {
  const board = useOptionalBoardProvider();
  const entries = board?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle));
  return useMemo<AscentStatusValue | null>(() => {
    if (!entries || entries.length === 0) return null;
    const matching = isMirror === undefined ? entries : entries.filter((entry) => entry.is_mirror === isMirror);
    if (matching.length === 0) return null;
    return pickHighestAscentStatus(
      matching.map((entry) =>
        normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries }),
      ),
    );
  }, [entries, isMirror]);
}
