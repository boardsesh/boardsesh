// Binding a board to the app — the one path every surface that picks a board
// goes through.
//
// This used to live inside app/boards/index.tsx, which made it the only place
// that got the whole sequence right. app/boards/create.tsx had its own shorter
// version (write, then navigate), so a climber who arrived from onboarding and
// CREATED their first board silently skipped both the activation metric and the
// Climbs reveal banner — the two things that exist to mark exactly that moment.
// The gym finder had a copy too, so its picks fired no pick event and never
// closed out first-run. One hook for every picker, no second version to drift.

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useSetActiveBoard } from '../graphql/use-active-board';
import { useAdoptFoundBoard, useWillFollowFoundBoard } from '../board-discovery/use-adopt-found-board';
import { useToast } from '../../providers/toast-provider';
import { hapticSelection } from '../haptics';
import { markOnboardingSeen, setBoardRevealTipPending } from '../onboarding/onboarding-storage';
import { useOnboardingLinkOffer } from '../onboarding/use-onboarding-link-offer';
import { reportError } from '../error-reporting';
import { track } from '../analytics';
import type { BoardReturnTo } from './board-return-to';
import { consumePendingBoardRecognition } from './pending-board-recognition';

/**
 * Which list the climber tapped the board in. Analytics only: it rides the
 * `Board Picker Selection Completed` event so a pick from Near you, a board
 * the picker's scan put at the top ('bluetooth'), a wall At {gym} that came
 * from the board you're on ('gym_walls') or the gym finder can be told apart
 * from a switch between boards they already have.
 */
export type BoardPickSource = 'your_boards' | 'nearby' | 'offline' | 'bluetooth' | 'gym_walls' | 'gym_finder';

/**
 * The picker section the board sat in, as drawn: At {gym}, the one board
 * heard somewhere else ('hero'), Your boards, Near you, the offline list, or
 * the gym map. Analytics only, beside `pickSource`, which names the list the
 * board came from rather than where it was drawn.
 */
export type BoardPickSection = 'at_gym' | 'hero' | 'your_boards' | 'near_you' | 'offline' | 'map';

/** What the caller knows about the tap, passed per bind. */
export type ActivateBoardPick = {
  pickSource?: BoardPickSource;
  section?: BoardPickSection;
  /** The board's 0-based place in its section, in the order drawn; null when it has none to give. */
  position?: number | null;
};

/** What `onBound` learns about the bind that just landed. */
export type BoundBoard = {
  /** The list the board was picked from, when the caller said. */
  pickSource: BoardPickSource | undefined;
  /**
   * This bind follows the board, so it lands in Your boards. False when it was
   * already theirs (built or followed), when the rows came from on-device data,
   * or when it is someone else's private board, which can't be followed.
   */
  followed: boolean;
  /** The section the board was drawn in, when the caller said. */
  section?: BoardPickSection;
  /** Its 0-based place in that section, when the caller said. */
  position?: number | null;
};

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
  onBound?: (board: UserBoard, bound: BoundBoard) => Promise<void>;
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
  /**
   * Whether this bind may name a box the In range slot is holding
   * (pending-board-recognition.ts). On for the routes the slot's three ways
   * forward lead to: the picker, the gym map and the builder. Off for Manage
   * boards: switching to a board there, even with the picker open underneath,
   * says nothing about the box the climber stood at.
   */
  recognizesHeldBox?: boolean;
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
  recognizesHeldBox = true,
}: ActivateBoardOptions) {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const setActiveBoard = useSetActiveBoard();
  // No "Download X?" on the onboarding bind: the onboarding step makes its own
  // offer in `onBound`, and a second dialog on Climbs would be the first thing a
  // newcomer sees after picking their board. The follow still happens.
  const adoptFoundBoard = useAdoptFoundBoard({ offerOffline: source !== 'onboarding' });
  const willFollowFoundBoard = useWillFollowFoundBoard();
  const shouldShowLink = useOnboardingLinkOffer(source === 'onboarding');

  return useCallback(
    async (board: UserBoard, pick?: ActivateBoardPick) => {
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

      // A box the picker's In range slot heard but could not name, which the
      // climber set off to find: a bound board of its type is that box, here or
      // on whichever route got them here. Never rejects.
      if (recognizesHeldBox) void consumePendingBoardRecognition(board);

      if (onBound) {
        try {
          await onBound(board, {
            pickSource: pick?.pickSource,
            section: pick?.section,
            position: pick?.position,
            // Asked before adoption runs (it waits for the navigation below), from
            // the same decision adoption uses, so the pick event can say whether
            // this board landed in Your boards. Both callbacks come from the
            // render that built this bind, so a viewer id that loads mid-bind
            // reaches the next pick, never just one half of this one.
            followed: !isLocalOnly && willFollowFoundBoard(board),
          });
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
        if (source === 'onboarding' && shouldShowLink(board.boardType)) {
          router.replace({ pathname: '/onboarding', params: { step: 'link', boardType: board.boardType } });
        } else if (navigate) navigate();
        else router.dismissTo(returnTo);
      } catch (error: unknown) {
        reportError(error);
      }

      // Follow the board unless it is already the climber's (built by them or
      // followed), so it lands in My Boards, and offer/auto-run its offline
      // download. Re-selecting a board already in My Boards is a no-op for follow.
      // Fire-and-forget: its own errors are handled inside and intentionally
      // don't reach the catch above, which only guards the bind.
      if (!isLocalOnly) void adoptFoundBoard(board);
    },
    [
      setActiveBoard,
      adoptFoundBoard,
      willFollowFoundBoard,
      router,
      returnTo,
      navigate,
      shouldShowLink,
      showToast,
      t,
      source,
      isLocalOnly,
      onBound,
      writeFailure,
      haptic,
      recognizesHeldBox,
    ],
  );
}
