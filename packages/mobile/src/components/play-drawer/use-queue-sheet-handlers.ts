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
} from '../../providers/drawer-host-provider';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import { readClimbChangeLights } from './use-climb-change-lights';
import { isCommittedHeadClimb } from './wall-state';

type QueueSheetHandlerDeps = {
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  openPlayDrawer: (climb: Climb, options?: OpenPlayDrawerOptions) => void;
  openClimbActions: (climb: Climb, boardConfigOverride?: BoardConfig, options?: OpenClimbActionsOptions) => void;
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
  handleOpenActions: (item: ClimbQueueItem) => void;
  handleSuggestionPress: (climb: QueueClimb, source: PlaylistSuggestionSource) => void;
  handleTickHistory: QueueHistoryTickHandler;
};

/**
 * The four QueueSheet row handlers, shared by the two QueueSheet instances: the
 * host's (snackbar / closed-player) and the play-route's (open-player, so the
 * sheet stacks above the player VC). Extracted so the two can't drift — both
 * present the same climb in the play drawer, open the same reaction menu, and
 * file the same tick. The only difference is `requestCloseQueueSheet`, which
 * dismisses whichever instance the caller owns.
 */
export function useQueueSheetHandlers({
  setCurrentClimb,
  openPlayDrawer,
  openClimbActions,
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
  // Whether a pick of `climb` commits now: automatic lighting is opted in or
  // this phone is driving, or the climb is the one already up. A preview of a
  // slot holding the current climb shows no Put on board (`isCommittedHeadClimb`),
  // so the pick it carries could never land; committing it leaves the wall's
  // climb where it is.
  const pickCommitsNow = useCallback(
    (climbUuid: string) =>
      readClimbChangeLights('tap', { inSharedSession: inSharedSessionRef.current }) ||
      isCommittedHeadClimb(climbUuid, getQueueSnapshot().currentClimbQueueItem?.climb.uuid ?? null),
    [getQueueSnapshot],
  );
  // Selecting a queue slot previews it until automatic lighting is opted in
  // or this phone is driving. Keep the slot's identity for the later commit.
  const handleClimbPress = useCallback(
    (item: ClimbQueueItem) => {
      // Opening from the queue sheet means "walk the queue" — drop any list
      // source so next/previous follow the queue again, not a stale list.
      if (pickCommitsNow(item.climb.uuid)) {
        setCurrentClimb(item, { playlistSuggestionSource: null });
        openPlayDrawer(item.climb, { committedExternally: true });
      } else {
        openPlayDrawer(item.climb, {
          previewQueueItem: item,
          previewCommitOptions: { playlistSuggestionSource: null },
        });
      }
      requestCloseQueueSheet();
    },
    [pickCommitsNow, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
  );

  // Long-press a queue row → open the climb reaction menu over the queue sheet.
  // The queue renders against the active board, so the default boardConfig is
  // correct.
  const handleOpenActions = useCallback(
    (item: ClimbQueueItem) => {
      // `queueItemUuid` names the exact row that was long-pressed, so "Play next"
      // moves that slot instead of the first copy of a twice-queued climb.
      openClimbActions(item.climb, undefined, {
        dismissSourceSheet: dismissQueueSheetAndWait,
        queueItemUuid: item.uuid,
      });
    },
    [openClimbActions, dismissQueueSheetAndWait],
  );

  // Tap a suggestion → activate it with a suggestion source built from the
  // suggestions list (so the play drawer can keep swiping forward through them)
  // and show it.
  const handleSuggestionPress = useCallback(
    (climb: QueueClimb, source: PlaylistSuggestionSource) => {
      const item = climbToQueueItem(climb, { suggested: true });
      const schemaClimb = item.climb as Climb;
      // The suggestion's list is what the pick carries, so a suggestion of the
      // climb already up commits too: its preview would have no Put on board.
      if (pickCommitsNow(item.climb.uuid)) {
        setCurrentClimb(item, { playlistSuggestionSource: source });
        openPlayDrawer(schemaClimb, { committedExternally: true });
      } else {
        openPlayDrawer(schemaClimb, { previewQueueItem: item, playlistSuggestionSource: source });
      }
      requestCloseQueueSheet();
    },
    [pickCommitsNow, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet],
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
