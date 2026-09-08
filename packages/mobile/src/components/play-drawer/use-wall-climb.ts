// What is physically lit on the board right now, in EVERY drawer state.
//
// Until this landed the drawer only knew the wall's climb in one situation — the
// accessory-bar preview, which arrives already knowing it is the lit one — so
// "On the wall" could never be said after a plain swipe landed back on it, and
// the busy-wall confirm had nothing to compare against. Both need the wall read
// continuously, which is what this is.
//
// It reads the NARROW board-presence selector, so the drawer re-renders when the
// lit climb changes and not on holder / stats / undo-target churn (the same
// reason `useWallClimbIfDistinct` uses it). And it reads it through `useContext`
// rather than `useBoardPresenceWallClimb()`, which throws with no provider in
// scope: the drawer can render outside that subtree, and a dark wall is the
// honest answer there — never a crash. Same call the sibling `useBoardDriver`
// makes, for the same reason.

import { useContext, useMemo } from 'react';
import { BoardPresenceWallClimbContext } from '@boardsesh/board-presence-react';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';

export type WallClimb = {
  /** The lit climb's uuid; `null` when the wall is dark, unbound, or unknown. */
  uuid: string | null;
  /** Its name — the busy-wall confirm says "Someone just lit {{name}}". */
  name: string | null;
  /**
   * When the server recorded the lighting (ISO 8601, server-stamped). The
   * busy-wall confirm reads it to tell "a peer just lit this" from "this was
   * already up before the drawer even had a feed" — a distinction the uuid alone
   * can't make, because a wall that is still connecting reads exactly like a dark
   * one. `null` when nothing is lit.
   */
  sentAt: string | null;
};

/** No board bound, no feed, or nothing lit. A stable reference so the memo below
 *  hands consumers the same object every render in the common (solo, unbound) case. */
const DARK_WALL: WallClimb = { uuid: null, name: null, sentAt: null };

export function useWallClimb(): WallClimb {
  const { enabled, boardId } = useBoardPresenceControls();
  // `undefined` means "outside the provider" here — degrade, don't throw.
  const wallClimb = useContext(BoardPresenceWallClimbContext) ?? null;

  return useMemo(() => {
    if (!enabled || boardId === null || !wallClimb) return DARK_WALL;
    return { uuid: wallClimb.climbUuid, name: wallClimb.name ?? null, sentAt: wallClimb.sentAt ?? null };
  }, [enabled, boardId, wallClimb]);
}
