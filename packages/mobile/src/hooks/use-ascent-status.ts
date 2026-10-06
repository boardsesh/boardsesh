import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { isTickOnCurrentHolds } from '@boardsesh/logbook';
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
 *
 * `holdsRevisionNumber` is the climb's `Climb.holdsRevisionNumber`: the version
 * at which its holds last moved. A tick logged before that is left out, so a
 * climb whose holds changed reads as not sent until it is sent again (#6023),
 * the same rule the search filters apply. Each entry already carries the
 * version it was logged on, so this is a compare per entry and no lookup.
 * Omitted or null, every tick counts, which is right for a climb nobody edited.
 */
export function useAscentStatus(
  climbUuid: string,
  angle: number,
  isMirror?: boolean,
  holdsRevisionNumber?: number | null,
): AscentStatusValue | null {
  const logbook = useOptionalBoardLogbook();
  const entries = logbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle));
  return useMemo<AscentStatusValue | null>(() => {
    if (!entries || entries.length === 0) return null;
    const matching = entries.filter(
      (entry) =>
        (isMirror === undefined || entry.is_mirror === isMirror) &&
        isTickOnCurrentHolds(entry.climb_revision, holdsRevisionNumber),
    );
    if (matching.length === 0) return null;
    return pickHighestAscentStatus(
      matching.map((entry) =>
        normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries }),
      ),
    );
  }, [entries, isMirror, holdsRevisionNumber]);
}
