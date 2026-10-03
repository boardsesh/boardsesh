import { useMemo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useLogbook, type LogbookEntry } from '@boardsesh/board-react';
import { deriveClimbLedger, type ClimbLedger, type LedgerStatus } from '@boardsesh/profile-stats';
import { normalizeAscentStatus } from '../../../lib/ascent-status-utils';

// The same normaliser the entry rows use, so a tile's marks and the rows under
// it always agree, including for entries that arrive without a `status`.
function statusOf(entry: LogbookEntry): LedgerStatus {
  return normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries });
}

const NO_CLIMBS: string[] = [];

/**
 * The signed-in climber's history on one climb, as a ledger led by `angle`.
 * Shared by the Logbook card and the full-logbook sheet; React Query dedupes
 * the fetch behind `useLogbook`, so mounting both costs one request.
 *
 * `fetched` is the per-climb answer to "is this the whole history?". Do not
 * swap it for `useLogbook().isLoading`: that flag is board-wide (false as soon
 * as ANY climb's ticks are cached) and goes false while an offline fetch is
 * paused, so it would call a logged climb untried.
 */
export function useClimbLedger(
  boardName: BoardName,
  climbUuid: string | null,
  angle: number,
): { ledger: ClimbLedger<LogbookEntry>; hasEntries: boolean; fetched: boolean; error: Error | null } {
  const climbUuids = useMemo(() => (climbUuid ? [climbUuid] : NO_CLIMBS), [climbUuid]);
  const { logbook, fetchedUuids, error } = useLogbook(boardName, climbUuids);

  const ledger = useMemo(
    () =>
      deriveClimbLedger(climbUuid ? logbook.filter((entry) => entry.climb_uuid === climbUuid) : [], {
        currentAngle: angle,
        statusOf,
      }),
    [logbook, climbUuid, angle],
  );

  return {
    ledger,
    hasEntries: ledger.angles.length > 0,
    fetched: climbUuid !== null && fetchedUuids.has(climbUuid),
    error,
  };
}
