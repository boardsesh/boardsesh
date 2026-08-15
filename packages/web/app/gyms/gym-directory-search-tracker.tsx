'use client';

import { useEffect } from 'react';
import { gymDirectorySearched } from '@boardsesh/analytics';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';

type GymDirectorySearchTrackerProps = {
  /** Length only. The search text itself never leaves the browser. */
  queryLength: number;
  /** Comma-joined board types, or `''` for none. A primitive so the effect's deps are stable. */
  boardTypesKey: string;
  hasGeo: boolean;
  resultsCount: number;
};

/**
 * Reports `Gym Directory Searched` once per rendered result set.
 *
 * Fires from the RESULT page rather than the form's submit handler, because
 * `resultsCount` is part of the contract and the form has no idea what it is
 * going to get back. The server only mounts this when a search, board filter or
 * location was actually applied, so plain `/gyms` browsing doesn't count as a
 * search.
 *
 * Every dependency is a primitive: an array prop would be a new identity on
 * every render and re-fire the event on each one.
 */
export default function GymDirectorySearchTracker({
  queryLength,
  boardTypesKey,
  hasGeo,
  resultsCount,
}: GymDirectorySearchTrackerProps) {
  useEffect(() => {
    trackGymFunnelEvent(
      gymDirectorySearched({
        queryLength,
        boardTypes: boardTypesKey ? boardTypesKey.split(',') : [],
        hasGeo,
        resultsCount,
      }),
    );
  }, [queryLength, boardTypesKey, hasGeo, resultsCount]);

  return null;
}
