// Wires the preview-first card (`lib/onboarding/preview-first-tip.ts`) to one
// player open: reads the seen flag, waits its turn behind the Climbs list's
// first-connect card and tips, and counts this open once it shows.

import { useEffect, useMemo, useState } from 'react';
import { useListCardShowing } from '../../lib/onboarding/list-card-presence';
import {
  claimPreviewFirstTipOpen,
  loadPreviewFirstTip,
  previewFirstAnnouncementDue,
  shouldShowPreviewFirstTip,
  usePreviewFirstTipState,
  type PreviewFirstTipState,
} from '../../lib/onboarding/preview-first-tip';

/** A never-shown card, for asking whether the card WOULD show once the flag is read. */
const UNSEEN: PreviewFirstTipState = { status: 'unseen', opens: 0, announcePending: false };

export type PreviewFirstTipInput = {
  /** A signed-in climber, not the web export's anonymous reader. */
  signedIn: boolean;
  /** The board on screen has lights this phone can put the climb on. */
  boardHasLights: boolean;
  /** The climb on screen is a preview, not the lit climb. */
  previewShowing: boolean;
  /** The busy-wall question, a card over the board, or Fell / Sent is up. */
  playerBusy: boolean;
};

export type PreviewFirstTip = {
  /** Draw the card as the first section under the board. */
  visible: boolean;
  /** The card's one screen-reader line belongs to this moment (`previewFirstAnnouncementDue`). */
  announcementDue: boolean;
  /**
   * The card could be about to show, but its seen flag is still being read.
   * The one-shot browse notice waits for the answer rather than speak over the
   * line that would replace it.
   */
  deciding: boolean;
};

export function usePreviewFirstTip({
  signedIn,
  boardHasLights,
  previewShowing,
  playerBusy,
}: PreviewFirstTipInput): PreviewFirstTip {
  const state = usePreviewFirstTipState();
  useEffect(() => {
    void loadPreviewFirstTip();
  }, []);
  const connectCardVisible = useListCardShowing('firstConnect');
  const revealTipShowing = useListCardShowing('boardReveal');
  const quickActionsTipShowing = useListCardShowing('quickActions');
  // One player open: the mount. `refused` means another player (the tablet's
  // pane and the full-screen player, mid-handoff) took the last open.
  const [openClaim, setOpenClaim] = useState<'idle' | 'claimed' | 'refused'>('idle');

  const gate = {
    signedIn,
    boardHasLights,
    previewShowing,
    connectCardVisible,
    listTipShowing: revealTipShowing || quickActionsTipShowing,
    playerBusy,
    screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
  };
  const visible =
    openClaim !== 'refused' && shouldShowPreviewFirstTip({ ...gate, state, claimedThisOpen: openClaim === 'claimed' });
  const deciding =
    state.status === 'unknown' && shouldShowPreviewFirstTip({ ...gate, state: UNSEEN, claimedThisOpen: false });

  useEffect(() => {
    if (!visible || openClaim !== 'idle') return;
    setOpenClaim(claimPreviewFirstTipOpen() ? 'claimed' : 'refused');
  }, [visible, openClaim]);

  const announcementDue = previewFirstAnnouncementDue(state, visible);
  return useMemo(() => ({ visible, announcementDue, deciding }), [visible, announcementDue, deciding]);
}
