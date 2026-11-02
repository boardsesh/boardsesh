import { useEffect, useRef } from 'react';
import type { WallControlPreviewReason } from '@boardsesh/analytics';
import { trackWallControlShown } from '../../lib/analytics-wall-control';
import { isActionableWallControlState, type WallControlState } from './wall-control';

type UseWallControlShownOptions = {
  state: WallControlState;
  climbUuid: string | null;
  /** The player is open. Closing it starts a fresh count. */
  playerOpen: boolean;
  /** The control is drawn right now: nothing (a card, the busy-wall question) has taken its place. */
  visible: boolean;
  /** Why the climb on screen is a preview, or null. Rides along; it never decides when the event fires. */
  previewReason?: WallControlPreviewReason | null;
};

/**
 * Wall Control Shown (#7000), only for the states that ask the climber
 * to act: `connect` once per player open (the offer is the same on every
 * climb, so counting it per swipe would only count swipes), `put_on_wall` once
 * per climb per open. A re-render, a swipe back to a climb already counted, or
 * a state that flickers back never sends it twice; closing the player starts a
 * fresh count.
 */
export function useWallControlShown({
  state,
  climbUuid,
  playerOpen,
  visible,
  previewReason = null,
}: UseWallControlShownOptions): void {
  const sentRef = useRef(new Set<string>());
  // Read when the event fires, so a reason that settles a render later (the
  // crew latch arming) neither re-sends nor is missed.
  const previewReasonRef = useRef(previewReason);
  previewReasonRef.current = previewReason;
  useEffect(() => {
    if (!playerOpen) sentRef.current.clear();
  }, [playerOpen]);
  useEffect(() => {
    if (!playerOpen || !visible || climbUuid === null || !isActionableWallControlState(state)) return;
    const key = state === 'connect' ? state : `${climbUuid}|${state}`;
    if (sentRef.current.has(key)) return;
    sentRef.current.add(key);
    const reason = previewReasonRef.current;
    trackWallControlShown({ state, climbUuid, ...(reason ? { previewReason: reason } : {}) });
  }, [playerOpen, visible, climbUuid, state]);
}
