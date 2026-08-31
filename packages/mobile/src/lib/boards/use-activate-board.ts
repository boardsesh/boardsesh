// Binding a board to the app — the one path every surface that picks a board
// goes through.
//
// This used to live inside app/boards/index.tsx, which made it the only place
// that got the whole sequence right. app/boards/create.tsx had its own shorter
// version (write, then navigate), so a climber who arrived from onboarding and
// CREATED their first board silently skipped both the activation metric and the
// Climbs reveal banner — the two things that exist to mark exactly that moment.
// One hook, three callers, no second version to drift.

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useSetActiveBoard } from '../graphql/use-active-board';
import { useAdoptFoundBoard } from '../board-discovery/use-adopt-found-board';
import { useToast } from '../../providers/toast-provider';
import { hapticSelection } from '../haptics';
import { markOnboardingSeen, setBoardRevealTipPending } from '../onboarding/onboarding-storage';
import { reportError } from '../error-reporting';
import { track } from '../analytics';
import type { BoardReturnTo } from './board-return-to';

export type ActivateBoardOptions = {
  /**
   * Where the pick came from. `'onboarding'` is the activation flow: it fires
   * the activation metric, arms the one-time Climbs reveal banner, and closes
   * out first-run. Everything else is an ordinary board switch.
   */
  source?: 'onboarding';
  /** Which tab to dismiss back to once the board is bound. */
  returnTo: BoardReturnTo;
  /**
   * How to leave, when `router.dismissTo(returnTo)` is wrong. The boards modal
   * dismisses back onto the tab underneath it; the onboarding steps `replace`
   * instead, because there is nothing of theirs left to return to.
   */
  navigate?: () => void;
  /**
   * The board list came from the on-device snapshots rather than the network.
   * Adoption is a follow mutation plus a download confirm, so with no usable
   * connection the only thing it can produce is a "Could not follow X" toast for
   * a board the climber already has on their phone.
   *
   * Deliberately NOT `useIsOffline()`: the lying-connection case (captive
   * portal, dead upstream) renders the same rows with `isOffline === false` and
   * its requests fail just as hard.
   */
  isLocalOnly?: boolean;
  /**
   * Runs after the board is bound and before navigation, so a caller can offer
   * something that belongs to this moment — the onboarding step quotes the
   * offline download here. Awaited, because navigating out from under a dialog
   * would dismiss it. A throw here is reported and then ignored: the board IS
   * bound by this point, and refusing to navigate would strand the climber over
   * a failed extra.
   */
  onBound?: (board: UserBoard) => Promise<void>;
  /**
   * What a failed board write does.
   *
   * `'toast'` (the default) shows the switch-failed toast and resolves — right
   * for the picker, where the climber is still looking at a list they can tap
   * again.
   *
   * `'rethrow'` re-raises so a caller with its own error UI keeps it. The
   * builder needs this: it is a `presentation: 'modal'` route and the toast
   * overlay draws BEHIND it, so a toast there is invisible, and it has submit
   * state to unwind. Swallowing the failure would leave its CTA spinning
   * forever with nothing on screen to explain why.
   */
  writeFailure?: 'toast' | 'rethrow';
  /**
   * Whether the bind buzzes. Off for the builder, whose submit tap already did.
   */
  haptic?: boolean;
};

/**
 * Returns the bind action. It persists the board FIRST and only navigates once
 * that write succeeds — a failed write must not strand the climber on a board
 * that won't survive the next cold start.
 */
export function useActivateBoard({
  source,
  returnTo,
  navigate,
  isLocalOnly = false,
  onBound,
  writeFailure = 'toast',
  haptic = true,
}: ActivateBoardOptions) {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const setActiveBoard = useSetActiveBoard();
  const adoptFoundBoard = useAdoptFoundBoard();

  return useCallback(
    async (board: UserBoard) => {
      if (haptic) hapticSelection();
      try {
        // Persists to AsyncStorage + the ['activeBoard'] cache.
        await setActiveBoard(board);

        if (source === 'onboarding') {
          // The real activation metric — board history turns on the moment a
          // named board is bound — and the one-time Climbs reveal banner is
          // armed for the board they just followed.
          track(SHARED_EVENTS.OnboardingBoardActivated, { boardType: board.boardType, source: 'onboarding' });
          void setBoardRevealTipPending();
          // First-run is over the moment a board exists. OnboardingGate now
          // shows the flow whenever there is no active board, so this flag is
          // the record of completion rather than the gate itself — but leaving
          // it unwritten would make the gate re-mark it on every launch.
          // Fire-and-forget: a locked keychain must not block the bind, but it
          // must be reported, because swallowing it hides a re-showing tour.
          markOnboardingSeen().catch((error: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('[onboarding] Failed to persist "seen" flag', error);
            reportError(error);
          });
        }
      } catch (error: unknown) {
        if (writeFailure === 'rethrow') throw error;
        showToast(t('mobile.boardSwitchError'), 'error');
        return;
      }

      if (onBound) {
        try {
          await onBound(board);
        } catch (error: unknown) {
          reportError(error);
        }
      }

      // Dismiss the boards modal back onto the tab it was opened from — Climbs
      // by default (including the onboarding hand-off), Discover when the pill
      // there opened it (replaces with that tab if it isn't already underneath,
      // e.g. opened from a deep link).
      //
      // Reported, not rethrown, and deliberately not routed to `writeFailure`:
      // the board IS bound by now, so a navigation that fails (a stale route,
      // a dismissed stack) is not the write failure the caller's error UI is
      // written for, and raising it would undo submit state over a board that
      // really did land.
      try {
        if (navigate) navigate();
        else router.dismissTo(returnTo);
      } catch (error: unknown) {
        reportError(error);
      }

      // Follow the board if it's new to the climber (so it lands in My Boards)
      // and offer/auto-run its offline download. The isNew guard inside makes
      // re-selecting a board already in My Boards a no-op for follow.
      // Fire-and-forget: its own errors are handled inside and intentionally
      // don't reach the catch above, which only guards the bind.
      if (!isLocalOnly) void adoptFoundBoard(board);
    },
    [
      setActiveBoard,
      adoptFoundBoard,
      router,
      returnTo,
      navigate,
      showToast,
      t,
      source,
      isLocalOnly,
      onBound,
      writeFailure,
      haptic,
    ],
  );
}
