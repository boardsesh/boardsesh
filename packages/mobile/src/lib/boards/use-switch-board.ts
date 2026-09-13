// Hopping to another wall at the same gym.
//
// Deliberately NOT a new `source` on `useActivateBoard`. That hook is the
// *picker's* funnel: its whole shape is "persist, then leave" — it dismisses a
// modal back to a tab, arms the onboarding reveal, and takes a `returnTo`. A
// sibling hop must not navigate at all: the board sheet stays open, because
// after the switch the sheet is showing the other wall's "now on the wall",
// which is the answer the climber tapped for. Bolting this onto the picker's
// hook would make `returnTo` meaningless and `navigate` a no-op.
//
// This is the smaller primitive of the two. `useActivateBoard` could eventually
// be rewritten in terms of it; that is not this change.

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useSetActiveBoard } from '../graphql/use-active-board';
import { useAdoptFoundBoard } from '../board-discovery/use-adopt-found-board';
import { resolveBoardAngle } from './board-angle-store';
import { hapticSelection } from '../haptics';
import { reportError } from '../error-reporting';
import { track } from '../analytics';
import { useToast } from '../../providers/toast-provider';

/** Why the board changed — carried into analytics so a spike is attributable. */
export type BoardSwitchSource = 'presence_sheet_sibling' | 'move_to_wall_callout';

export type SwitchBoardOutcome = 'switched' | 'noop' | 'failed';

export type SwitchBoardOptions = {
  source: BoardSwitchSource;
  /**
   * The board list came from on-device data rather than the network, so skip
   * adoption (a follow mutation plus a download confirm). Same reasoning as
   * `useActivateBoard`'s flag: with no usable connection the only thing adoption
   * can produce is a "Could not follow X" toast.
   */
  isLocalOnly?: boolean;
  /**
   * Runs after the board is bound. The drawer host clears its board-config
   * override here — a deliberate switch outranks a pinned foreign climb, and
   * leaving the override live would keep every drawer surface rendering the
   * board the climber just left.
   */
  onSwitched?: (board: UserBoard) => void;
  /**
   * Tell the party which wall we moved to. Injected rather than reached for:
   * the session mutation lives on the queue context, and a hook in `lib/` that
   * imports the queue provider both inverts the layering and drags a 2000-line
   * module into every test of this file.
   *
   * Not optional-by-accident — a solo climber passes nothing, and a caller
   * inside a session that forgets it leaves the room advertising the old wall.
   */
  broadcastBoardPath?: (board: UserBoard) => void;
  /** Whether a BLE link is live, for analytics only. The teardown is automatic. */
  hasBleLink?: boolean;
  /** Queue length at switch time, for analytics only. */
  queueSize?: number;
  /** Whether the climber is in a party session, for analytics only. */
  inSession?: boolean;
};

/**
 * Returns `switchBoard(target)`.
 *
 * Nothing is invalidated on the way out, on purpose: every board-scoped query
 * key already carries the board, so the climb list, grades, logbook and
 * favourites all re-render on their new keys for free. Dropping
 * `['infiniteSearchClimbs']` here would be a prefix nuke that discards every
 * *other* board's warmed pages — turning a one-tap hop between two walls in one
 * room into a full reload each way, which is the exact cost this feature exists
 * to remove.
 *
 * The BLE link needs no handling here either: the connection identity includes
 * the board uuid, so the existing config-switch teardown fires on any real board
 * change, including two walls configured identically.
 */
export function useSwitchBoard({
  source,
  isLocalOnly = false,
  onSwitched,
  broadcastBoardPath,
  hasBleLink = false,
  queueSize = 0,
  inSession = false,
}: SwitchBoardOptions) {
  const setActiveBoard = useSetActiveBoard();
  const adoptFoundBoard = useAdoptFoundBoard();
  const { showToast } = useToast();
  const { t } = useTranslation('session');
  // Single-flight. The active-board write queue already resolves two racing
  // taps to the last one, but everything *after* the await — adoption, the
  // party broadcast, the board-art prewarm the climbs screen runs on a board
  // change — would otherwise run twice, once for a board the climber never
  // landed on.
  const switchInFlightRef = useRef(false);

  return useCallback(
    async (target: UserBoard, currentBoard: UserBoard | null): Promise<SwitchBoardOutcome> => {
      // A "switch" to the board you are already on must not report success: the
      // prompt that sent you here would clear as though something happened, and
      // nothing did.
      if (currentBoard && target.uuid === currentBoard.uuid) return 'noop';
      if (switchInFlightRef.current) return 'noop';
      switchInFlightRef.current = true;

      try {
        hapticSelection();

        // The angle belongs to the wall being adopted, never to the one being
        // left. Carrying the current angle across is how a climber ends up
        // "on" a fixed-angle spray wall at 40°.
        const angle = await resolveBoardAngle(target);

        try {
          await setActiveBoard({ ...target, angle });
        } catch (error: unknown) {
          reportError(error);
          track(SHARED_EVENTS.BoardSwapFailed, {
            source,
            toBoardUuid: target.uuid,
            reason: 'write_failed',
          });
          // Success says nothing: the surface the climber tapped from visibly
          // becomes the other board. A failure has nothing to show, so it says so
          // — otherwise the tap reads as ignored and they tap again.
          showToast(t('mobile.boardPresence.gymWalls.switchFailed', { board: target.name }), 'error');
          return 'failed';
        }

        onSwitched?.(target);

        track(SHARED_EVENTS.BoardSwapCompleted, {
          source,
          toBoardUuid: target.uuid,
          sameGym: currentBoard?.gymUuid != null && currentBoard.gymUuid === target.gymUuid,
          sameConfig:
            currentBoard != null &&
            currentBoard.boardType === target.boardType &&
            currentBoard.layoutId === target.layoutId &&
            currentBoard.sizeId === target.sizeId &&
            currentBoard.setIds === target.setIds,
          queueSize,
          hadBleLink: hasBleLink,
          inSession,
        });

        // Peers keep whatever wall the session was created on unless we say
        // otherwise, so a silent switch leaves the crew lighting the wall the
        // climber just walked away from.
        broadcastBoardPath?.({ ...target, angle });

        if (!isLocalOnly) void adoptFoundBoard({ ...target, angle });

        return 'switched';
      } finally {
        switchInFlightRef.current = false;
      }
    },
    [
      setActiveBoard,
      adoptFoundBoard,
      showToast,
      t,
      onSwitched,
      broadcastBoardPath,
      source,
      isLocalOnly,
      hasBleLink,
      queueSize,
      inSession,
    ],
  );
}
