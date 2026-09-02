// Stamps the active board's gym onto every PostHog event as super properties,
// so any existing insight — climb sends, BLE failures, board history, offline
// downloads — can be sliced by venue. Mounted once at the app root; renders null.
//
// Reads the active board (a cheap AsyncStorage read via React Query), not
// useHomeBoard(), for the same reason AnalyticsPersonProperties does: the latter
// fans out a logbook-ticks query we don't want to run at app root for analytics.

import { useEffect } from 'react';
import { registerActiveGym } from '../../lib/analytics-gym';
import { useActiveBoard } from '../../lib/graphql/use-active-board';

export function AnalyticsGymProperties(): null {
  const { data: activeBoard } = useActiveBoard();

  // Depend on the two scalars, not the board object — the query hands back a new
  // object identity on every refetch, and each registration is a persisted write.
  const gymUuid = activeBoard?.gymUuid ?? null;
  const gymName = activeBoard?.gymName ?? null;

  useEffect(() => {
    // A board can carry a gym id with no uuid/name resolved yet (or none at all,
    // for a home wall). Both are needed for a usable breakdown, so anything short
    // of the pair clears the property rather than stamping a half-identified gym.
    registerActiveGym(gymUuid && gymName ? { uuid: gymUuid, name: gymName } : null);
  }, [gymUuid, gymName]);

  return null;
}
