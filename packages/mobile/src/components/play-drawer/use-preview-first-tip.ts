// Wires the preview-first card (`lib/onboarding/preview-first-tip.ts`) to one
// player open: reads the seen flag, waits its turn behind the Climbs list's
// first-connect card and tips and the first-connect confirmation, and counts
// this open once it shows.

import { useEffect, useMemo, useState } from 'react';
import { useFirstConnectConfirmationShowing } from '../../lib/onboarding/first-connect-confirmation-presence';
import { useListCardShowing } from '../../lib/onboarding/list-card-presence';
import {
  claimPreviewFirstTipOpen,
  loadPreviewFirstTip,
  previewFirstAnnouncementDue,
  shouldShowPreviewFirstTip,
  usePreviewFirstTipState,
  type PreviewFirstTipState,
} from '../../lib/onboarding/preview-first-tip';
import type { WallControlModel } from './wall-control';

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
  /** The card's slot under the board is on the first screen. */
  slotInView: boolean;
  /**
   * Which open this is. The sheet mounts per open, so its mount is the open.
   * The iPad pane stays mounted, so there each climb opened into it (the open
   * target's nonce) is a new open and counts toward the card's limit.
   */
  openKey: number | null;
};

/** What the player knows, for `resolvePreviewFirstTipInput`. */
export type PreviewFirstTipPlayerState = {
  signedIn: boolean;
  /** `playerHasWall`: a Bluetooth board here, not a board with no lights, not a spray wall. */
  playerHasWall: boolean;
  /** The board control's one model. */
  wallControl: Pick<WallControlModel, 'state' | 'holder' | 'labelKey'>;
  /** The climb on screen is a preview. */
  isPreview: boolean;
  /** The climb on screen is lit on the wall. */
  displayedLit: boolean;
  /** The busy-wall question is in the wall button's place. */
  busyWallUp: boolean;
  /** Fell / Sent is up. */
  workoutOutcomeUp: boolean;
  /** The switch-board gate is over the board. */
  boardMismatchUp: boolean;
  /** The end-of-list card is over the board. */
  trackEndCardUp: boolean;
  /** At least one section is shown under the board. */
  hasVisibleSections: boolean;
  /** The open fold's tabletop pose: the sections start in view, under the controls. */
  tabletop: boolean;
  /** The board fills the screen's height (`shouldFitBoardToHeight`), so the sections start below the fold. */
  fitsBoardToHeight: boolean;
  openKey: number | null;
};

/**
 * The player's side of the card's rules (spec B5): never on Set active, a spray
 * wall or a board with no lights, never for a crew relay (a crewmate's phone
 * lights that board, so this one has no frost to explain and no window to
 * open), and never stacked with the busy-wall question, a card over the board
 * or Fell / Sent.
 */
export function resolvePreviewFirstTipInput(player: PreviewFirstTipPlayerState): PreviewFirstTipInput {
  const { state, holder, labelKey } = player.wallControl;
  return {
    signedIn: player.signedIn,
    boardHasLights:
      player.playerHasWall &&
      state !== null &&
      state !== 'take_wall' &&
      state !== 'release_wall' &&
      labelKey !== 'setActive' &&
      holder !== 'crew',
    previewShowing: player.isPreview && !player.displayedLit,
    playerBusy: player.busyWallUp || player.workoutOutcomeUp || player.boardMismatchUp || player.trackEndCardUp,
    // Without sections the first screen fills the viewport and does not scroll,
    // and a board fitted to the height leaves no peek: either way the card would
    // sit below the fold. The tabletop's sections start in view.
    slotInView: player.tabletop || (player.hasVisibleSections && !player.fitsBoardToHeight),
    openKey: player.openKey,
  };
}

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

type OpenClaim = { openKey: number | null; status: 'claimed' | 'refused' };

export function usePreviewFirstTip({
  signedIn,
  boardHasLights,
  previewShowing,
  playerBusy,
  slotInView,
  openKey,
}: PreviewFirstTipInput): PreviewFirstTip {
  const state = usePreviewFirstTipState();
  useEffect(() => {
    void loadPreviewFirstTip();
  }, []);
  const connectCardVisible = useListCardShowing('firstConnect');
  const revealTipShowing = useListCardShowing('boardReveal');
  const quickActionsTipShowing = useListCardShowing('quickActions');
  const connectConfirmationShowing = useFirstConnectConfirmationShowing();
  // This open's claim. `refused` means another player (the tablet's pane and
  // the full-screen player, mid-handoff) took the last open. A new open key is
  // a new open, with nothing claimed yet.
  const [claim, setClaim] = useState<OpenClaim | null>(null);
  const openClaim = claim !== null && claim.openKey === openKey ? claim.status : 'idle';

  const gate = {
    signedIn,
    boardHasLights,
    previewShowing,
    connectCardVisible,
    connectConfirmationShowing,
    listTipShowing: revealTipShowing || quickActionsTipShowing,
    playerBusy,
    slotInView,
    screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
  };
  const visible =
    openClaim !== 'refused' && shouldShowPreviewFirstTip({ ...gate, state, claimedThisOpen: openClaim === 'claimed' });
  const deciding =
    state.status === 'unknown' && shouldShowPreviewFirstTip({ ...gate, state: UNSEEN, claimedThisOpen: false });

  useEffect(() => {
    if (!visible || openClaim !== 'idle') return;
    setClaim({ openKey, status: claimPreviewFirstTipOpen() ? 'claimed' : 'refused' });
  }, [visible, openClaim, openKey]);

  const announcementDue = previewFirstAnnouncementDue(state, visible);
  return useMemo(() => ({ visible, announcementDue, deciding }), [visible, announcementDue, deciding]);
}
