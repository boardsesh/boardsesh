import { useCallback, useRef } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type {
  Climb as QueueClimb,
  ClimbQueueItem,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import { useIsSharedSession, useQueueActions } from '../../providers/queue-provider';
import { resolveTickMirror } from '../../lib/queue-mirror-orientation';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import type {
  BoardConfig,
  LogAscentInput,
  OpenClimbActionsOptions,
  OpenPlayDrawerOptions,
  ClimbActionsTarget,
} from '../../providers/drawer-host-provider';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import { readQueuePickLanding } from './queue-pick-landing';

type QueueSheetHandlerDeps = {
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  openPlayDrawer: (climb: Climb, options?: OpenPlayDrawerOptions) => void;
  getClimbActions: (
    climb: Climb,
    boardConfigOverride?: BoardConfig,
    options?: OpenClimbActionsOptions,
  ) => ClimbActionsTarget | null;
  openLogAscent: (input: LogAscentInput) => void;
  /** The user's STORED active board (never a drawer override) — the queue renders
   *  against it, and a tick-history log is filed against it. */
  storedBoardConfig: BoardConfig | null;
  sessionId: string | null;
  /** Dismiss the QueueSheet this set of handlers drives (the host's instance or
   *  the play-route's instance). */
  requestCloseQueueSheet: () => void;
  /** Await the exact QueueSheet instance this handler set drives. */
  dismissQueueSheetAndWait: () => Promise<DismissAndWaitResult>;
};

export type QueueHistoryTickHandler = (
  item: ClimbQueueItem,
  presentLogAscent?: (input: LogAscentInput) => void,
) => void;

type QueueSheetHandlers = {
  handleClimbPress: (item: ClimbQueueItem) => void;
  handleOpenActions: (item: ClimbQueueItem) => ClimbActionsTarget | null;
  handleSuggestionPress: (climb: QueueClimb, source: PlaylistSuggestionSource) => void;
  handleTickHistory: QueueHistoryTickHandler;
};

/**
 * The four QueueSheet row handlers, shared by the two QueueSheet instances: the
 * host's (snackbar / closed-player) and the play-route's (open-player, so the
 * sheet stacks above the player VC). Extracted so the two can't drift — both
 * present the same climb in the play drawer, resolve the same climb menu, and
 * file the same tick. The only difference is `requestCloseQueueSheet`, which
 * dismisses whichever instance the caller owns.
 */
export function useQueueSheetHandlers({
  setCurrentClimb,
  openPlayDrawer,
  getClimbActions,
  openLogAscent,
  storedBoardConfig,
  sessionId,
  requestCloseQueueSheet,
  dismissQueueSheetAndWait,
}: QueueSheetHandlerDeps): QueueSheetHandlers {
  const { getQueueSnapshot } = useQueueActions();
  const inSharedSession = useIsSharedSession();
  const inSharedSessionRef = useRef(inSharedSession);
  inSharedSessionRef.current = inSharedSession;
  // Where a pick lands, read at the tap (`resolveQueuePickLanding`): it
  // commits once automatic lighting is opted in or this phone is driving, and
  // previews otherwise. A pick of the climb already up never previews, since
  // that preview would offer no Put on board: it commits solo with no hold
  // (in either orientation), and reopens the climb up as it is in a crew or
  // while the hold keeps the wall dark.
  const landingOf = useCallback(
    (item: ClimbQueueItem) =>
      readQueuePickLanding(item, {
        current: getQueueSnapshot().currentClimbQueueItem,
        inSharedSession: inSharedSessionRef.current,
      }),
    [getQueueSnapshot],
  );
  // Selecting a queue slot previews it until automatic lighting is opted in
  // or this phone is driving. Keep the slot's identity for the later commit.
  const handleClimbPress = useCallback(
    (item: ClimbQueueItem) => {
      // Opening from the queue sheet means "walk the queue" — drop any list
      // source so next/previous follow the queue again, not a stale list.
      const landing = landingOf(item);
      if (landing === 'commit') {
        setCurrentClimb(item, { playlistSuggestionSource: null });
        openPlayDrawer(item.climb, { committedExternally: true });
      } else if (landing === 'reopen') {
        openPlayDrawer(item.climb, { reopensCurrent: true });
      } else {
        openPlayDrawer(item.climb, {
          previewQueueItem: item,
          previewCommitOptions: { playlistSuggestionSource: null },
        });
      }
      requestCloseQueueSheet();
    },
    [landingOf, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // A queue row's climb menu: the target a hold resolves, bound to that exact
  // slot, on the stored active board. QueueItemRow swaps in the board it draws
  // the row on, which is that same board except for a slot from another wall:
  // that slot's commands file against the climb's own board, as a mixed-board
  // playlist row's do.
  const handleOpenActions = useCallback(
    (item: ClimbQueueItem) => {
      // `queueItemUuid` names the exact row that was long-pressed, so "Play next"
      // moves that slot instead of the first copy of a twice-queued climb.
      return getClimbActions(item.climb, undefined, {
        dismissSourceSheet: dismissQueueSheetAndWait,
        queueItemUuid: item.uuid,
      });
    },
    [getClimbActions, dismissQueueSheetAndWait],
  );

  // Tap a suggestion → activate it with a suggestion source built from the
  // suggestions list (so the play drawer can keep swiping forward through them)
  // and show it.
  const handleSuggestionPress = useCallback(
    (climb: QueueClimb, source: PlaylistSuggestionSource) => {
      const item = climbToQueueItem(climb, { suggested: true });
      const schemaClimb = item.climb as Climb;
      // The suggestion's list is what the pick carries, on a commit of the
      // climb already up too. A reopen keeps the climb up as it is, track and all.
      const landing = landingOf(item);
      if (landing === 'commit') {
        setCurrentClimb(item, { playlistSuggestionSource: source });
        openPlayDrawer(schemaClimb, { committedExternally: true });
      } else if (landing === 'reopen') {
        openPlayDrawer(schemaClimb, { reopensCurrent: true });
      } else {
        openPlayDrawer(schemaClimb, { previewQueueItem: item, playlistSuggestionSource: source });
      }
      requestCloseQueueSheet();
    },
    [landingOf, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // Tick a history climb → open the log-ascent sheet (stacks above the queue
  // sheet, which stays open beneath) pre-filled with the active session.
  const handleTickHistory = useCallback(
    (item: ClimbQueueItem, presentLogAscent = openLogAscent) => {
      if (!storedBoardConfig) return;
      presentLogAscent({
        climb: item.climb,
        climbUuid: item.climb.uuid,
        climbName: item.climb.name,
        boardName: storedBoardConfig.boardName,
        angle: item.climb.angle,
        isMirror: resolveTickMirror(getQueueSnapshot(), item.climb, item.uuid),
        isBenchmark: !!item.climb.benchmark_difficulty,
        baseAscensionistCount: item.climb.ascensionist_count ?? 0,
        layoutId: storedBoardConfig.layoutId,
        sizeId: storedBoardConfig.sizeId,
        setIds: storedBoardConfig.setIds,
        sessionId,
        consensusGradeName: item.climb.difficulty,
      });
    },
    [storedBoardConfig, sessionId, openLogAscent, getQueueSnapshot],
  );

  return { handleClimbPress, handleOpenActions, handleSuggestionPress, handleTickHistory };
}
