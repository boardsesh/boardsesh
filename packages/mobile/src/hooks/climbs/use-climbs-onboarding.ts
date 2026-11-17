import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useIsFocused } from 'expo-router';
import type { UserBoard } from '@boardsesh/shared-schema';
import { ONBOARDING_TIP_QUICKACTIONS_KEY } from '@boardsesh/key-value-storage';
import { drivesWithoutBluetooth } from '../../lib/boards/board-lighting';
import { shouldShowQuickActionsTip } from '../../lib/onboarding/quick-actions-tip';
import { useFirstConnectCardExpected } from '../../components/onboarding/FirstConnectCard';
import {
  clearBoardRevealTipPending,
  hasBoardRevealTipPending,
  hasSeenTip,
  markTipSeen,
} from '../../lib/onboarding/onboarding-storage';
import { setListCardShowing } from '../../lib/onboarding/list-card-presence';
import { useFirstConnectConfirmationShowing } from '../../lib/onboarding/first-connect-confirmation-presence';

/** Own the list's one-at-a-time onboarding cues and their player visibility. */
export function useClimbsOnboarding(activeBoard: UserBoard | null | undefined, climbCount: number) {
  const isFocused = useIsFocused();
  const [revealTipVisible, setRevealTipVisible] = useState(false);
  // One-time board-history reveal banner: armed when the user binds a board from
  // the onboarding hand-off (app/boards/index.tsx) and consumed on focus so it
  // shows on the Climbs landing, pointing at the board's "now on the wall" sheet.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void hasBoardRevealTipPending().then((pending) => {
        if (cancelled || !pending) return;
        setRevealTipVisible(true);
        void clearBoardRevealTipPending();
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );
  const dismissRevealTip = useCallback(() => setRevealTipVisible(false), []);
  // The connect-step card (#5654, treatment only) goes first: one card at a
  // time, and both one-shot tips below wait until it is gone. Read from the
  // card's own store, so for everyone outside the treatment this is false.
  // The card offers a Bluetooth connect: not on a wall with no light kit, and not
  // on one lit by a wall device, where climbers take the wall instead.
  const connectCardBoardHasLights = activeBoard != null && !drivesWithoutBluetooth(activeBoard);
  const connectCardVisible = useFirstConnectCardExpected(connectCardBoardHasLights);
  // Connecting from that card hides it, and the "Connected to {{board}}" dialog
  // lands a moment later: the tips wait through that too, so neither shows
  // under the dialog (and the quick-actions tip is not used up there).
  const connectConfirmationShowing = useFirstConnectConfirmationShowing();
  const showRevealTip = revealTipVisible && !!activeBoard && !connectCardVisible && !connectConfirmationShowing;

  // One-shot tip teaching the quick-actions menu (long-press or the ⋯ button).
  // Armed on focus if unseen; held back until the board-reveal banner is gone so
  // the two never stack. Marked seen the moment it actually shows, so it fires once.
  const [quickActionsTipArmed, setQuickActionsTipArmed] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void hasSeenTip(ONBOARDING_TIP_QUICKACTIONS_KEY).then((seen) => {
        if (!cancelled && !seen) setQuickActionsTipArmed(true);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );
  const dismissQuickActionsTip = useCallback(() => setQuickActionsTipArmed(false), []);

  // Waits for a climb row to exist: the tip teaches a gesture on one (#5960).
  const showQuickActionsTip = shouldShowQuickActionsTip({
    armed: quickActionsTipArmed,
    revealTipShowing: showRevealTip,
    connectCardVisible,
    connectConfirmationShowing,
    climbCount: climbCount,
  });
  useEffect(() => {
    if (showQuickActionsTip) void markTipSeen(ONBOARDING_TIP_QUICKACTIONS_KEY);
  }, [showQuickActionsTip]);
  // The player's preview-first card waits while any of this list's cards is on
  // screen: on a tablet the player pane sits beside this list. A phone's player
  // covers the list, which loses focus, so nothing is published then.
  useEffect(() => {
    setListCardShowing('firstConnect', isFocused && connectCardVisible);
    setListCardShowing('boardReveal', isFocused && showRevealTip);
    setListCardShowing('quickActions', isFocused && showQuickActionsTip);
  }, [isFocused, connectCardVisible, showRevealTip, showQuickActionsTip]);
  useEffect(
    () => () => {
      setListCardShowing('firstConnect', false);
      setListCardShowing('boardReveal', false);
      setListCardShowing('quickActions', false);
    },
    [],
  );

  return {
    showRevealTip,
    showQuickActionsTip,
    connectCardBoardHasLights,
    dismissRevealTip,
    dismissQuickActionsTip,
  };
}
