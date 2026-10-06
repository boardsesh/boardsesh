import { useMemo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useLogbook, type LogbookEntry } from '@boardsesh/board-react';
import { deriveClimbLedger, type ClimbLedger, type LedgerStatus } from '@boardsesh/profile-stats';
import { normalizeAscentStatus } from '../../../lib/ascent-status-utils';
import { useConnectivityField } from '../../../lib/connectivity/use-connectivity';
import type { ConnectivitySnapshot } from '../../../lib/connectivity/connectivity-store';
import { useLocalClimbTicks } from '../../../hooks/use-local-climb-ticks';
import { useLocalClimbRevision } from '../../../hooks/use-local-climb-revision';

// The same normaliser the entry rows use, so the verdict, the totals and the
// rows under them always agree, including for entries that arrive without a
// `status`.
function statusOf(entry: LogbookEntry): LedgerStatus {
  return normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries });
}

// Hoisted: `useConnectivityField` memoizes its reader on the selector identity.
function selectEffectiveOffline(snapshot: ConnectivitySnapshot): boolean {
  return snapshot.effectiveOffline;
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
 *
 * While this climb's fetch is in flight, the ledger also holds the ticks
 * already synced to the phone (`useLocalClimbTicks`), so a slow server does not
 * hold the history back. Those rows are a placeholder for display: `fetched`
 * stays false until the server answers, and its rows then replace them.
 *
 * `climbCurrentRevision` is the version the climb is on now, read from the
 * phone's own copy of the climb (#6023). Rows compare their own version with
 * it to say "Earlier version". Null when the phone does not know, and then no
 * row is tagged.
 */
export function useClimbLedger(
  boardName: BoardName,
  climbUuid: string | null,
  angle: number,
): {
  ledger: ClimbLedger<LogbookEntry>;
  hasEntries: boolean;
  fetched: boolean;
  error: Error | null;
  /** Nothing asked of the network will land: no signal, backend unreachable, or Offline mode. */
  offline: boolean;
  /** Runs this climb's fetch again after it failed. */
  retry: () => void;
  /** The version the climb is on now, or null when the phone does not know. */
  climbCurrentRevision: number | null;
} {
  const climbUuids = useMemo(() => (climbUuid ? [climbUuid] : NO_CLIMBS), [climbUuid]);
  const { logbook, fetchedUuids, error, refetch } = useLogbook(boardName, climbUuids);
  const offline = useConnectivityField(selectEffectiveOffline);
  const fetched = climbUuid !== null && fetchedUuids.has(climbUuid);

  // Only while the request is on its way. A card whose fetch failed or cannot
  // start says so instead, over what the logbook cache holds.
  const awaitingServer = !fetched && error === null && !offline;
  const localEntries = useLocalClimbTicks(boardName, climbUuid, awaitingServer);
  const climbCurrentRevision = useLocalClimbRevision(boardName, climbUuid, true)?.revisionNumber ?? null;

  const ledger = useMemo(() => {
    const cachedEntries = climbUuid ? logbook.filter((entry) => entry.climb_uuid === climbUuid) : [];
    let entries = cachedEntries;
    if (awaitingServer && localEntries && localEntries.length > 0) {
      // A tick saved from this drawer reaches the logbook cache before the
      // phone's table, so both sources count. The cache wins a shared uuid.
      const cachedUuids = new Set(cachedEntries.map((entry) => entry.uuid));
      entries = [...cachedEntries, ...localEntries.filter((entry) => !cachedUuids.has(entry.uuid))];
    }
    return deriveClimbLedger(entries, { currentAngle: angle, statusOf });
  }, [logbook, localEntries, awaitingServer, climbUuid, angle]);

  return {
    ledger,
    hasEntries: ledger.angles.length > 0,
    fetched,
    error,
    offline,
    retry: refetch,
    climbCurrentRevision,
  };
}
