import { useMemo, useSyncExternalStore } from 'react';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import { useQueueData } from '../../providers/queue-provider';
import {
  lastPickClimb,
  lastPickOpenOptions,
  resolveBarPick,
  useLastPick,
  type LastPick,
} from '../../lib/last-pick-store';
import type { OpenPlayDrawerOptions } from '../../providers/drawer-host-provider';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';

/** What the MiniPlayer shows (owner decision A). */
export type BarClimb = {
  /** The queue item the bar stands for: the last pick's, or the queue's current. */
  item: ClimbQueueItem | null;
  /** Its climb as the bar draws it (a pick's mirror flip applied). */
  climb: Climb | null;
  /** The last pick on the bar, or null while it shows the queue's current climb. */
  pick: LastPick | null;
};

const NO_CLIMB: BarClimb = { item: null, climb: null, pick: null };

/**
 * The climb on the MiniPlayer (the iOS bottom accessory, the JS queue bar, the
 * tablet and Duo bar): the climb the climber most recently opened, a preview
 * included, or the queue's current climb when THAT changed after it, whichever
 * happened last (`resolveBarPick`). No extra marking: the bulb says whether
 * it is lit.
 *
 * The Lock Screen / Live Activity, the Climbs header's wall capsule and the
 * board history sheet never read this: they show the wall.
 *
 * PERF: one object per change of pick or of the queue's current, so a
 * memoised bar re-renders only when the climb it shows changes.
 */
export function useBarClimb(): BarClimb {
  const { currentClimbQueueItem } = useQueueData();
  const stored = useLastPick();
  const generation = useSyncExternalStore(
    subscribeToCredentialChanges,
    getCredentialGeneration,
    getCredentialGeneration,
  );
  // The drawn copy follows the pick alone: a mirrored pick's `{ ...climb }`
  // is not rebuilt when the queue's current item changes identity under it.
  const pickClimb = useMemo(() => (stored ? lastPickClimb(stored) : null), [stored]);
  const pick = resolveBarPick(stored, currentClimbQueueItem?.uuid ?? null, generation);
  // While the pick shows, the queue's current is not read, so the bar's object
  // keeps its identity through a queue change that leaves the pick standing.
  const shownCurrent = pick ? null : currentClimbQueueItem;
  return useMemo(() => {
    if (pick && pickClimb) return { item: pick.item, climb: pickClimb, pick };
    if (!shownCurrent) return NO_CLIMB;
    return { item: shownCurrent, climb: shownCurrent.climb, pick: null };
  }, [pick, pickClimb, shownCurrent]);
}

/** How the player reopens what the bar shows. */
export function barOpenOptions(pick: LastPick | null): OpenPlayDrawerOptions {
  // A pick reopens as the same preview, not the committed head. The current
  // climb already IS current, so openDrawer won't re-append it. A reopen, not
  // a pick: a #4979 hold stays, and the player offers Put on the wall.
  return pick ? lastPickOpenOptions(pick) : { reopensCurrent: true };
}
