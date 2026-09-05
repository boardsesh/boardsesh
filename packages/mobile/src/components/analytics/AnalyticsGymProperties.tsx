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
  const { data: activeBoard, isPending } = useActiveBoard();

  // Depend on the two scalars, not the board object — the query hands back a new
  // object identity on every refetch, and each registration is a persisted write.
  const gymUuid = activeBoard?.gymUuid ?? null;
  const gymName = activeBoard?.gymName ?? null;

  useEffect(() => {
    // Leave whatever is registered alone until the stored board resolves.
    // PostHog super properties survive a relaunch, and `data` is `undefined`
    // while the AsyncStorage read is in flight — so treating that tick as "no
    // gym" would clear a real venue on EVERY cold start, and every event fired
    // before the read landed would lose its gym. Only a resolved query gets to
    // say there is no gym.
    //
    // That relaunch carry-over is what covers the startup window, and it holds
    // because the SDK runs both `register` and `capture` through `wrap()`, which
    // defers them behind the client's init promise — nothing touches the props
    // map until the persisted one has been read back off disk. So the first
    // `$screen` / `OTA Update Status` of a launch carries last launch's gym, and
    // this effect corrects it as soon as the board query settles.
    if (isPending) return;
    // A board can carry a gym id with no uuid/name resolved yet (or none at all,
    // for a home wall). Both are needed for a usable breakdown, so anything short
    // of the pair clears the property rather than stamping a half-identified gym.
    registerActiveGym(gymUuid && gymName ? { uuid: gymUuid, name: gymName } : null);
  }, [isPending, gymUuid, gymName]);

  return null;
}
